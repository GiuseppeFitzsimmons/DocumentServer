/*
 * Euro-Office cursor (page) restore — appended to documenteditor-app.js.
 *
 * Runs inside the editor's own cross-origin iframe JS context, using only the
 * public, unmangled editor API (getCurrentPage / goToPage / getCountPages /
 * asc_registerCallback / Common.NotificationCenter) and the iframe-origin
 * localStorage. It captures the current PAGE index on selection change and
 * scrolls back to it when the document is reopened.
 *
 * Page-level restore only: no character-exact cursor placement, no dependency
 * on minified private editor fields (e.g. WordControl / GetContentPosition /
 * SetContentPosition), and no document mutation.
 *
 * Per-user, per-file key:  eo:cursor:{fileKey}:{userId}
 *
 * Degrades gracefully: any error is swallowed so the editor is never blocked.
 *
 * Design: .kiro/specs/editor-cursor-restore/design.md
 */
(function () {
	"use strict";

	var DEBOUNCE_MS = 750;
	var STORE_PREFIX = "eo:cursor:";

	// --- Editor accessors ---------------------------------------------------

	function getApi() {
		// Accessing window.Asc / window.editor can theoretically throw in some
		// sandboxed cross-origin contexts; swallow and return null so no editor
		// access ever propagates an error (Requirements 5.4, 6.1).
		try {
			return (window.Asc && Asc.editor) || window.editor || null;
		} catch (e) {
			return null;
		}
	}

	// --- Document key / userId accessors -----------------------------------
	//
	// The platform injects the editor config in platform/src/views/editor.ejs:
	//   var config = <JSON.stringify(editorConfig)>;
	//   var docEditor = new DocsAPI.DocEditor('editor-container', config);
	// where editorConfig (platform/src/ds/editorConfig.ts) sets:
	//   document.key      = `${file.id}_${file.updatedAt.getTime()}`
	//   editorConfig.user.id = <current user id>
	//
	// That `config` object lives on the OUTER page. This IIFE runs inside the
	// editor's cross-origin iframe, so it cannot read the outer `config`
	// directly. Inside the frame the DocumentServer SDK stores the same values
	// on the editor instance (`Asc.editor`) via its public, unmangled SDK
	// getters. The bundle is minified, so the safest strategy (per the design's
	// "Obtaining the document key and userId" section) is to read through the
	// public getters with layered fallbacks and CAPTURE the values once at
	// bootstrap — after which we no longer depend on any live accessor being
	// available at capture/restore time.
	//
	// Captured-at-bootstrap cache (see captureConfigSnapshot / bootstrap).
	var capturedDocKey = null;
	var capturedUserId = null;

	// Matches the injected DocumentServer document key shape produced by the
	// platform (platform/src/ds/editorConfig.ts):
	//   document.key = `${file.id}_${file.updatedAt.getTime()}`
	// i.e. some id segment followed by `_` and a >= 10-digit epoch-ms timestamp.
	// We match on this VALUE pattern rather than a property name because the DS
	// bundle is minified and the property holding the key has a mangled,
	// build-unstable name (e.g. "GY"/"qeb" in one build). Keying off the value
	// shape keeps us independent of minified private field NAMES (Req 7.4).
	var DOC_KEY_RE = /^.+_\d{10,}$/;

	// Scan the editor instance's own string properties for a value matching the
	// document-key shape. Returns the matching value or null. Only enumerable
	// OWN properties are inspected (the key is stored directly on the instance),
	// and every property read is guarded so a throwing getter can't break the
	// scan. This touches no named private field — it discovers the key purely by
	// its value shape (Req 7.4).
	function scanForDocKey(api) {
		try {
			var names = Object.getOwnPropertyNames(api);
			for (var i = 0; i < names.length; i++) {
				var v;
				try {
					v = api[names[i]];
				} catch (e) {
					continue;
				}
				if (typeof v === "string" && DOC_KEY_RE.test(v)) {
					return v;
				}
			}
		} catch (e) {}
		return null;
	}

	// Read the raw DocumentServer document key from the in-frame editor config.
	// Tries public SDK getters first, then a value-shape scan of the editor
	// instance (robust against minification), then documented fallbacks. Returns
	// null when nothing is available (feature then no-ops for the session).
	function readDocKey() {
		try {
			var api = getApi();
			if (!api) return null;
			// Preferred: public SDK getter on the document info object, when the
			// build exposes it (unmangled method name).
			if (api.DocInfo && typeof api.DocInfo.get_Id === "function") {
				var id = api.DocInfo.get_Id();
				if (id) return String(id);
			}
			// Documented direct fields the SDK sometimes sets from the config.
			if (api.documentId) return String(api.documentId);
			if (api.DocInfo && api.DocInfo.Id) return String(api.DocInfo.Id);
			// Fallback for builds (e.g. DS 9.3.1) where DocInfo is absent: locate
			// the key by its `{id}_{timestamp}` value shape on the instance.
			var scanned = scanForDocKey(api);
			if (scanned) return scanned;
			return null;
		} catch (e) {
			return null;
		}
	}

	// Read the current user id from the in-frame editor config. Falls back to
	// the literal "anon" when unavailable (Requirement 3.3).
	function readUserId() {
		try {
			var api = getApi();
			if (api && api.DocInfo) {
				// Preferred public getter.
				if (typeof api.DocInfo.get_UserId === "function") {
					var uid = api.DocInfo.get_UserId();
					if (uid) return String(uid);
				}
				// Alternate: user info object exposing get_Id().
				if (typeof api.DocInfo.get_UserInfo === "function") {
					var u = api.DocInfo.get_UserInfo();
					if (u && typeof u.get_Id === "function") {
						var id = u.get_Id();
						if (id) return String(id);
					}
				}
			}
		} catch (e) {}
		return "anon";
	}

	// Capture the doc key + userId once (called at bootstrap once the editor is
	// ready). Subsequent getDocKey()/getUserId() calls prefer the snapshot so we
	// don't depend on a live accessor being available at capture/restore time.
	function captureConfigSnapshot() {
		if (capturedDocKey === null) {
			var k = readDocKey();
			if (k) capturedDocKey = k;
		}
		if (capturedUserId === null) {
			var u = readUserId();
			if (u) capturedUserId = u;
		}
	}

	// Public in-frame accessor for the document key (raw, pre-derivation).
	// Prefers the bootstrap snapshot, falling back to a live read.
	function getDocKey() {
		return capturedDocKey || readDocKey();
	}

	// Public in-frame accessor for the user id, always resolving to a usable
	// string ("anon" fallback per Requirement 3.3).
	function getUserId() {
		return capturedUserId || readUserId() || "anon";
	}

	// Derive a stable per-document key by stripping the trailing `_{timestamp}`
	// segment from the DS document key. Mirrors cursor-restore-core.js
	// deriveFileKey (and the epub export patch's split("_")/pop()/join("_")).
	// Returns null when no document key is available.
	function deriveFileKey(docKey) {
		if (docKey === null || docKey === undefined) return null;
		var str = String(docKey);
		if (str === "") return null;
		var parts = str.split("_");
		parts.pop(); // drop the trailing `_{timestamp}` segment
		return parts.join("_");
	}

	function getFileKey() {
		return deriveFileKey(getDocKey());
	}

	// Build the store key `eo:cursor:{fileKey}:{userId}`; returns null when the
	// fileKey is unavailable so the feature degrades to a no-op for the session
	// (no error) — consistent with Requirement 5.
	function storeKey() {
		var fk = getFileKey();
		if (fk === null) return null;
		return STORE_PREFIX + fk + ":" + getUserId();
	}

	// --- Page capture / restore --------------------------------------------
	//
	// capturePage() reads the current page via the public getCurrentPage()
	// method and coerces it to an integer, returning null on error or when the
	// value is not an integer. It touches only the public, unmangled API — no
	// dependency on minified private editor fields (Requirement 7.1, 7.4).
	function capturePage() {
		try {
			var api = getApi();
			if (!api || typeof api.getCurrentPage !== "function") return null;
			var page = api.getCurrentPage();
			if (typeof page !== "number" || !isFinite(page)) return null;
			var intPage = Math.trunc(page);
			if (intPage !== page) return null;
			return intPage;
		} catch (e) {
			return null;
		}
	}

	// restorePage(pageIndex) validates the requested page against the live page
	// count and scrolls to it using only the public, unmangled methods
	// getCountPages() and goToPage() (Requirement 7.2). It calls
	// goToPage(pageIndex) ONLY when isPageInRange(pageIndex, getCountPages())
	// holds; for any invalid input (non-integer, out of range, missing API, or
	// thrown error) it is a no-op and returns false, leaving the editor at its
	// default position. All editor access is wrapped in try/catch so a failure
	// never blocks the editor (Requirements 4.1, 4.2, 5.1, 5.2, 5.3, 5.4, 7.2).
	function restorePage(pageIndex) {
		try {
			var api = getApi();
			if (
				!api ||
				typeof api.getCountPages !== "function" ||
				typeof api.goToPage !== "function"
			) {
				return false;
			}
			var pageCount = api.getCountPages();
			if (!isPageInRange(pageIndex, pageCount)) {
				return false;
			}
			api.goToPage(pageIndex);
			return true;
		} catch (e) {
			// swallow: restore must never block the editor (Requirement 5.4)
			return false;
		}
	}

	// --- localStorage helpers ----------------------------------------------
	//
	// These mirror cursor-restore-core.js (save / load / isPageInRange) but
	// operate against the live iframe-origin `window.localStorage` under the
	// current storeKey(). The core module is the source of truth for the logic;
	// behavior here is kept identical. Requirements: 1.2, 3.1, 3.4, 3.5, 5.1,
	// 5.2, 6.4.

	// Return the live iframe-origin localStorage, or null when unavailable
	// (accessing it can throw in some sandboxed contexts).
	function getStorage() {
		try {
			return window.localStorage || null;
		} catch (e) {
			return null;
		}
	}

	function isNonNegativeInteger(n) {
		return typeof n === "number" && isFinite(n) && Math.floor(n) === n && n >= 0;
	}

	// Remove a corrupt entry; swallow any error (Requirement 5.4).
	function discard(storage, key) {
		try {
			storage.removeItem(key);
		} catch (e) {}
	}

	// Persist an integer page index under the current storeKey(). Writes the
	// integer as a JSON number string and overwrites any prior value. Swallows
	// all errors so a failing storage never blocks the editor (Requirement 5.4).
	// Mirrors cursor-restore-core.js `save`.
	function save(page) {
		var storage = getStorage();
		var key = storeKey();
		if (!storage || !key) return;
		try {
			storage.setItem(key, JSON.stringify(page));
		} catch (e) {
			// swallow: storage unavailable / quota exceeded (Requirement 5.4)
		}
	}

	// Read the page index stored under the current storeKey(). Returns an
	// integer only when the stored value is exactly the JSON encoding of a
	// single non-negative integer. For any other content (absent, empty,
	// non-numeric, fractional, negative, object/array, malformed JSON) it
	// removes any corrupt entry and returns null. Mirrors cursor-restore-core.js
	// `load`. Requirements: 1.2, 5.1, 5.2, 6.4.
	function load() {
		var storage = getStorage();
		var key = storeKey();
		if (!storage || !key) return null;

		var raw;
		try {
			raw = storage.getItem(key);
		} catch (e) {
			return null;
		}
		if (raw === null || raw === undefined || raw === "") return null;

		var parsed;
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

	// Page-range predicate: true iff `0 <= pageIndex < pageCount`. Mirrors
	// cursor-restore-core.js `isPageInRange`. Requirements: 4.2, 5.3.
	function isPageInRange(pageIndex, pageCount) {
		return (
			isNonNegativeInteger(pageIndex) &&
			typeof pageCount === "number" &&
			pageIndex < pageCount
		);
	}

	// --- Wiring -------------------------------------------------------------

	// Single active debounce timer handle coalescing page-change events so only
	// the page read after the interval elapses following the most recent event
	// is persisted (Requirement 2.1).
	var debounceTimer = null;

	// Debounced page-change handler. Each page-change event (asc_onCurrentPage /
	// asc_onCursorMove) clears and resets a single DEBOUNCE_MS timer; only when
	// the timer fires (i.e. no further event arrived within the interval) do we
	// read the current page and persist it. Requirements: 1.1, 1.3, 2.1, 2.2,
	// 7.1.
	//
	// NOTE: This subscribes to asc_onCurrentPage (and asc_onCursorMove) rather
	// than asc_onSelectionChanged. Live testing against DS 9.3.1 showed
	// asc_onSelectionChanged does NOT fire on cursor/page movement in this
	// build, whereas asc_onCurrentPage fires on every page change (carrying the
	// page index) and asc_onCursorMove fires on cursor movement. Both funnel
	// into the same debounced capture, so registering both is safe and
	// redundant-tolerant.
	//
	// Capture gate: page-change events fire during initial document load as the
	// editor settles at page 0. If we persisted those, they would overwrite the
	// saved page BEFORE we get a chance to restore it (observed: the store held
	// "0" after a reload). So capture is disabled until the one-time restore has
	// run; only genuine user navigation after load is persisted. Requirement 1.1
	// (capture on page change) is satisfied for real post-load movement; the
	// load-time settle is intentionally excluded.
	var captureEnabled = false;

	function onPageChanged() {
		try {
			if (!captureEnabled) return; // ignore load-time settle events
			if (debounceTimer !== null) {
				clearTimeout(debounceTimer);
			}
			debounceTimer = setTimeout(function () {
				debounceTimer = null;
				var page = capturePage();
				if (page !== null) {
					save(page);
				}
			}, DEBOUNCE_MS);
		} catch (e) {
			// swallow: capture must never block the editor (Requirement 5.4)
		}
	}

	// Boolean guard ensuring the Restore_Attempt runs AT MOST ONCE per document
	// load (Requirement 4.4). Set to true before the attempt so it can never run
	// twice, even if init() is reached more than once (e.g. a late polling tick
	// racing a readiness signal).
	var restoreDone = false;

	// attemptRestore() loads the saved page for the current store key and, when a
	// valid integer was found, hands it to restorePage(). A null load (absent,
	// unparseable, or corrupt value) is a no-op leaving the editor at its default
	// position (Requirement 5.1, 5.2). Returns true only when a page was
	// successfully restored. Wrapped in try/catch so a failure never blocks the
	// editor (Requirement 5.4).
	function attemptRestore() {
		try {
			var savedPage = load();
			if (savedPage !== null) {
				restorePage(savedPage);
			}
			return savedPage !== null;
		} catch (e) {
			// swallow: restore must never block the editor (Requirement 5.4)
			return false;
		} finally {
			// Enable capture only AFTER restore has been applied, so the
			// load-time page events cannot overwrite the saved page before we
			// restore it. A short delay lets any final load-time events flush
			// before we start persisting genuine navigation.
			enableCaptureSoonInner();
		}
	}
	function enableCaptureSoonInner() {
		setTimeout(function () {
			captureEnabled = true;
		}, DEBOUNCE_MS);
	}

	// init() registers the debounced page-change callbacks and wires the
	// one-time Restore_Attempt (Requirements 1.1, 4.1, 4.4, 7.3). Guarded by
	// initDone so repeated readiness signals (NotificationCenter + polling)
	// cannot register the callbacks more than once.
	var initDone = false;
	var initTries = 0;
	function init() {
		// The entire init body is wrapped so nothing — the readiness check, the
		// retry timer, the config snapshot, callback registration, or the
		// restore attempt — can ever propagate an error out to the editor
		// (Requirements 5.4, 6.1). The inner try/catch blocks below remain so a
		// failure in one step still lets the following steps run.
		try {
			if (initDone) return;
			var api = getApi();
			if (!api || !api.asc_registerCallback) {
				// Editor not ready yet; retry shortly, bounded so a doc that
				// never loads cannot spin an unbounded timer (~50 * 200ms = 10s).
				if (initTries++ < 50) {
					setTimeout(init, 200);
				}
				return;
			}
			initDone = true;

			// Snapshot the doc key + userId now that the editor is ready, so
			// capture/restore no longer depend on a live accessor.
			captureConfigSnapshot();

			// Register the debounced page-capture handler on page-change events,
			// using only the public asc_registerCallback subscription (Req 1.1,
			// 7.3). We subscribe to both asc_onCurrentPage (fires on page
			// navigation, carrying the page index) and asc_onCursorMove (fires
			// on cursor movement) because live DS 9.3.1 testing showed
			// asc_onSelectionChanged does not fire on movement in this build.
			// The handler stays GATED (captureEnabled=false) until restore runs,
			// so load-time settle events are ignored. Each subscription is
			// independently guarded so one failing does not prevent the other
			// (Req 5.4).
			try {
				api.asc_registerCallback("asc_onCurrentPage", onPageChanged);
			} catch (e) {
				// swallow: subscription failure must not block the editor (Req 5.4)
			}
			try {
				api.asc_registerCallback("asc_onCursorMove", onPageChanged);
			} catch (e) {
				// swallow: subscription failure must not block the editor (Req 5.4)
			}

			// Trigger the one-time Restore_Attempt. Because the readiness signal
			// varies across DS builds (the Common.NotificationCenter
			// 'document:ready' notification did not reach our handler in DS
			// 9.3.1, yet goToPage works once the document is laid out), we drive
			// restore from whichever of several signals arrives first, all
			// funneling through runRestoreOnce() which is guarded by restoreDone
			// so it executes AT MOST ONCE per load (Requirement 4.4):
			//   1. onDocumentContentReady editor callback (registerable here), and
			//   2. a bounded fallback timer, in case no readiness event reaches us.
			try {
				api.asc_registerCallback("onDocumentContentReady", runRestoreOnce);
			} catch (e) {
				// swallow: subscription failure must not block the editor (Req 5.4)
			}
			// Fallback: if a readiness callback never fires, attempt restore
			// after a short delay once pages are known to exist. runRestoreOnce
			// re-checks getCountPages() and reschedules briefly if not ready.
			setTimeout(runRestoreOnce, 400);
		} catch (e) {
			// swallow: init must never block the editor (Requirement 5.4)
		}
	}

	// runRestoreOnce() performs the single Restore_Attempt, guarded by
	// restoreDone so it executes at most once regardless of how many readiness
	// signals fire (Requirement 4.4).
	//
	// The document paginates progressively AFTER the content-ready signals:
	// getCountPages() sits at 1 for a while, then jumps to its final value
	// (e.g. 47) a few seconds later. A one-shot restore during the early plateau
	// rejects the saved page as out of range (observed: "OUT OF RANGE page=5
	// count=1"). So instead of a single attempt, we POLL the page count over a
	// bounded window and apply the restore as soon as the saved page becomes
	// reachable (savedPage < count), or give up once the layout has clearly
	// finished growing (count plateaued > 1) or the window elapses. This is
	// resilient to the count both lagging and jumping. Bounded so it can never
	// spin forever (Requirements 4.3, 4.4).
	var restoreTries = 0;
	var lastCount = -1;
	var plateauCount = 0;
	var restorePolling = false;
	var RESTORE_MAX_TRIES = 70; // ~70 * 150ms ≈ 10.5s upper bound

	// Entry point that both readiness signals call; ensures only ONE poll chain
	// runs so the tracking isn't corrupted by interleaved chains.
	function runRestoreOnce() {
		if (restoreDone || restorePolling) {
			return;
		}
		// Read the saved page ONCE up front so we know the target we're waiting
		// for. If there is nothing saved, finish immediately (enables capture).
		var savedPage = null;
		try {
			savedPage = load();
		} catch (e) {
			savedPage = null;
		}
		if (savedPage === null) {
			restoreDone = true;
			enableCaptureSoon();
			return;
		}
		restorePolling = true;
		pollRestore(savedPage);
	}

	function pollRestore(savedPage) {
		try {
			if (restoreDone) return;
			var api = getApi();
			var count = 0;
			try {
				count = api && typeof api.getCountPages === "function" ? api.getCountPages() : 0;
			} catch (e) {
				count = 0;
			}

			// Track how long the count has held steady at a value > 1 — that
			// indicates pagination has finished (the final, larger count).
			if (count > 1 && count === lastCount) {
				plateauCount++;
			} else {
				plateauCount = 0;
			}
			lastCount = count;

			// Apply as soon as the saved page is reachable (its page now exists).
			if (isPageInRange(savedPage, count)) {
				restoreDone = true;
				attemptRestore();
				return;
			}

			// Give up if the layout has clearly finished growing (count settled
			// at a value > 1 for several polls) — the saved page is genuinely out
			// of range (e.g. the document shrank). No-op restore per Req 5.3.
			var finishedGrowing = plateauCount >= 4;
			var timedOut = restoreTries >= RESTORE_MAX_TRIES;
			if (finishedGrowing || timedOut) {
				restoreDone = true;
				// Still call attemptRestore so its in-range check / capture-enable
				// path runs consistently (it will no-op if out of range).
				attemptRestore();
				return;
			}

			restoreTries++;
			setTimeout(function () { pollRestore(savedPage); }, 150);
		} catch (e) {
			// swallow: restore must never block the editor (Requirement 5.4)
		}
	}

	// Enable capture after a short delay (shared helper so both the "nothing
	// saved" and normal restore paths flip the gate consistently).
	function enableCaptureSoon() {
		setTimeout(function () {
			captureEnabled = true;
		}, DEBOUNCE_MS);
	}

	// bootstrap() wires up readiness detection. It subscribes to the editor's
	// Common.NotificationCenter 'document:ready' notification when available
	// (Requirements 4.1, 7.3); otherwise it falls back to BOUNDED polling that
	// waits on the public editor API being present AND a truthy getCountPages()
	// (i.e. the document has actually loaded pages) before calling init()
	// (Requirement 4.3). Only public methods are used — no private-field probe.
	function bootstrap() {
		// Subscribe to Common.NotificationCenter 'document:ready' as ONE nudge
		// toward init when available (Req 4.1, 7.3) — but do NOT rely on it as
		// the sole trigger and do NOT early-return afterward. Live DS 9.3.1
		// testing showed this notification does not always reach an appended
		// IIFE (the doc may already be "ready" before we subscribe), which
		// previously left init() never invoked. So we always ALSO start init()
		// directly below; init() is idempotent (guarded by initDone) and
		// self-retries until the editor API is available.
		try {
			if (
				window.Common &&
				Common.NotificationCenter &&
				typeof Common.NotificationCenter.on === "function"
			) {
				Common.NotificationCenter.on("document:ready", function () {
					init();
				});
			}
		} catch (e) {
			// swallow: subscription failure must not block init (Req 5.4)
		}

		// Always kick off init() directly. init() checks that Asc.editor +
		// asc_registerCallback are present and, if not, reschedules itself every
		// 200ms; once ready it registers callbacks and arms the restore trigger
		// (which itself waits for getCountPages() > 0). This guarantees the
		// feature initializes regardless of whether any readiness notification
		// reaches us (Requirement 4.3). Wrapped so bootstrap can never propagate
		// an error out to the editor (Requirements 5.4, 6.1).
		try {
			init();
		} catch (e) {
			// swallow: bootstrap must never block the editor (Requirement 5.4)
		}
	}

	// Top-level entry. Wrapped so that even an unexpected failure in bootstrap
	// wiring can never propagate out of the IIFE into the editor bundle
	// (Requirements 5.4, 6.1).
	try {
		bootstrap();
	} catch (e) {
		// swallow: the editor must always continue operating normally
	}
})();
