/*
 * Euro-Office cursor restore (character-exact, hidden-bookmark) — appended to
 * documenteditor-app.js.
 *
 * Runs inside the editor's cross-origin iframe. On cursor movement (edit-mode
 * sessions only) it drops an invisible, per-user bookmark at the caret; on
 * document (re)load it navigates to that bookmark, restoring the exact caret
 * position across sessions.
 *
 * Why bookmarks: a feasibility spike against DS 9.3.1 (minified) confirmed the
 * document model (WordControl / GetContentPosition / logic document) is NOT
 * reachable from the appended IIFE, but the public editor method
 * `Asc.editor.asc_GetBookmarksManager()` IS, returning a bookmarks manager with
 * asc_AddBookmark / asc_GoToBookmark / asc_RemoveBookmark / asc_IsHiddenBookmark.
 * A bookmark whose name begins with "_" is HIDDEN (never shown in the bookmark
 * UI, never printed/exported) and is persisted inside the .docx, so it survives
 * save + reload.
 *
 * Per-user bookmark name:  _eoCursor_{userId}
 *
 * Read-only (view-mode) sessions NEVER capture: no mutation, no save, no new
 * version, no unsaved-changes prompt.
 *
 * Diagnostic logging: OFF by default. Set window.__eoCursorDebug = true in the
 * iframe console (then reload) to enable. All logs are prefixed "[eo-cursor]".
 *
 * Design: .kiro/specs/editor-cursor-restore/design.md
 */
