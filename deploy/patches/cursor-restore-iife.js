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

	// ---------------------------------------------------------------------------
	// KILL SWITCH: cursor-restore is DISABLED.
	//
	// The bookmark-based capture/restore below works, but keeping the persisted
	// anchor in sync without manufacturing saves on pure navigation required
	// increasingly fragile heuristics around the editor's late/ambiguous
	// modified-changed events. We're shipping with the feature OFF: no bookmarks
	// are ever read or written, no callbacks are registered, nothing mutates the
	// document. All the implementation is retained below, verbatim, so it can be
	// revived later — flip FEATURE_ENABLED to true (and address the save-timing
	// problem) to re-enable. bootstrap() early-returns when this is false.
	// ---------------------------------------------------------------------------
	var FEATURE_ENABLED = false;

	// Delay before capture is enabled after restore. Must comfortably exceed the
	// latency of the modified event produced by the load-time bulk delete of old
	// anchors (observed ~1.9s later via recalc), so that event lands and the
	// latch is cleared before capture goes live — never mis-latched as a user edit.
	var CAPTURE_ENABLE_MS = 2500;
	// Re-anchor only after the cursor has been still this long. A longer idle
	// means we re-anchor when the user has PAUSED, so the recalc from the
	// bookmark remove+add isn't a visible mid-interaction snap.
	var CAPTURE_IDLE_MS = 1500;
	var BM_PREFIX = "_eoCursor_"; // leading "_" => hidden bookmark

	// --- Diagnostic logging -------------------------------------------------
	// Off by default, but the setting PERSISTS across reloads via localStorage
	// (the IIFE re-runs on every load, so a plain window flag would be wiped
	// before any log fired — which is exactly what made it look like "no logs").
	// Enable once from the iframe console with:
	//   localStorage.setItem('eo:cursor:debug','1')   // then reload
	// Disable with:
	//   localStorage.removeItem('eo:cursor:debug')
	// window.__eoCursorDebug is still honored at runtime for the current page.
	try {
		if (typeof window.__eoCursorDebug === "undefined") {
			var persisted = false;
			try { persisted = window.localStorage.getItem("eo:cursor:debug") === "1"; } catch (e) {}
			window.__eoCursorDebug = persisted;
		}
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

	// Per-user bookmark PREFIX. Each capture appends a unique name of the form
	// {prefix}{timestamp}; the restore enumerates by this prefix.
	function bookmarkName() {
		var uid = getUserId().replace(/[^A-Za-z0-9_]/g, "_");
		return BM_PREFIX + uid + "_";
	}

	// --- Capture / restore --------------------------------------------------
	//
	// Model (append-then-cleanup-on-load):
	//   - capture: while editing, append a fresh uniquely-named anchor at the
	//     caret after the cursor has been IDLE (CAPTURE_IDLE_MS). Never remove
	//     mid-session — remove churn caused the snap-back. Anchors accumulate.
	//   - restore: on load, go to the NEWEST anchor for this user, then delete
	//     ALL of this user's anchors. Cleanup happens once, after reading.
	//   We trigger capture on cursor movement because asc_onSave does NOT fire on
	//   autosave in this build (verified via logs).
	//     Each asc_RemoveBookmark/asc_AddBookmark is an undoable action that
	//     triggers a Recalculate; doing that while the user is actively moving
	//     snapped the view back (the reported bug). Re-anchoring only once the
	//     user has PAUSED avoids that — the recalc doesn't fight live movement —
	//     and still keeps the anchor fresh. The bookmark add rides whatever
	//     autosave is already in flight, so no manufactured saves beyond editing.

	// Capture: append a fresh, uniquely-named anchor at the caret. We never
	// remove during a session — the per-session churn of remove+add was what
	// caused the mid-interaction snap-back (each is an undoable mutation that
	// triggers a Recalculate). Appends accumulate; they're all cleaned up at the
	// next load (see restoreCursor). The anchor name carries a timestamp so the
	// loader can pick the newest. We still gate on editedSinceCapture so pure
	// navigation never appends (which would manufacture a save).
	function captureCursor() {
		try {
			if (!isEditable()) { log("captureCursor: not editable, skipping"); return false; }

			if (!editedSinceCapture) {
				log("captureCursor: no edits since last anchor (navigation only), skipping");
				return false;
			}

			var mgr = getBookmarksManager();
			if (!mgr || typeof mgr.asc_AddBookmark !== "function") {
				log("captureCursor: no manager/add, skipping");
				return false;
			}
			var name = bookmarkName() + Date.now();
			suppressCapture = true;
			// Our own add flips the modified flag, and that event can arrive LATE
			// (after recalc, past any suppress timer). Arm a one-shot so the next
			// clean->dirty transition — ours — is swallowed instead of re-latching
			// as a user edit. Without this the latch gets stuck true and pure
			// navigation keeps anchoring (the reported bug).
			swallowNextModified = true;
			// Self-disarm: if the doc was already dirty when we added (autosave
			// hadn't cleared the user's prior edit yet), our add causes NO
			// clean->dirty transition, so no modified event arrives to swallow.
			// Leaving the one-shot armed would then eat the user's NEXT real edit.
			// Disarm it after a window comfortably past recalc latency.
			if (swallowDisarmTimer !== null) clearTimeout(swallowDisarmTimer);
			swallowDisarmTimer = setTimeout(function () {
				swallowDisarmTimer = null;
				if (swallowNextModified) {
					swallowNextModified = false;
					log("captureCursor: swallow one-shot expired unused (doc was already dirty)");
				}
			}, 3000);
			try {
				mgr.asc_AddBookmark(name);
				editedSinceCapture = false; // consumed; require a new edit before next anchor
				log("captureCursor: anchored " + name + " (edited since last anchor)");
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

	// Restore: on load, enumerate every anchor this user left (prefix match),
	// navigate to the NEWEST (highest timestamp suffix), then delete ALL of them
	// — including the one we navigated to. Cleanup happens once, here, after
	// we've read what we need, so there's no mid-session remove churn and no race
	// with autosave. The bulk delete runs before capture is enabled, so its
	// modified event can't be mistaken for a user edit (the latch is cleared when
	// capture turns on).
	function restoreCursor() {
		try {
			var mgr = getBookmarksManager();
			if (!mgr || typeof mgr.asc_GetCount !== "function" || typeof mgr.asc_GetName !== "function") {
				log("restoreCursor: no manager or no enumeration API");
				return false;
			}
			var prefix = bookmarkName();
			var mine = [];
			var count = mgr.asc_GetCount();
			for (var i = 0; i < count; i++) {
				var nm = mgr.asc_GetName(i);
				if (nm && nm.indexOf(prefix) === 0) mine.push(nm);
			}
			if (mine.length === 0) {
				log("restoreCursor: no anchors for prefix " + prefix + " -> no-op");
				return false;
			}
			// Newest = largest timestamp suffix (lexicographic works for equal-
			// length millis, but compare numerically to be safe).
			mine.sort(function (a, b) {
				var ta = parseInt(a.slice(prefix.length), 10) || 0;
				var tb = parseInt(b.slice(prefix.length), 10) || 0;
				return ta - tb;
			});
			var newest = mine[mine.length - 1];

			suppressCapture = true;
			try {
				if (typeof mgr.asc_GoToBookmark === "function") {
					mgr.asc_GoToBookmark(newest);
					log("restoreCursor: navigated to newest " + newest + " (" + mine.length + " total)");
				}
				if (typeof mgr.asc_RemoveBookmark === "function") {
					for (var j = 0; j < mine.length; j++) {
						try { mgr.asc_RemoveBookmark(mine[j]); }
						catch (e) { log("restoreCursor: delete threw for " + mine[j], e && e.message); }
					}
					log("restoreCursor: deleted " + mine.length + " anchor(s)");
				}
			} finally {
				setTimeout(function () { suppressCapture = false; }, 250);
			}
			return true;
		} catch (e) {
			log("restoreCursor: threw", e && e.message);
			return false;
		}
	}

	// --- Capture wiring (save-triggered, gated) -----------------------------

	var captureEnabled = false;

	// Re-entrancy guard: our own bookmark mutation can fire save/cursor events;
	// ignore them so we don't re-trigger capture (which would loop).
	var suppressCapture = false;

	// Latch: has the user made a real content edit since our last anchor? Set by
	// onDocModified (asc_onDocumentModifiedChanged) and consumed by captureCursor.
	// We own this flag so it survives autosave clearing the editor's own dirty
	// state. Suppressed during our own mutation so the bookmark add doesn't set
	// it (which would make navigation-only sessions look edited).
	var editedSinceCapture = false;

	// One-shot: our own bookmark add flips the modified flag, but that event can
	// arrive LATE (after recalc, past the suppressCapture timer). We set this at
	// the add and swallow exactly the next clean->dirty transition so our own
	// mutation isn't counted as a user edit (which would stick the latch true and
	// make navigation keep anchoring).
	var swallowNextModified = false;
	var swallowDisarmTimer = null;

	function onDocModified() {
		try {
			if (suppressCapture) return; // our own mutation (within suppress window)
			// Ignore everything until capture is live: the load-time bulk delete of
			// old anchors also mutates the doc, and the latch is cleared when
			// capture turns on, so pre-enable events never count.
			if (!captureEnabled) return;
			var api = getApi();
			var modified = api && typeof api.isDocumentModified === "function" ? api.isDocumentModified() : false;
			if (!modified) return; // only the clean->dirty transition matters
			if (swallowNextModified) {
				swallowNextModified = false;
				if (swallowDisarmTimer !== null) { clearTimeout(swallowDisarmTimer); swallowDisarmTimer = null; }
				log("onDocModified: swallowed our own bookmark-add mutation (not a user edit)");
				return;
			}
			editedSinceCapture = true;
			log("onDocModified: user edit latched (editedSinceCapture=true)");
		} catch (e) {
			log("onDocModified: threw", e && e.message);
		}
	}

	// Capture trigger. asc_onSave does NOT fire on autosave in DS 9.3.1 (verified
	// via logs: it never arrived), so we trigger on cursor movement, debounced.
	// To avoid the earlier snap-back, we re-anchor only after the user has PAUSED
	// (IDLE debounce) — when movement has stopped, the recalc from remove+add is
	// not visible as a mid-interaction jump. We also skip if nothing moved since
	// the last anchor.
	var captureTimer = null;
	function onCursorMoved() {
		try {
			if (!captureEnabled) { log("onCursorMoved: gated (pre-restore), ignoring"); return; }
			if (suppressCapture) { return; }
			if (captureTimer !== null) clearTimeout(captureTimer);
			captureTimer = setTimeout(function () {
				captureTimer = null;
				log("onCursorMoved: idle elapsed -> capturing");
				captureCursor();
			}, CAPTURE_IDLE_MS);
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
			// Clear any edit latched during restore. The anchor delete on load is
			// a mutation whose modified event can arrive late (recalc), so wipe the
			// latch at the enable boundary; onDocModified also ignores edits until
			// this point. Result: only post-restore user edits latch.
			editedSinceCapture = false;
			captureEnabled = true;
			log("capture ENABLED (latch cleared)");
		}, CAPTURE_ENABLE_MS);
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

			// Capture triggers on cursor movement (asc_onSave does not fire on
			// autosave in this build). Both events funnel into the idle-debounced
			// onCursorMoved.
			try { api.asc_registerCallback("asc_onCursorMove", onCursorMoved); log("init: registered asc_onCursorMove"); }
			catch (e) { log("init: asc_onCursorMove register threw", e && e.message); }
			try { api.asc_registerCallback("asc_onCurrentPage", onCursorMoved); log("init: registered asc_onCurrentPage"); }
			catch (e) { log("init: asc_onCurrentPage register threw", e && e.message); }

			// Latch real edits (survives autosave clearing the editor's dirty flag)
			// so the capture gate can tell editing from pure navigation.
			try { api.asc_registerCallback("asc_onDocumentModifiedChanged", onDocModified); log("init: registered asc_onDocumentModifiedChanged"); }
			catch (e) { log("init: asc_onDocumentModifiedChanged register threw", e && e.message); }

			try { api.asc_registerCallback("onDocumentContentReady", runRestoreOnce); log("init: registered onDocumentContentReady"); }
			catch (e) { log("init: onDocumentContentReady register threw", e && e.message); }

			setTimeout(runRestoreOnce, 400);
		} catch (e) {
			log("init: threw", e && e.message);
		}
	}

	function bootstrap() {
		if (!FEATURE_ENABLED) {
			log("bootstrap: cursor-restore disabled (FEATURE_ENABLED=false); no-op");
			return;
		}
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
