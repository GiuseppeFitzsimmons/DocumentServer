// Static / smoke checks on the production cursor-restore IIFE.
//
// Task 9.1 (public-methods-only static check): assert the production IIFE
// references ONLY the public, unmangled editor surface and does NOT reference
// any minified private field or removed probe scaffolding.
//
// Requirements: 6.1, 6.2, 7.1, 7.2, 7.3, 7.4
//
// The forbidden identifiers currently appear only inside explanatory comments
// in the IIFE (documenting what was removed). This check therefore strips all
// comments from the source first, so the assertions reflect actual executable
// CODE references, not documentation.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, it, expect } from "vitest";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const IIFE_PATH = resolve(
	__dirname,
	"../../deploy/patches/cursor-restore-iife.js"
);

/**
 * Strip line (`// ...`) and block (`/* ... *\/`) comments from JS source so
 * static assertions reflect executable code only. String/regex literals in
 * this particular IIFE do not contain comment sequences, so a lightweight
 * state machine that tracks single-, double-, and template-quoted strings is
 * sufficient and avoids matching comment markers inside string literals.
 */
function stripComments(src) {
	let out = "";
	let i = 0;
	const n = src.length;
	let quote = null; // current string delimiter: ', ", or `

	while (i < n) {
		const ch = src[i];
		const next = i + 1 < n ? src[i + 1] : "";

		if (quote) {
			out += ch;
			if (ch === "\\") {
				// preserve escaped char
				if (i + 1 < n) {
					out += next;
					i += 2;
					continue;
				}
			} else if (ch === quote) {
				quote = null;
			}
			i += 1;
			continue;
		}

		// not currently inside a string
		if (ch === '"' || ch === "'" || ch === "`") {
			quote = ch;
			out += ch;
			i += 1;
			continue;
		}

		if (ch === "/" && next === "/") {
			// line comment: skip to end of line (keep the newline)
			i += 2;
			while (i < n && src[i] !== "\n") i += 1;
			continue;
		}

		if (ch === "/" && next === "*") {
			// block comment: skip to closing */
			i += 2;
			while (i < n && !(src[i] === "*" && src[i + 1] === "/")) i += 1;
			i += 2; // skip closing */
			continue;
		}

		out += ch;
		i += 1;
	}

	return out;
}

describe("cursor-restore IIFE — public-methods-only static check", () => {
	const source = readFileSync(IIFE_PATH, "utf8");
	const code = stripComments(source);

	const ALLOWED = [
		"getCurrentPage",
		"goToPage",
		"getCountPages",
		"asc_registerCallback",
		"Common.NotificationCenter",
	];

	const FORBIDDEN = [
		"WordControl",
		"GetContentPosition",
		"SetContentPosition",
		"getLogicDocument",
		"window.__EO_CURSOR_LOADED",
		"window.__eoCursor",
	];

	it("strips comments so the check targets executable code only", () => {
		// Sanity: the raw source documents removed identifiers in comments, but
		// the comment-stripped code must not.
		expect(source).toContain("WordControl");
		expect(code).not.toContain("//");
	});

	for (const token of ALLOWED) {
		it(`references the allowed public API: ${token}`, () => {
			expect(code).toContain(token);
		});
	}

	for (const token of FORBIDDEN) {
		it(`does NOT reference the forbidden identifier in code: ${token}`, () => {
			expect(code).not.toContain(token);
		});
	}
});