(function () {
	"use strict";

	var DEBOUNCE_MS = 750;
	var BM_PREFIX = "_eoCursor_"; // leading "_" => hidden bookmark

	// --- Diagnostic logging -------------------------------------------------
	// Off by default. Enable at runtime from the iframe console with
	//   window.__eoCursorDebug = true
	// (then reload). All logs are prefixed "[eo-cursor]".
	try {
		if (typeof window.__eoCursorDebug === "undefined") window.__eoCursorDebug = false;
	} catch (e) {}

	function log() {
		try {
			if (!window.__eoCursorDebug) return;
			var args = Array.prototype.slice.call(arguments);
			args.unshift("[eo-cursor]");
			// eslint-disable-next-line no-console
			console.log.apply(console, args);
		} catch (e) {}
	}

	// --- Editor accessors ---------------------------------------------------

	function getApi() {
		try {
			return (window.Asc && Asc.editor) || window.editor || null;
		} catch (e) {
			return null;
		}
	}

	function getBookmarksManager() {
		try {
			var api = getApi();
			if (!api) { log("getBookmarksManager: no api"); return null; }
			if (typeof api.asc_GetBookmarksManager !== "function") {
				log("getBookmarksManager: asc_GetBookmarksManager not a function");
				return null;
			}
			var mgr = api.asc_GetBookmarksManager() || null;
			if (!mgr) log("getBookmarksManager: returned null/undefined");
			return mgr;
		} catch (e) {
			log("getBookmarksManager: threw", e && e.message);
			return null;
		}
	}

	// Platform-injected context from the PARENT page (editor.ejs sets
	// window.__eoCursorCtx = { userId, canEdit } on the outer editor document).
	// The IIFE runs in the DS iframe — a separate, SAME-ORIGIN document — so we
	// read it via window.parent. This is the authoritative source for edit
	// permission and user id; the minified editor's own isViewMode / DocInfo
	// accessors proved unreadable in DS 9.3.1 (isViewMode is not a boolean,
	// DocInfo.get_UserId returned nothing). Returns null when unreachable.
	function getParentCtx() {
		try {
			var p = window.parent;
			if (p && p !== window && p.__eoCursorCtx) return p.__eoCursorCtx;
		} catch (e) {
			// Cross-origin access would throw; same-origin here, but guard anyway.
			log("getParentCtx: parent access threw", e && e.message);
		}
		try {
			if (window.__eoCursorCtx) return window.__eoCursorCtx;
		} catch (e) {}
		return null;
	}

	// Can this session edit the document? Capture only when editable (view-mode
	// / read-only sessions must never mutate or save).
	function isEditable() {
		try {
			var ctx = getParentCtx();
			if (ctx && typeof ctx.canEdit === "boolean") {
				log("isEditable: parentCtx.canEdit=" + ctx.canEdit);
				return ctx.canEdit;
			}
			// Fallbacks if the injected context is somehow unavailable.
			var api = getApi();
			if (api && typeof api.isViewMode === "boolean") {
				log("isEditable: fallback isViewMode=" + api.isViewMode);
				return !api.isViewMode;
			}
			log("isEditable: no usable signal -> false (conservative)");
			return false;
		} catch (e) {
			log("isEditable: threw", e && e.message, "-> false");
			return false;
		}
	}

	// --- userId (per-user bookmark naming) ----------------------------------

	var capturedUserId = null;

	function readUserId() {
		// Prefer the platform-injected context (authoritative; see getParentCtx).
		try {
			var ctx = getParentCtx();
			if (ctx && ctx.userId) return String(ctx.userId);
		} catch (e) {}
		try {
			var api = getApi();
			if (api && api.DocInfo) {
				if (typeof api.DocInfo.get_UserId === "function") {
					var uid = api.DocInfo.get_UserId();
					if (uid) return String(uid);
				}
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

	function captureConfigSnapshot() {
		if (capturedUserId === null) {
			var u = readUserId();
			if (u) capturedUserId = u;
		}
		log("config snapshot: userId=" + capturedUserId);
	}

	function getUserId() {
		return capturedUserId || readUserId() || "anon";
	}

	function bookmarkName() {
		var uid = getUserId().replace(/[^A-Za-z0-9_]/g, "_");
		return BM_PREFIX + uid;
	}

	// --- Capture / restore --------------------------------------------------

	function captureCursor() {
		try {
			if (!isEditable()) {
				log("captureCursor: not editable, skipping");
				return false;
			}
			var mgr = getBookmarksManager();
			if (!mgr) { log("captureCursor: no manager, skipping"); return false; }
			var name = bookmarkName();

			// Suppress the cursor events our own remove/add will fire, so we don't
			// re-trigger capture in an infinite loop. Keep suppression on for a
			// short tail after the mutation, since the induced events can arrive
			// asynchronously.
			suppressCapture = true;
			try {
				if (typeof mgr.asc_RemoveBookmark === "function") {
					try { mgr.asc_RemoveBookmark(name); log("captureCursor: removed existing " + name); }
					catch (e) { log("captureCursor: remove threw", e && e.message); }
				}
				if (typeof mgr.asc_AddBookmark !== "function") {
					log("captureCursor: asc_AddBookmark not a function, skipping");
					return false;
				}
				mgr.asc_AddBookmark(name);
				var present = (typeof mgr.asc_HaveBookmark === "function") ? mgr.asc_HaveBookmark(name) : "n/a";
				var api = getApi();
				var canSave = (api && typeof api.asc_isDocumentCanSave === "function") ? api.asc_isDocumentCanSave() : "n/a";
				var modified = (api && typeof api.isDocumentModified === "function") ? api.isDocumentModified() : "n/a";
				log("captureCursor: added " + name + "; haveBookmark=" + present +
					"; canSave=" + canSave + "; modified=" + modified);
				return true;
			} finally {
				setTimeout(function () { suppressCapture = false; }, 250);
			}
		} catch (e) {
			log("captureCursor: threw", e && e.message);
			suppressCapture = false;
			return false;
		}
	}

	function restoreCursor() {
		try {
			var mgr = getBookmarksManager();
			if (!mgr || typeof mgr.asc_GoToBookmark !== "function") {
				log("restoreCursor: no manager or no asc_GoToBookmark");
				return false;
			}
			var name = bookmarkName();
			if (typeof mgr.asc_HaveBookmark === "function" && !mgr.asc_HaveBookmark(name)) {
				log("restoreCursor: bookmark " + name + " absent (first open or never saved) -> no-op");
				return false;
			}
			mgr.asc_GoToBookmark(name);
			log("restoreCursor: navigated to " + name);
			return true;
		} catch (e) {
			log("restoreCursor: threw", e && e.message);
			return false;
		}
	}

	// --- Capture wiring (debounced, gated) ----------------------------------

	var debounceTimer = null;
	var captureEnabled = false;

	// Re-entrancy guard. captureCursor() mutates the document (remove+add
	// bookmark), which itself fires asc_onCursorMove / asc_onCurrentPage. Without
	// this guard those self-induced events re-trigger capture, producing an
	// infinite ~DEBOUNCE_MS loop. We suppress cursor events while our own
	// mutation is in flight, plus a short tail because the mutation's events can
	// arrive asynchronously after the call returns.
	var suppressCapture = false;

	function onCursorMoved() {
		try {
			if (!captureEnabled) { log("onCursorMoved: capture gated (pre-restore), ignoring"); return; }
			if (suppressCapture) { log("onCursorMoved: suppressed (self-induced by capture), ignoring"); return; }
			if (debounceTimer !== null) clearTimeout(debounceTimer);
			debounceTimer = setTimeout(function () {
				debounceTimer = null;
				log("onCursorMoved: debounce elapsed, capturing");
				captureCursor();
			}, DEBOUNCE_MS);
		} catch (e) {
			log("onCursorMoved: threw", e && e.message);
		}
	}

	// --- Restore wiring (once per load) -------------------------------------

	var restoreDone = false;
	var restorePolling = false;
	var restoreTries = 0;
	var lastCount = -1;
	var plateauCount = 0;
	var RESTORE_MAX_TRIES = 70; // ~70 * 150ms ≈ 10.5s upper bound

	function runRestoreOnce() {
		if (restoreDone || restorePolling) {
			log("runRestoreOnce: already done/polling, ignoring");
			return;
		}
		log("runRestoreOnce: starting restore poll");
		restorePolling = true;
		pollRestore();
	}

	function pollRestore() {
		try {
			if (restoreDone) return;
			var api = getApi();
			var count = 0;
			try {
				count = api && typeof api.getCountPages === "function" ? api.getCountPages() : 0;
			} catch (e) {
				count = 0;
			}

			if (count > 0 && count === lastCount) {
				plateauCount++;
			} else {
				plateauCount = 0;
			}
			lastCount = count;

			var settled = count > 0 && plateauCount >= 3;
			var timedOut = restoreTries >= RESTORE_MAX_TRIES;
			log("pollRestore: try=" + restoreTries + " count=" + count +
				" plateau=" + plateauCount + " settled=" + settled + " timedOut=" + timedOut);

			if (settled || timedOut) {
				restoreDone = true;
				var ok = restoreCursor();
				log("pollRestore: restore complete (ok=" + ok + "); enabling capture after debounce");
				enableCaptureSoon();
				return;
			}

			restoreTries++;
			setTimeout(pollRestore, 150);
		} catch (e) {
			log("pollRestore: threw", e && e.message);
		}
	}

	function enableCaptureSoon() {
		setTimeout(function () {
			captureEnabled = true;
			log("capture ENABLED");
		}, DEBOUNCE_MS);
	}

	// --- init / bootstrap ---------------------------------------------------

	var initDone = false;
	var initTries = 0;

	function init() {
		try {
			if (initDone) return;
			var api = getApi();
			if (!api || !api.asc_registerCallback) {
				if (initTries++ < 50) {
					setTimeout(init, 200);
				} else {
					log("init: editor API never became available (gave up)");
				}
				return;
			}
			initDone = true;
			log("init: editor API ready; isViewMode=" +
				(typeof api.isViewMode === "boolean" ? api.isViewMode : "unknown"));

			captureConfigSnapshot();

			try { api.asc_registerCallback("asc_onCursorMove", onCursorMoved); log("init: registered asc_onCursorMove"); }
			catch (e) { log("init: asc_onCursorMove register threw", e && e.message); }
			try { api.asc_registerCallback("asc_onCurrentPage", onCursorMoved); log("init: registered asc_onCurrentPage"); }
			catch (e) { log("init: asc_onCurrentPage register threw", e && e.message); }

			try { api.asc_registerCallback("onDocumentContentReady", runRestoreOnce); log("init: registered onDocumentContentReady"); }
			catch (e) { log("init: onDocumentContentReady register threw", e && e.message); }

			setTimeout(runRestoreOnce, 400);
		} catch (e) {
			log("init: threw", e && e.message);
		}
	}

	function bootstrap() {
		log("bootstrap: starting");
		try {
			if (
				window.Common &&
				Common.NotificationCenter &&
				typeof Common.NotificationCenter.on === "function"
			) {
				Common.NotificationCenter.on("document:ready", function () {
					log("bootstrap: document:ready fired");
					init();
				});
				log("bootstrap: subscribed to document:ready");
			} else {
				log("bootstrap: Common.NotificationCenter unavailable");
			}
		} catch (e) {
			log("bootstrap: NotificationCenter subscribe threw", e && e.message);
		}
		try {
			init();
		} catch (e) {
			log("bootstrap: init threw", e && e.message);
		}
	}

	try {
		bootstrap();
	} catch (e) {}
})();
