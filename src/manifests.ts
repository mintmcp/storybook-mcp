// Fetches Storybook manifests from the published Storybook, with a short cache.

import type { Config } from "./config.js";

const CACHE_TTL_MS = 60_000;
const FETCH_TIMEOUT_MS = 15_000;

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
      res = await fetchImpl(url, {
        headers: { accept: "application/json", ...config.headers },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        redirect: "follow",
      });
    } catch (err) {
      // Serve the last good copy if the Storybook host is briefly unreachable.
      if (cached) return cached.body;
      throw new ManifestError(`Could not reach ${url}: ${err instanceof Error ? err.message : String(err)}`);
    }

    if (!res.ok) {
      if (cached && res.status >= 500) return cached.body;
      throw new ManifestError(describeStatus(res.status, url));
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

  return (_request: Request | undefined, path: string) => load(path);
}

function describeStatus(status: number, url: string): string {
  if (status === 401 || status === 403) {
    return `${url} returned ${status}. The Storybook is private: set STORYBOOK_AUTH_HEADER on the connector's Environment variables tab.`;
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
