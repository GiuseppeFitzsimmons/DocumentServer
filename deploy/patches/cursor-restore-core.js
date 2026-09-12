/*
 * Euro-Office cursor (page) restore — pure core module.
 *
 * Dependency-free, ESM-importable extraction of the pure functions the
 * Restore_IIFE (deploy/patches/cursor-restore-iife.js) relies on. Keeping the
 * logic here lets the production IIFE mirror it while tests exercise it in
 * isolation (Node + a Map-backed localStorage stub) without the DocumentServer
 * runtime.
 *
 * The functions here perform NO editor or live-`localStorage` access: `save`
 * and `load` are parameterized over a storage object so they can be driven by
 * a stub in tests and by the real `localStorage` in the IIFE.
 *
 * Design: .kiro/specs/editor-cursor-restore/design.md
 * Requirements: 1.2, 1.3, 3.1, 3.2, 3.4, 3.5, 4.2, 5.1, 5.2, 5.3, 6.4
 */

/** Prefix for every store key: `eo:cursor:{fileKey}:{userId}`. */
export const STORE_PREFIX = "eo:cursor:";

/** Fixed debounce interval for coalescing selection events (>= 500 ms). */
export const DEBOUNCE_MS = 750;

/**
 * Derive a stable per-document key from the DocumentServer document key.
 *
 * The DS document key is `${fileId}_${updatedAtTimestamp}`; stripping the
 * trailing `_{timestamp}` segment yields a key stable across saves (which bump
 * the timestamp). Mirrors the epub export patch's `split("_")` / `pop()` /
 * `join("_")` logic.
 *
 * Returns `null` for empty/unavailable input.
 *
 * Requirements: 3.2
 *
 * @param {string} docKey
 * @returns {string | null}
 */
export function deriveFileKey(docKey) {
	if (docKey === null || docKey === undefined) return null;
	const str = String(docKey);
	if (str === "") return null;
	const parts = str.split("_");
	parts.pop(); // drop the trailing `_{timestamp}` segment
	return parts.join("_");
}

/**
 * Build the store key for a given fileKey/userId pair.
 *
 * Returns `eo:cursor:${fileKey}:${userId}`, or `null` when `fileKey` is `null`
 * (in which case the feature no-ops for the session).
 *
 * Requirements: 3.1
 *
 * @param {string | null} fileKey
 * @param {string} userId
 * @returns {string | null}
 */
export function storeKey(fileKey, userId) {
	if (fileKey === null || fileKey === undefined) return null;
	return STORE_PREFIX + fileKey + ":" + userId;
}

/**
 * Persist a page index to the given storage under `key`.
 *
 * Writes the integer as a JSON number string and overwrites any prior value
 * for the same key. Swallows all errors so a failing storage never blocks the
 * editor.
 *
 * Requirements: 1.2, 1.3, 3.4, 6.4
 *
 * @param {{ getItem: Function, setItem: Function, removeItem: Function }} storage
 * @param {string | null} key
 * @param {number} page
 * @returns {void}
 */
export function save(storage, key, page) {
	if (!storage || !key) return;
	try {
		storage.setItem(key, JSON.stringify(page));
	} catch (e) {
		// swallow: storage unavailable / quota exceeded (Requirement 5.4)
	}
}

/**
 * Read a page index from the given storage under `key`.
 *
 * Returns an integer only when the stored value is exactly the JSON encoding of
 * a single non-negative integer. For any other content (absent, empty,
 * non-numeric, fractional, negative, object/array, malformed JSON) it removes
 * any corrupt entry and returns `null`.
 *
 * Requirements: 1.2, 5.1, 5.2, 6.4
 *
 * @param {{ getItem: Function, setItem: Function, removeItem: Function }} storage
 * @param {string | null} key
 * @returns {number | null}
 */
export function load(storage, key) {
	if (!storage || !key) return null;
	let raw;
	try {
		raw = storage.getItem(key);
	} catch (e) {
		return null;
	}
	if (raw === null || raw === undefined || raw === "") return null;

	let parsed;
	try {
		parsed = JSON.parse(raw);
	} catch (e) {
		discard(storage, key);
		return null;
	}

	if (!isNonNegativeInteger(parsed)) {
		discard(storage, key);
		return null;
	}
	return parsed;
}

/**
 * Page-range predicate: true iff `0 <= pageIndex < pageCount`.
 *
 * Requirements: 4.2, 5.3
 *
 * @param {number} pageIndex
 * @param {number} pageCount
 * @returns {boolean}
 */
export function isPageInRange(pageIndex, pageCount) {
	return (
		isNonNegativeInteger(pageIndex) &&
		typeof pageCount === "number" &&
		pageIndex < pageCount
	);
}

// --- internal helpers ------------------------------------------------------

function isNonNegativeInteger(n) {
	return typeof n === "number" && Number.isInteger(n) && n >= 0;
}

function discard(storage, key) {
	try {
		storage.removeItem(key);
	} catch (e) {
		// swallow (Requirement 5.4)
	}
}
