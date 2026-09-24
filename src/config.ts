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

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`STORYBOOK_URL is not a valid URL: ${raw}`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error(`STORYBOOK_URL must be http(s): ${raw}`);
  }
  // Accept a link to the Storybook UI (".../index.html", "?path=...") and keep only the root.
  url.search = "";
  url.hash = "";
  url.pathname = url.pathname.replace(/\/index\.html$/, "").replace(/\/+$/, "");

  return { storybookUrl: url.toString().replace(/\/+$/, ""), headers: parseAuthHeader(env.STORYBOOK_AUTH_HEADER) };
}

/**
 * STORYBOOK_AUTH_HEADER is optional. Forms:
 *   "Name: value"                  one header
 *   "Name: value\nOther: value"    several headers, one per line (literal "\n" also accepted)
 *   "Bearer abc" / "Basic abc"     no colon-separated name: sent as the Authorization header
 */
export function parseAuthHeader(raw: string | undefined): Record<string, string> {
  const headers: Record<string, string> = {};
  if (!raw?.trim()) return headers;

  for (const line of raw.split(/\r?\n|\\n/)) {
    const entry = line.trim();
    if (!entry) continue;
    const match = /^([A-Za-z0-9!#$%&'*+.^_`|~-]+):\s*(.+)$/.exec(entry);
    if (match) headers[match[1]] = match[2].trim();
    else headers.Authorization = entry;
  }
  return headers;
}
