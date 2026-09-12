/**
 * Appends the cursor-restore IIFE to the documenteditor app bundle.
 *
 * Requirement 8 contract (see .kiro/specs/editor-cursor-restore/design.md,
 * "Patch_Script contract"):
 *   1. APPEND the Restore_IIFE to the END of the Editor_Bundle (Req 8.1).
 *   2. Guard with the marker comment; if present, make NO modification and
 *      report "already applied" (Req 8.2 — idempotent, byte-identical re-runs).
 *   3. NEVER splice into any internal minified fragment — append only, unlike
 *      the epub patch's `code.replace(oldCode, newCode)` (Req 8.3).
 *   4. Produce a bundle deployable through the existing dev bind-mount and prod
 *      COPY with no sdkjs rebuild (Req 8.4). The patched bundle
 *      (deploy/patches/documenteditor-app.js) is deployed to
 *      web-apps/apps/documenteditor/main/app.js via:
 *        - dev:  bind-mount in platform/docker-compose.dev.yml
 *        - prod: COPY in deploy/Dockerfile.documentserver
 *
 * The IIFE source is read from cursor-restore-iife.js (sibling file).
 *
 * Run: node deploy/patches/apply-cursor-restore.js deploy/patches/documenteditor-app.js
 */

const fs = require('fs');
const path = require('path');

const target = process.argv[2] || 'deploy/patches/documenteditor-app.js';
const iifePath = path.join(__dirname, 'cursor-restore-iife.js');

const MARKER = '/* eo-cursor-restore */';

// --- Read the target bundle --------------------------------------------------
if (!fs.existsSync(target)) {
  console.error('ERROR: Target bundle not found: ' + target);
  process.exit(1);
}

let code = fs.readFileSync(target, 'utf8');

// --- Idempotency guard (Req 8.2) ---------------------------------------------
// If the marker is already present, make NO modification and report that the
// patch is already applied. Because we never write in this branch, a second run
// leaves the file byte-identical.
if (code.includes(MARKER)) {
  console.log('Cursor-restore patch already applied to ' + target + ', skipping');
  process.exit(0);
}

// --- Read the IIFE source (Req 8.1) ------------------------------------------
if (!fs.existsSync(iifePath)) {
  console.error('ERROR: IIFE source not found: ' + iifePath);
  process.exit(1);
}

const iife = fs.readFileSync(iifePath, 'utf8');

// The IIFE source itself must NOT contain the marker; otherwise the idempotency
// guard above would misdetect a fresh (unpatched) bundle as already patched
// once appended. This keeps the marker an unambiguous "patch applied" sentinel.
if (iife.includes(MARKER)) {
  console.error(
    'ERROR: IIFE source ' + iifePath + ' unexpectedly contains the marker ' +
      MARKER + '; refusing to append to avoid breaking idempotency detection'
  );
  process.exit(1);
}

// --- Append-only patch (Req 8.1, 8.3) ----------------------------------------
// Append the IIFE to the END of the bundle, guarded by the marker on its own
// line. This NEVER splices into the minified content: the original `code` is
// preserved verbatim as a prefix and only new content is concatenated after it.
const patched = code + '\n' + MARKER + '\n' + iife + '\n';

// Defensive invariant: the patched output must start with the original bundle
// byte-for-byte (append-only), and must end with the appended IIFE block.
if (patched.indexOf(code) !== 0) {
  console.error('ERROR: append-only invariant violated; aborting without writing');
  process.exit(1);
}

fs.writeFileSync(target, patched);
console.log('Cursor-restore IIFE appended to ' + target);
