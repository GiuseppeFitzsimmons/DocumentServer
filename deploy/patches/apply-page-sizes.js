/**
 * Injects custom book page sizes into the DS sdk-all.js bundle.
 * Run inside the DS container after build:
 *   node /patches/apply-page-sizes.js /var/www/euro-office/documentserver/sdkjs/word/sdk-all.js
 */

const fs = require('fs');
const target = process.argv[2] || '/var/www/euro-office/documentserver/sdkjs/word/sdk-all.js';

const CUSTOM_SIZES = [
  {name: "Trade Paperback (small)", w_mm: 139.7, h_mm: 215.9, w_tw: 7921, h_tw: 12247},
  {name: "Trade Paperback (Large)", w_mm: 152.4, h_mm: 228.6, w_tw: 8641, h_tw: 12962},
  {name: "6.14x9.21", w_mm: 156, h_mm: 233.9, w_tw: 8845, h_tw: 13262},
  {name: "7x10", w_mm: 177.8, h_mm: 254, w_tw: 10081, h_tw: 14401},
  {name: "8.25x11", w_mm: 209.5, h_mm: 279.4, w_tw: 11879, h_tw: 15842},
  {name: "Mass-Market Paperback", w_mm: 107.95, h_mm: 174.5, w_tw: 6121, h_tw: 9894},
  {name: "A Format", w_mm: 110, h_mm: 178, w_tw: 6237, h_tw: 10093},
  {name: "Penguin", w_mm: 111, h_mm: 181, w_tw: 6294, h_tw: 10263},
  {name: "B Format", w_mm: 138, h_mm: 216, w_tw: 7825, h_tw: 12304},
];

let code = fs.readFileSync(target, 'utf8');

// Find the Envelope Coukei 3 entry (last entry in the page sizes array)
const anchor = '{name : "Envelope Coukei 3"';
const anchorMin = '{name:"Envelope Coukei 3"';

let insertPoint = code.indexOf(anchor);
let isMinified = false;
if (insertPoint === -1) {
  insertPoint = code.indexOf(anchorMin);
  isMinified = true;
}

if (insertPoint === -1) {
  console.error('ERROR: Could not find page sizes anchor in ' + target);
  process.exit(1);
}

// Find the end of that entry (closing brace + possible comma)
const searchFrom = insertPoint;
const entryEnd = code.indexOf('}', searchFrom) + 1;

// Build the injection string
const injection = CUSTOM_SIZES.map(s => {
  if (isMinified) {
    return `{name:"${s.name}",w_mm:${s.w_mm},h_mm:${s.h_mm},w_tw:${s.w_tw},h_tw:${s.h_tw}}`;
  }
  return `{name : "${s.name}", w_mm : ${s.w_mm}, h_mm : ${s.h_mm}, w_tw : ${s.w_tw}, h_tw : ${s.h_tw}}`;
}).join(',');

// Insert after the last existing entry
code = code.slice(0, entryEnd) + ',' + injection + code.slice(entryEnd);

fs.writeFileSync(target, code);
console.log(`Injected ${CUSTOM_SIZES.length} custom page sizes into ${target}`);
