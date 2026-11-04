#!/usr/bin/env node
// Dev helper: generate VALID .docx files of approximate target sizes, for
// exercising storage-quota behaviour locally (near-cap create/upload/save).
//
// Usage:
//   node scripts/make-test-docx.mjs [outDir]      (default: ./test-docs)
//
// A .docx is a ZIP of OOXML parts. DocumentServer needs the full minimal part
// set (content types, package rels, document + its rels, styles, app/core
// props). A bare 3-part zip opens as "invalid" and hangs the editor, so we
// build the complete set and pad the body with paragraphs until the ZIP is
// about the target size.
//
// The body is padded with FEW, LONG paragraphs rather than thousands of short
// ones, so the file is byte-heavy but only a handful of pages. (Thousands of
// tiny paragraphs make a near-cap doc hundreds of pages and the editor lags.)
import AdmZip from 'adm-zip';
import { writeFileSync, mkdirSync } from 'fs';
import path from 'path';

const CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
  <Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
  <Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>
  <Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>
</Types>`;

const PACKAGE_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>
  <Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>
</Relationships>`;

const DOCUMENT_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`;

const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:docDefaults>
    <w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri"/><w:sz w:val="22"/></w:rPr></w:rPrDefault>
    <w:pPrDefault/>
  </w:docDefaults>
  <w:style w:type="paragraph" w:default="1" w:styleId="Normal">
    <w:name w:val="Normal"/><w:qFormat/>
  </w:style>
</w:styles>`;

const CORE = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <dc:title>Quota Test Document</dc:title>
  <dc:creator>make-test-docx</dc:creator>
  <cp:lastModifiedBy>make-test-docx</cp:lastModifiedBy>
</cp:coreProperties>`;

const APP = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties">
  <Application>EuroBureau Test</Application>
</Properties>`;

// Deterministic pseudo-random text. Random words keep deflate from collapsing
// the body to almost nothing, so the ZIP size tracks the amount of text.
function makeText(chars, seed) {
  let s = seed >>> 0;
  const next = () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296);
  const alphabet = 'abcdefghijklmnopqrstuvwxyz';
  let out = '';
  while (out.length < chars) {
    const len = 2 + Math.floor(next() * 9);
    for (let i = 0; i < len; i++) out += alphabet[Math.floor(next() * 26)];
    out += ' ';
  }
  return out.slice(0, chars);
}

// `paragraphs` paragraphs of `charsEach` characters each.
function buildDocumentXml(paragraphs, charsEach) {
  let body = '';
  for (let i = 0; i < paragraphs; i++) {
    body += `<w:p><w:r><w:t xml:space="preserve">${makeText(charsEach, i + 1)}</w:t></w:r></w:p>`;
  }
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>${body}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr></w:body>
</w:document>`;
}

function buildDocx(paragraphs, charsEach) {
  const zip = new AdmZip();
  zip.addFile('[Content_Types].xml', Buffer.from(CONTENT_TYPES, 'utf8'));
  zip.addFile('_rels/.rels', Buffer.from(PACKAGE_RELS, 'utf8'));
  zip.addFile('word/document.xml', Buffer.from(buildDocumentXml(paragraphs, charsEach), 'utf8'));
  zip.addFile('word/_rels/document.xml.rels', Buffer.from(DOCUMENT_RELS, 'utf8'));
  zip.addFile('word/styles.xml', Buffer.from(STYLES, 'utf8'));
  zip.addFile('docProps/core.xml', Buffer.from(CORE, 'utf8'));
  zip.addFile('docProps/app.xml', Buffer.from(APP, 'utf8'));
  return zip.toBuffer();
}

// Build a docx whose ZIP size is within a couple of percent of targetBytes.
// Paragraph count stays small (one long paragraph per ~8 KB of text), and we
// bisect on the total character count because compressed size is monotonic in it.
const CHARS_PER_PARAGRAPH = 8000;
function buildForSize(targetBytes) {
  const make = (totalChars) => {
    const paragraphs = Math.max(1, Math.ceil(totalChars / CHARS_PER_PARAGRAPH));
    return buildDocx(paragraphs, Math.ceil(totalChars / paragraphs));
  };
  let lo = 100;
  let hi = Math.max(2000, targetBytes * 3); // random text compresses to ~60%, so this over-covers
  let best = make(hi);
  for (let i = 0; i < 24; i++) {
    const mid = Math.floor((lo + hi) / 2);
    const buf = make(mid);
    if (buf.length <= targetBytes) {
      best = buf;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
    if (Math.abs(buf.length - targetBytes) / targetBytes < 0.01) {
      best = buf;
      break;
    }
  }
  return best;
}

const outDir = process.argv[2] || path.resolve(process.cwd(), 'test-docs');
mkdirSync(outDir, { recursive: true });

// Sizes land within ~1% of the label (the search stops at 1%), so a file can be
// a hair over or under it. The near-cap file is aimed well under the 512 KB cap.
const targets = [
  ['test-50kb.docx', 50 * 1024],
  ['test-100kb.docx', 100 * 1024],
  ['test-200kb.docx', 200 * 1024],
  ['test-400kb.docx', 400 * 1024],
  // Just under the 512 KB dev cap (QUOTA_LIMIT_BYTES=524288 / per-user limit).
  // One upload puts the account in the warning zone and leaves ~10 KB of
  // headroom, so the very next create/upload/edit trips the limit.
  ['test-near-cap.docx', 500 * 1024],
];

for (const [name, size] of targets) {
  const buf = buildForSize(size);
  const dest = path.join(outDir, name);
  writeFileSync(dest, buf);
  console.log(`${name.padEnd(20)} ${(buf.length / 1024).toFixed(1).padStart(6)} KB  (target ${(size / 1024).toFixed(0)} KB)`);
}

console.log(`\nWrote ${targets.length} files to ${outDir}`);
console.log('With a 512 KB cap: upload test-near-cap.docx, then any upload/create should be rejected.');
