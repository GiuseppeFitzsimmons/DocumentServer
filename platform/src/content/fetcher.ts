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

interface BinaryCacheEntry {
  body: Buffer;
  contentType: string;
  fetchedAt: number;
}

const binaryCache = new Map<string, BinaryCacheEntry>();

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

// Binary files we're willing to serve from the static repo, with their MIME
// types. Keeping an allow-list (rather than inferring from arbitrary
// extensions) means a stray/renamed file in the repo can't be served as an
// unexpected content type.
const BINARY_TYPES: Record<string, string> = {
  pdf: 'application/pdf',
};

export interface BinaryContent {
  body: Buffer;
  contentType: string;
}

/**
 * Fetch a binary content file (e.g. "publishing-guide.pdf") from the
 * static-content repo. Same TTL + stale-fallback behaviour as fetchContent,
 * but returns the raw bytes and the MIME type. Only extensions in BINARY_TYPES
 * are permitted.
 */
export async function fetchBinaryContent(file: string): Promise<BinaryContent> {
  // Allow letters, digits, spaces, dots, underscores and hyphens in the base
  // name (repo filenames like "Self-Publishing with EuroBureau.pdf"), but never
  // path separators or ".." — so the name can't traverse outside the repo root.
  if (file.includes('/') || file.includes('\\') || file.includes('..')) {
    throw new ContentNotFoundError(`Invalid binary file path: ${file}`);
  }
  const m = /^([A-Za-z0-9 _-]+)\.([A-Za-z0-9]+)$/.exec(file);
  const ext = m?.[2]?.toLowerCase();
  if (!m || !ext || !(ext in BINARY_TYPES)) {
    throw new ContentNotFoundError(`Invalid or unsupported binary file: ${file}`);
  }
  const contentType = BINARY_TYPES[ext];

  const cached = binaryCache.get(file);
  const now = Date.now();
  if (cached && now - cached.fetchedAt < TTL_MS) {
    return { body: cached.body, contentType: cached.contentType };
  }

  // Encode the filename for the URL (spaces -> %20, etc.) while leaving the
  // base URL untouched.
  const url = `${base()}/${encodeURIComponent(file)}`;
  try {
    const res = await fetch(url);
    if (res.status === 404) {
      throw new ContentNotFoundError(`Content not found: ${file}`);
    }
    if (!res.ok) {
      throw new ContentFetchError(`Failed to fetch ${file}: ${res.status}`);
    }
    const body = Buffer.from(await res.arrayBuffer());
    binaryCache.set(file, { body, contentType, fetchedAt: now });
    return { body, contentType };
  } catch (err) {
    if (err instanceof ContentNotFoundError) throw err;
    if (cached) {
      console.warn(`[content] binary fetch for ${file} failed; serving stale cache:`, (err as Error).message);
      return { body: cached.body, contentType: cached.contentType };
    }
    throw new ContentFetchError(`Failed to fetch ${file}: ${(err as Error).message}`);
  }
}

/** Clear the content cache (e.g. after an admin-triggered update). */
export function invalidateContentCache(): void {
  cache.clear();
  binaryCache.clear();
}
