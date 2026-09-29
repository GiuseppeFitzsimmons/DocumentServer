import { describe, it, expect } from 'vitest';
import AdmZip from 'adm-zip';
import { readFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';
import { normalizeStylesXml, normalizeDocxStyles } from '../docx-style-normalizer.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Repo root is platform/../  → the sample lives at <root>/style.docx
const SAMPLE_DOCX = path.resolve(__dirname, '../../../../style.docx');

function makeStyle(type: string, name: string, opts: { qFormat?: boolean; body?: string } = {}) {
  const q = opts.qFormat ? '<w:qFormat/>' : '';
  const body = opts.body ?? '';
  return `<w:style w:type="${type}" w:styleId="${name}"><w:name w:val="${name}"/>${q}${body}</w:style>`;
}

function wrapStyles(inner: string) {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">${inner}</w:styles>`;
}

describe('normalizeStylesXml', () => {
  it('injects <w:qFormat/> into built-in paragraph styles missing it', () => {
    const xml = wrapStyles(
      makeStyle('paragraph', 'Normal') +
      makeStyle('paragraph', 'Heading 1') +
      makeStyle('paragraph', 'Title')
    );

    const { xml: out, count } = normalizeStylesXml(xml);
    expect(count).toBe(3);

    // Each targeted style now has exactly one qFormat element.
    for (const name of ['Normal', 'Heading 1', 'Title']) {
      const block = out.match(new RegExp(`<w:style[^>]*w:styleId="${name}"[\\s\\S]*?</w:style>`))![0];
      expect((block.match(/<w:qFormat\/>/g) || []).length).toBe(1);
    }
  });

  it('does not touch styles that already have qFormat', () => {
    const xml = wrapStyles(makeStyle('paragraph', 'Heading 1', { qFormat: true }));
    const { xml: out, count } = normalizeStylesXml(xml);
    expect(count).toBe(0);
    expect((out.match(/<w:qFormat\/>/g) || []).length).toBe(1);
  });

  it('preserves an explicit qFormat opt-out (w:val="0")', () => {
    const inner = `<w:style w:type="paragraph" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat w:val="0"/></w:style>`;
    const { xml: out, count } = normalizeStylesXml(wrapStyles(inner));
    expect(count).toBe(0);
    expect(out).toContain('<w:qFormat w:val="0"/>');
    expect(out).not.toContain('<w:qFormat/>');
  });

  it('ignores non-paragraph styles and non-builtin names', () => {
    const xml = wrapStyles(
      makeStyle('character', 'Normal') +      // wrong type
      makeStyle('table', 'Heading 1') +       // wrong type
      makeStyle('paragraph', 'Rad_Standard')  // custom name
    );
    const { count } = normalizeStylesXml(xml);
    expect(count).toBe(0);
  });

  it('matches whitespace-insensitively (Heading1 == Heading 1)', () => {
    const xml = wrapStyles(makeStyle('paragraph', 'Heading1'));
    const { count } = normalizeStylesXml(xml);
    expect(count).toBe(1);
  });

  it('inserts qFormat before pPr to keep schema order', () => {
    const inner =
      `<w:style w:type="paragraph" w:styleId="Heading 1"><w:name w:val="Heading 1"/>` +
      `<w:basedOn w:val="Normal"/><w:pPr><w:spacing w:after="0"/></w:pPr>` +
      `<w:rPr><w:sz w:val="48"/></w:rPr></w:style>`;
    const { xml: out } = normalizeStylesXml(wrapStyles(inner));
    // qFormat must come before pPr
    expect(out.indexOf('<w:qFormat/>')).toBeLessThan(out.indexOf('<w:pPr>'));
    // and after basedOn
    expect(out.indexOf('<w:basedOn')).toBeLessThan(out.indexOf('<w:qFormat/>'));
  });
});

describe('normalizeDocxStyles', () => {
  it('returns the original buffer for non-zip input', () => {
    const buf = Buffer.from('not a zip');
    expect(normalizeDocxStyles(buf)).toBe(buf);
  });

  it('returns original buffer when there is nothing to fix', () => {
    const zip = new AdmZip();
    zip.addFile('word/styles.xml', Buffer.from(wrapStyles(makeStyle('paragraph', 'Heading 1', { qFormat: true }))));
    const buf = zip.toBuffer();
    // Same reference back means no rewrite happened.
    expect(normalizeDocxStyles(buf)).toBe(buf);
  });

  it('rewrites a docx that is missing qFormat flags', () => {
    const zip = new AdmZip();
    zip.addFile('word/document.xml', Buffer.from('<w:document/>'));
    zip.addFile('word/styles.xml', Buffer.from(wrapStyles(
      makeStyle('paragraph', 'Normal') + makeStyle('paragraph', 'Heading 1')
    )));
    const out = normalizeDocxStyles(zip.toBuffer());

    const outStyles = new AdmZip(out).getEntry('word/styles.xml')!.getData().toString('utf-8');
    expect((outStyles.match(/<w:qFormat\/>/g) || []).length).toBe(2);
    // document.xml is preserved untouched
    expect(new AdmZip(out).getEntry('word/document.xml')!.getData().toString('utf-8')).toBe('<w:document/>');
  });
});

describe('real sample: style.docx from the community bug report', () => {
  it('exists and reproduces the missing-qFormat condition, then is fixed', () => {
    if (!existsSync(SAMPLE_DOCX)) {
      // The sample is optional in CI; skip if not present.
      return;
    }
    const original = readFileSync(SAMPLE_DOCX);
    const before = new AdmZip(original).getEntry('word/styles.xml')!.getData().toString('utf-8');

    // Reproduce the bug: the primary paragraph styles lack qFormat.
    const normalBlock = before.match(/<w:style w:type="paragraph"[^>]*>\s*<w:name w:val="Normal"\/>[\s\S]*?<\/w:style>/)![0];
    expect(normalBlock).not.toContain('<w:qFormat');

    const fixed = normalizeDocxStyles(original);
    expect(fixed).not.toBe(original); // a rewrite occurred

    const after = new AdmZip(fixed).getEntry('word/styles.xml')!.getData().toString('utf-8');

    // Every built-in paragraph style now carries qFormat.
    for (const name of ['Normal', 'Heading 1', 'Heading 2', 'Title', 'Subtitle']) {
      const block = after.match(new RegExp(`<w:style w:type="paragraph"[^>]*>\\s*<w:name w:val="${name}"\\/>[\\s\\S]*?<\\/w:style>`));
      expect(block, `style ${name} present`).not.toBeNull();
      expect(block![0], `style ${name} has qFormat`).toContain('<w:qFormat/>');
    }
  });
});
