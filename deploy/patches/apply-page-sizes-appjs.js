/**
 * Injects custom book page sizes into the app.js bundle (web-apps dropdown menu).
 * Run: node deploy/patches/apply-page-sizes-appjs.js deploy/patches/documenteditor-app.js
 */

const fs = require('fs');
const target = process.argv[2] || 'deploy/patches/documenteditor-app.js';

const CUSTOM_SIZES = [
  { caption: "Trade Paperback (small)", w: 139.7, h: 215.9 },
  { caption: "Trade Paperback (Large)", w: 152.4, h: 228.6 },
  { caption: "6.14x9.21", w: 156, h: 233.9 },
  { caption: "7x10", w: 177.8, h: 254 },
  { caption: "8.25x11", w: 209.5, h: 279.4 },
  { caption: "Mass-Market Paperback", w: 107.95, h: 174.5 },
  { caption: "A Format", w: 110, h: 178 },
  { caption: "Penguin", w: 111, h: 181 },
  { caption: "B Format", w: 138, h: 216 },
];

let code = fs.readFileSync(target, 'utf8');

// The anchor: inject before Super B/A3 (last standard size)
const anchor = '{caption:"Super B/A3"';

if (!code.includes(anchor)) {
  console.error('ERROR: Could not find page size anchor in ' + target);
  process.exit(1);
}

// Build injection entries
const entries = CUSTOM_SIZES.map(s => {
  const subtitle = `${(s.w/10).toFixed(1)}cm x ${(s.h/10).toFixed(1)}cm`;
  return `{caption:"${s.caption}",subtitle:"${subtitle}",template:c,checkable:!0,toggleGroup:"menuPageSize",value:[${s.w},${s.h}]}`;
}).join(',');

// Insert our sizes before Super B/A3
code = code.replace(anchor, entries + ',' + anchor);

fs.writeFileSync(target, code);
console.log(`Injected ${CUSTOM_SIZES.length} page sizes into ${target}`);
