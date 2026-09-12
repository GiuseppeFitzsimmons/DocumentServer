// Temporary differential consistency check: IIFE mirrored logic vs core module.
// Loads the IIFE source, extracts the pure helpers via a controlled sandbox,
// and compares deriveFileKey / storeKey-format / save+load / isPageInRange
// against cursor-restore-core.js across normal and adversarial inputs.
import { readFileSync } from 'node:fs';
import * as core from './cursor-restore-core.js';

const src = readFileSync(new URL('./cursor-restore-iife.js', import.meta.url), 'utf8');

// Build a fake window with a Map-backed localStorage and a mock Asc.editor so
// the IIFE can install. We then reach into its functions by re-exposing them.
function makeSandbox(docKey, userId, storeMap) {
  const storage = {
    getItem: (k) => (storeMap.has(k) ? storeMap.get(k) : null),
    setItem: (k, v) => storeMap.set(k, String(v)),
    removeItem: (k) => storeMap.delete(k),
  };
  const editor = {
    DocInfo: {
      get_Id: () => docKey,
      get_UserId: () => userId,
    },
    getCurrentPage: () => 0,
    getCountPages: () => 10,
    goToPage: () => {},
    asc_registerCallback: () => {},
  };
  const win = {
    Asc: { editor },
    editor,
    localStorage: storage,
    Common: undefined,
    setTimeout: () => 0,
    clearTimeout: () => {},
    setInterval: () => 0,
    clearInterval: () => {},
  };
  return { win, storage };
}

// Rewrite the IIFE so it RETURNS its internal functions instead of running
// bootstrap. We append a return of the closure's functions right before the
// bootstrap try/catch. Simplest robust approach: eval the body with `window`
// injected and capture functions by wrapping.
function loadIife(win) {
  // Replace the top-level invocation `(function(){ ... })();` so we can grab
  // the internals. We inject a hook: expose functions on win.__test before the
  // final bootstrap() call.
  const hook = `\n\twindow.__test = { deriveFileKey: deriveFileKey, storeKey: storeKey, save: save, load: load, isPageInRange: isPageInRange, getFileKey: getFileKey, getUserId: getUserId };\n`;
  const patched = src.replace('\ttry {\n\t\tbootstrap();', hook + '\ttry {\n\t\tbootstrap();');
  const fn = new Function('window', 'Asc', 'Common', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', patched + '\n;return window.__test;');
  return fn(win, win.Asc, win.Common, win.setTimeout, win.clearTimeout, win.setInterval, win.clearInterval);
}

let failures = 0;
function check(name, a, b) {
  const eq = JSON.stringify(a) === JSON.stringify(b);
  if (!eq) {
    failures++;
    console.log(`MISMATCH [${name}]: iife=${JSON.stringify(a)} core=${JSON.stringify(b)}`);
  }
}

// 1. deriveFileKey consistency
const docKeys = ['abc_123', 'a_b_c_999', '', 'noUnderscore', '_leading', 'x_', '12345_1700000000000'];
{
  const { win } = makeSandbox('abc_123', 'u1', new Map());
  const t = loadIife(win);
  for (const dk of docKeys) {
    check('deriveFileKey ' + JSON.stringify(dk), t.deriveFileKey(dk), core.deriveFileKey(dk));
  }
}

// 2. storeKey format consistency (IIFE storeKey uses captured docKey+userId)
{
  for (const dk of ['abc_123', 'a_b_c_999', '12345_1700000000000']) {
    for (const uid of ['u1', 'anon', 'user-42']) {
      const storeMap = new Map();
      const { win } = makeSandbox(dk, uid, storeMap);
      const t = loadIife(win);
      const fk = t.getFileKey();
      const iifeKey = core.STORE_PREFIX + fk + ':' + t.getUserId();
      const coreKey = core.storeKey(core.deriveFileKey(dk), uid);
      check('storeKey ' + dk + '/' + uid, iifeKey, coreKey);
    }
  }
}

// 3. save/load round-trip and adversarial values
const rawValues = ['0', '7', '"3"', '-1', '3.5', 'null', '{}', '[]', 'abc', '', 'true', '1e2', '007'];
{
  for (const raw of rawValues) {
    // core: drive its load against a preset map
    const coreMap = new Map();
    const coreKey = 'eo:cursor:abc_123:u1';
    coreMap.set(coreKey, raw);
    const coreStorage = {
      getItem: (k) => (coreMap.has(k) ? coreMap.get(k) : null),
      setItem: (k, v) => coreMap.set(k, String(v)),
      removeItem: (k) => coreMap.delete(k),
    };
    const coreLoad = core.load(coreStorage, coreKey);

    // iife: preset its live localStorage map with the same raw under the same key
    const iifeMap = new Map();
    iifeMap.set(coreKey, raw);
    const { win } = makeSandbox('abc_123', 'u1', iifeMap);
    const t = loadIife(win);
    const iifeLoad = t.load();
    check('load raw=' + JSON.stringify(raw), iifeLoad, coreLoad);
  }
}

// 4. save integer round-trip
{
  for (const page of [0, 1, 7, 42, 999]) {
    const iifeMap = new Map();
    const { win } = makeSandbox('abc_123', 'u1', iifeMap);
    const t = loadIife(win);
    t.save(page);
    const iifeLoad = t.load();

    const coreMap = new Map();
    const coreKey = core.storeKey(core.deriveFileKey('abc_123'), 'u1');
    core.save(coreStorageFor(coreMap), coreKey, page);
    const coreLoad = core.load(coreStorageFor(coreMap), coreKey);
    check('save/load page=' + page, iifeLoad, coreLoad);
  }
}
function coreStorageFor(m) {
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: (k) => m.delete(k),
  };
}

// 5. isPageInRange consistency
{
  const { win } = makeSandbox('abc_123', 'u1', new Map());
  const t = loadIife(win);
  const idxs = [-1, 0, 1, 5, 9, 10, 3.5, NaN];
  const counts = [0, 1, 10, -3];
  for (const p of idxs) {
    for (const c of counts) {
      check(`isPageInRange(${p},${c})`, t.isPageInRange(p, c), core.isPageInRange(p, c));
    }
  }
}

if (failures === 0) {
  console.log('CONSISTENCY_OK: IIFE mirrored logic matches core module across all cases');
} else {
  console.log('CONSISTENCY_FAILURES: ' + failures);
  process.exit(1);
}
