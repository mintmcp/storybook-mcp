// Deployment config, read once at startup.

export interface Config {
  /** Published Storybook root, no trailing slash. Manifests are read from `<storybookUrl>/manifests/*.json`. */
  storybookUrl: string;
  /** Extra headers sent on every manifest fetch (for a Storybook behind auth). */
  headers: Record<string, string>;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const raw = env.STORYBOOK_URL?.trim();
  if (!raw) throw new Error("STORYBOOK_URL is required (the URL of your published Storybook).");

  // Errors below never echo the raw value: it may carry credentials.
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("STORYBOOK_URL is not a valid URL.");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error(`STORYBOOK_URL must be http(s), got ${url.protocol}`);
  }
  if (url.username || url.password) {
    throw new Error(
      "STORYBOOK_URL must not contain a username or password. Remove them from the URL and set STORYBOOK_AUTH_HEADER to `Basic <base64 of user:password>` instead.",
    );
  }
  // Accept a link to the Storybook UI ("index.html?path=...", "iframe.html?id=...") and keep only the root.
  url.search = "";
  url.hash = "";
  url.pathname = url.pathname.replace(/\/(index|iframe)\.html$/, "").replace(/\/+$/, "");

  return { storybookUrl: url.toString().replace(/\/+$/, ""), headers: parseAuthHeader(env.STORYBOOK_AUTH_HEADER) };
}

const HEADER_LINE = /^([A-Za-z0-9!#$%&'*+.^_`|~-]+):\s*(.+)$/;
const AUTH_SCHEME_LINE = /^\S+ \S+$/;

/**
 * STORYBOOK_AUTH_HEADER is optional. Forms:
 *   "Name: value"                  one header
 *   "Name: value\nOther: value"    several headers, one per line (literal "\n" also accepted)
 *   "Bearer abc" / "Basic abc"     scheme and credentials, no header name: sent as the Authorization header
 * Any other line is rejected at startup, naming the line number but not its value.
 */
export function parseAuthHeader(raw: string | undefined): Record<string, string> {
  const headers: Record<string, string> = {};
  if (!raw?.trim()) return headers;

  const lines = raw.split(/\r?\n|\\n/);
  lines.forEach((line, index) => {
    const entry = line.trim();
    if (!entry) return;
    const match = HEADER_LINE.exec(entry);
    if (match) headers[match[1]] = match[2].trim();
    else if (AUTH_SCHEME_LINE.test(entry)) headers.Authorization = entry;
    else {
      throw new Error(
        `STORYBOOK_AUTH_HEADER line ${index + 1} is not "Name: value" or "<scheme> <credentials>" (e.g. "Authorization: Bearer <token>").`,
      );
    }
  });
  return headers;
}
