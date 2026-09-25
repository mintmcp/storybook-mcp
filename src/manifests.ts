// Fetches Storybook manifests from the published Storybook, with a short cache.

import type { Config } from "./config.js";

const CACHE_TTL_MS = 60_000;
/** How long a failure (or a stale copy served during an outage) is reused before fetching again. */
const RETRY_AFTER_MS = 30_000;
const FETCH_TIMEOUT_MS = 15_000;
const MAX_REDIRECTS = 5;
const COMPONENTS_MANIFEST = "manifests/components.json";

/** Keys stripped from manifests: absolute paths from the machine that built the Storybook. */
const SCRUBBED_KEYS = new Set(["definedInFile"]);

export class ManifestError extends Error {
  /** True for outages (network error, timeout, 5xx), where a cached copy may still be served. */
  readonly transient: boolean;
  constructor(message: string, transient = false) {
    super(message);
    this.transient = transient;
  }
}

interface CacheEntry {
  body?: string;
  error?: ManifestError;
  expiresAt: number;
  /** Fetch in progress, shared by concurrent callers. */
  pending?: Promise<string>;
}

export function createManifestProvider(config: Config, fetchImpl: typeof fetch = fetch) {
  const cache = new Map<string, CacheEntry>();
  const origin = new URL(config.storybookUrl).origin;
  const hasAuthHeader = Object.keys(config.headers).length > 0;

  function load(rawPath: string): Promise<string> {
    const path = rawPath.replace(/^\.?\/+/, "");
    const url = `${config.storybookUrl}/${path}`;
    const entry = cache.get(url);
    if (entry && Date.now() < entry.expiresAt) {
      return entry.body !== undefined ? Promise.resolve(entry.body) : Promise.reject(entry.error);
    }
    if (entry?.pending) return entry.pending;

    const pending = refresh(url, path, entry?.body);
    cache.set(url, { ...entry, expiresAt: entry?.expiresAt ?? 0, pending });
    return pending;
  }

  async function refresh(url: string, path: string, staleBody: string | undefined): Promise<string> {
    try {
      const body = await fetchManifest(url, path);
      cache.set(url, { body, expiresAt: Date.now() + CACHE_TTL_MS });
      return body;
    } catch (err) {
      const error =
        err instanceof ManifestError
          ? err
          : new ManifestError(`Could not reach ${url}: ${err instanceof Error ? err.message : String(err)}`, true);
      // During an outage keep serving the last good copy, without waiting on the host for every call.
      if (staleBody !== undefined && error.transient) {
        cache.set(url, { body: staleBody, expiresAt: Date.now() + RETRY_AFTER_MS });
        return staleBody;
      }
      cache.set(url, { error, expiresAt: Date.now() + RETRY_AFTER_MS });
      throw error;
    }
  }

  async function fetchManifest(url: string, path: string): Promise<string> {
    const res = await fetchSameOrigin(url);
    if (!res.ok) throw new ManifestError(describeStatus(res.status, url, path, hasAuthHeader), res.status >= 500);

    const text = await res.text();
    try {
      return JSON.stringify(scrub(JSON.parse(text)));
    } catch {
      // An HTML login page or SPA fallback instead of JSON usually means auth or a wrong URL.
      throw new ManifestError(
        `${url} did not return JSON. Check that STORYBOOK_URL points at the Storybook root and, if the Storybook is private, that STORYBOOK_AUTH_HEADER is set.`,
      );
    }
  }

  // Follows redirects only within the Storybook's origin, so STORYBOOK_AUTH_HEADER never leaves it.
  async function fetchSameOrigin(url: string): Promise<Response> {
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

function describeStatus(status: number, url: string, path: string, hasAuthHeader: boolean): string {
  if (status === 401 || status === 403) {
    // Some hosts (S3, CloudFront) also answer 403 for a file that doesn't exist.
    const auth = hasAuthHeader
      ? "check that STORYBOOK_AUTH_HEADER is still valid"
      : "if the Storybook is private, set STORYBOOK_AUTH_HEADER on the connector's Environment variables tab";
    return `${url} returned ${status}. Access was denied or the file doesn't exist: ${auth}, and check that STORYBOOK_URL points at the Storybook root.`;
  }
  if (status === 404) {
    return path === COMPONENTS_MANIFEST
      ? `${url} returned 404. The Storybook has no components manifest: it needs Storybook 10.x with features.componentsManifest enabled, rebuilt and republished.`
      : `${url} returned 404. The manifest refers to this file but it isn't published: republish the complete Storybook build.`;
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
