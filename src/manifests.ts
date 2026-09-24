// Fetches Storybook manifests from the published Storybook, with a short cache.

import type { Config } from "./config.js";

const CACHE_TTL_MS = 60_000;
const FETCH_TIMEOUT_MS = 15_000;
const MAX_REDIRECTS = 5;

/** Keys stripped from manifests: absolute paths from the machine that built the Storybook. */
const SCRUBBED_KEYS = new Set(["definedInFile"]);

export class ManifestError extends Error {}

interface CacheEntry {
  body: string;
  fetchedAt: number;
}

export function createManifestProvider(config: Config, fetchImpl: typeof fetch = fetch) {
  const cache = new Map<string, CacheEntry>();

  async function load(path: string): Promise<string> {
    const url = `${config.storybookUrl}/${path.replace(/^\.?\/+/, "")}`;
    const cached = cache.get(url);
    if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) return cached.body;

    let res: Response;
    try {
      res = await fetchSameOrigin(url);
    } catch (err) {
      if (err instanceof ManifestError) throw err;
      // Serve the last good copy if the Storybook host is briefly unreachable.
      if (cached) return cached.body;
      throw new ManifestError(`Could not reach ${url}: ${err instanceof Error ? err.message : String(err)}`);
    }

    if (!res.ok) {
      if (cached && res.status >= 500) return cached.body;
      throw new ManifestError(describeStatus(res.status, url, Object.keys(config.headers).length > 0));
    }

    const text = await res.text();
    let body: string;
    try {
      body = JSON.stringify(scrub(JSON.parse(text)));
    } catch {
      // An HTML login page or SPA fallback instead of JSON usually means auth or a wrong URL.
      throw new ManifestError(
        `${url} did not return JSON. Check that STORYBOOK_URL points at the Storybook root and, if the Storybook is private, that STORYBOOK_AUTH_HEADER is set.`,
      );
    }
    cache.set(url, { body, fetchedAt: Date.now() });
    return body;
  }

  // Follows redirects only within the Storybook's origin, so STORYBOOK_AUTH_HEADER never leaves it.
  async function fetchSameOrigin(url: string): Promise<Response> {
    const origin = new URL(config.storybookUrl).origin;
    let current = url;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      const res = await fetchImpl(current, {
        headers: { accept: "application/json", ...config.headers },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        redirect: "manual",
      });
      const location = res.status >= 300 && res.status < 400 ? res.headers.get("location") : null;
      if (!location) return res;
      const next = new URL(location, current);
      if (next.origin !== origin) {
        throw new ManifestError(
          `${url} redirects to ${next.origin}, outside STORYBOOK_URL. Set STORYBOOK_URL to the address the Storybook is actually served from.`,
        );
      }
      current = next.toString();
    }
    throw new ManifestError(`${url} redirected more than ${MAX_REDIRECTS} times.`);
  }

  return (_request: Request | undefined, path: string) => load(path);
}

function describeStatus(status: number, url: string, hasAuthHeader: boolean): string {
  if (status === 401 || status === 403) {
    // Some hosts (S3, CloudFront) also answer 403 for a file that doesn't exist.
    const auth = hasAuthHeader
      ? "check that STORYBOOK_AUTH_HEADER is still valid"
      : "if the Storybook is private, set STORYBOOK_AUTH_HEADER on the connector's Environment variables tab";
    return `${url} returned ${status}. Access was denied or the file doesn't exist: ${auth}, and check that STORYBOOK_URL points at the Storybook root.`;
  }
  if (status === 404) {
    return `${url} returned 404. The Storybook has no components manifest: it needs Storybook 10.x with features.componentsManifest enabled, rebuilt and republished.`;
  }
  return `${url} returned HTTP ${status}.`;
}

function scrub(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(scrub);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value)) {
      if (!SCRUBBED_KEYS.has(key)) out[key] = scrub(v);
    }
    return out;
  }
  return value;
}
