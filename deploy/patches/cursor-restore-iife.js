/*
 * Euro-Office cursor restore (paragraph-level) — appended to
 * documenteditor-app.js. Runs inside the editor iframe.
 *
 * On cursor idle it records the current paragraph index to localStorage
 * (keyed per user + document); on document (re)load it moves the caret back to
 * that paragraph and scrolls it into view. This fixes the "cursor jumps to the
 * top of the document after a reload / lost connection" problem.
 *
 * Why paragraph-level (not character-exact): the editor's public builder/macro
 * API, reached via Asc.editor.callCommand, is sandboxed to the ApiDocument
 * surface, which exposes GetCurrentParagraph()/GetPosInParent() but no
 * in-paragraph character offset. Character-exact restore would require a
 * from-source Document Server build; paragraph-level removes the top-jump pain
 * with zero document mutation (localStorage only — no bookmark, no save, no
 * version, no collaboration churn, works in read-only sessions).
 *
 * Diagnostic logging: OFF by default. Enable (persists across reloads):
 *   localStorage.setItem('eo:cursor:debug','1')   // then reload
 * Logs are prefixed "[eo-cursor]".
 *
 * Design: .kiro/specs/editor-cursor-restore/design.md
 */
(function () {
	"use strict";

	var FEATURE_ENABLED = true;
	var CAPTURE_IDLE_MS = 1200;
	var STORE_PREFIX = "eo:cursor:pos:";

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

	function getApi() {
		try {
			return (window.Asc && Asc.editor) || window.editor || null;
		} catch (e) {
			return null;
		}
	}

	// Platform-injected context from the parent editor page (editor.ejs sets
	// window.__eoCursorCtx = { userId, docId, canEdit }). Read via window.parent.
	function getParentCtx() {
		try {
			var p = window.parent;
			if (p && p !== window && p.__eoCursorCtx) return p.__eoCursorCtx;
		} catch (e) {}
		try {
			if (window.__eoCursorCtx) return window.__eoCursorCtx;
		} catch (e) {}
		return null;
	}

	var cachedKey = null;

	// Storage key is per user + per document so positions don't collide across
	// users (collaboration) or documents.
	function storageKey() {
		if (cachedKey) return cachedKey;
		var ctx = getParentCtx() || {};
		var uid = String(ctx.userId || "anon").replace(/[^A-Za-z0-9_-]/g, "_");
		var did = String(ctx.docId || readDocIdFromUrl() || "doc").replace(/[^A-Za-z0-9_-]/g, "_");
		cachedKey = STORE_PREFIX + uid + ":" + did;
		return cachedKey;
	}

	// Fallback doc id from the parent URL (/editor/:fileId) if ctx lacks one.
	function readDocIdFromUrl() {
		try {
			var path = window.parent.location.pathname;
			var parts = path.split("/");
			var last = parts[parts.length - 1];
			if (last && last.length >= 8) return last;
		} catch (e) {}
		return null;
	}

	function savePos(idx) {
		try { window.localStorage.setItem(storageKey(), String(idx)); } catch (e) {}
	}
	function loadPos() {
		try {
			var v = window.localStorage.getItem(storageKey());
			if (v === null) return null;
			var n = parseInt(v, 10);
			return isNaN(n) ? null : n;
		} catch (e) { return null; }
	}

	// --- Capture / restore via the macro (callCommand) API ------------------
	//
	// callCommand runs the function in the document context and returns a
	// serializable value through the callback. Reads/moves only — no mutation.

	function captureCursor() {
		var api = getApi();
		if (!api || typeof api.callCommand !== "function") return;
		if (suppress) return;
		try {
			api.callCommand(function () {
				var p = Api.GetDocument().GetCurrentParagraph();
				return p ? p.GetPosInParent() : -1;
			}, false, function (idx) {
				try {
					if (typeof idx === "number" && idx >= 0) {
						savePos(idx);
						log("captureCursor: saved paragraph index " + idx);
					}
				} catch (e) {}
			});
		} catch (e) {
			log("captureCursor: threw", e && e.message);
		}
	}

	function restoreCursor() {
		var api = getApi();
		if (!api || typeof api.callCommand !== "function") { log("restoreCursor: no callCommand"); return; }
		var idx = loadPos();
		if (idx === null || idx < 0) { log("restoreCursor: no stored position"); return; }

		suppress = true;
		// callCommand serializes window.Asc.scope into the macro context; set the
		// target index there BEFORE invoking so the macro can read it.
		try { Asc.scope = Asc.scope || {}; Asc.scope.eoIdx = idx; } catch (e) {}
		try {
			api.callCommand(function () {
				var target = Asc.scope.eoIdx;
				var doc = Api.GetDocument();
				var count = doc.GetElementsCount();
				if (target < 0 || target >= count) return false;
				var el = doc.GetElement(target);
				if (!el || !el.GetClassType || el.GetClassType() !== "paragraph") return false;
				var r = el.GetRange(0, 0);
				if (!r || !r.Select) return false;
				r.Select(false);
				return true;
			}, false, function (ok) {
				log("restoreCursor: applied index " + idx + " (ok=" + ok + ")");
				setTimeout(function () { suppress = false; }, 300);
			});
		} catch (e) {
			log("restoreCursor: threw", e && e.message);
			suppress = false;
		}
	}

	// --- Capture wiring (idle-debounced cursor movement) --------------------

	var captureEnabled = false;
	var suppress = false; // true while our own restore runs
	var captureTimer = null;

	function onCursorMoved() {
		if (!captureEnabled || suppress) return;
		if (captureTimer !== null) clearTimeout(captureTimer);
		captureTimer = setTimeout(function () {
			captureTimer = null;
			captureCursor();
		}, CAPTURE_IDLE_MS);
	}

	// --- Restore wiring (once per load, after content settles) --------------

	var restoreDone = false;
	var restorePolling = false;
	var restoreTries = 0;
	var lastCount = -1;
	var plateauCount = 0;
	var RESTORE_MAX_TRIES = 70;

	function runRestoreOnce() {
		if (restoreDone || restorePolling) return;
		log("runRestoreOnce: starting restore poll");
		restorePolling = true;
		pollRestore();
	}

	function pollRestore() {
		try {
			if (restoreDone) return;
			var api = getApi();
			var count = 0;
			try { count = api && typeof api.getCountPages === "function" ? api.getCountPages() : 0; } catch (e) {}

			if (count > 0 && count === lastCount) plateauCount++;
			else plateauCount = 0;
			lastCount = count;

			var settled = count > 0 && plateauCount >= 3;
			var timedOut = restoreTries >= RESTORE_MAX_TRIES;

			if (settled || timedOut) {
				restoreDone = true;
				restoreCursor();
				setTimeout(function () {
					captureEnabled = true;
					log("capture ENABLED");
				}, 800);
				return;
			}
			restoreTries++;
			setTimeout(pollRestore, 150);
		} catch (e) {
			log("pollRestore: threw", e && e.message);
		}
	}

	// --- init / bootstrap ---------------------------------------------------

	var initDone = false;
	var initTries = 0;

	function init() {
		try {
			if (initDone) return;
			var api = getApi();
			if (!api || !api.asc_registerCallback) {
				if (initTries++ < 50) setTimeout(init, 200);
				else log("init: editor API never became available (gave up)");
				return;
			}
			initDone = true;
			log("init: editor API ready");

			try { api.asc_registerCallback("asc_onCursorMove", onCursorMoved); } catch (e) {}
			try { api.asc_registerCallback("asc_onCurrentPage", onCursorMoved); } catch (e) {}
			try { api.asc_registerCallback("onDocumentContentReady", runRestoreOnce); } catch (e) {}

			setTimeout(runRestoreOnce, 400);
		} catch (e) {
			log("init: threw", e && e.message);
		}
	}

	function bootstrap() {
		if (!FEATURE_ENABLED) {
			log("bootstrap: disabled (FEATURE_ENABLED=false); no-op");
			return;
		}
		log("bootstrap: starting");
		try {
			if (window.Common && Common.NotificationCenter && typeof Common.NotificationCenter.on === "function") {
				Common.NotificationCenter.on("document:ready", function () { init(); });
			}
		} catch (e) {}
		try { init(); } catch (e) {}
	}

	try { bootstrap(); } catch (e) {}
})();
