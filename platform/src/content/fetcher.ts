import { config } from '../config.js';

// Runtime fetcher for static content (T&C, FAQ) hosted in the EuroBureau-Static
// repo. Content is fetched from the repo's raw URL at request time so editing a
// file there and pushing updates the live page without a redeployment. A short
// in-memory TTL cache keeps us from hitting GitHub on every request while still
// picking up changes within a few minutes.

const TTL_MS = 5 * 60 * 1000; // 5 minutes

interface CacheEntry {
  body: string;
  fetchedAt: number;
}

const cache = new Map<string, CacheEntry>();

function base(): string {
  return config.STATIC_CONTENT_BASE_URL.replace(/\/+$/, '');
}

export class ContentNotFoundError extends Error {}
export class ContentFetchError extends Error {}

/**
 * Fetch a content file (e.g. "terms.md") from the static-content repo.
 * Returns the raw text. Served from cache when fresh; on a stale cache the
 * network is tried and, if it fails, the stale copy is returned as a fallback
 * so a transient GitHub hiccup never takes the page down.
 */
export async function fetchContent(file: string): Promise<string> {
  // Guard against path traversal / unexpected names — only allow simple
  // filenames with a markdown extension.
  if (!/^[A-Za-z0-9_-]+\.md$/.test(file)) {
    throw new ContentNotFoundError(`Invalid content file: ${file}`);
  }

  const cached = cache.get(file);
  const now = Date.now();
  if (cached && now - cached.fetchedAt < TTL_MS) {
    return cached.body;
  }

  const url = `${base()}/${file}`;
  try {
    const res = await fetch(url);
    if (res.status === 404) {
      throw new ContentNotFoundError(`Content not found: ${file}`);
    }
    if (!res.ok) {
      throw new ContentFetchError(`Failed to fetch ${file}: ${res.status}`);
    }
    const body = await res.text();
    cache.set(file, { body, fetchedAt: now });
    return body;
  } catch (err) {
    if (err instanceof ContentNotFoundError) throw err;
    // Network/transient error: fall back to a stale cached copy if we have one.
    if (cached) {
      console.warn(`[content] fetch for ${file} failed; serving stale cache:`, (err as Error).message);
      return cached.body;
    }
    throw new ContentFetchError(`Failed to fetch ${file}: ${(err as Error).message}`);
  }
}

/** Clear the content cache (e.g. after an admin-triggered update). */
export function invalidateContentCache(): void {
  cache.clear();
}
