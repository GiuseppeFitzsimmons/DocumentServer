/**
 * DOCX Style Normalizer
 *
 * Fixes a known interoperability bug where documents exported from Google Docs
 * (and some other editors) define the built-in paragraph styles (Normal,
 * Heading 1-9, Title, Subtitle) WITHOUT the `<w:qFormat/>` flag.
 *
 * OnlyOffice's style gallery in the Home menu only displays a style when it is
 * marked as a "quick format" style (`<w:qFormat/>`) or is a recognized default
 * header/footer/footnote/endnote style. As a result, these styles are present
 * and usable in the document (via right-click "Formatting as style"), but do
 * not appear in the Home menu gallery, so users cannot apply them.
 *
 * The community-documented workaround is to open the file in LibreOffice and
 * re-save it, which re-adds the qFormat flags. This module performs the same
 * normalization deterministically on upload: for every built-in paragraph
 * style that lacks an explicit `<w:qFormat/>`, we inject one.
 *
 * See: https://community.onlyoffice.com/t/bug-not-all-style-templates-are-visible-in-home-menu/7811
 *
 * Operates on a docx buffer and returns a (possibly) rewritten buffer.
 */

import AdmZip from 'adm-zip';

/**
 * Built-in OOXML paragraph style names that belong in the Home menu style
 * gallery. Matching is done against the `w:name` value of each style, which is
 * the language-neutral OOXML identifier that OnlyOffice keys on internally.
 *
 * Names are compared case-insensitively and whitespace-normalized so that both
 * "Heading1" and "Heading 1" match.
 */
const BUILTIN_QUICK_STYLE_NAMES: ReadonlySet<string> = new Set([
  'normal',
  'heading1',
  'heading2',
  'heading3',
  'heading4',
  'heading5',
  'heading6',
  'heading7',
  'heading8',
  'heading9',
  'title',
  'subtitle',
]);

function normalizeName(name: string): string {
  return name.toLowerCase().replace(/\s+/g, '');
}

export interface NormalizeResult {
  /** The normalized styles.xml (unchanged if nothing was modified). */
  xml: string;
  /** Number of styles that had a <w:qFormat/> injected. */
  count: number;
}

/**
 * Normalizes a styles.xml string, injecting `<w:qFormat/>` into built-in
 * paragraph styles that lack it. Pure function — no I/O — so it is easy to test.
 */
export function normalizeStylesXml(stylesXml: string): NormalizeResult {
  let count = 0;

  // Match each full <w:style ...>...</w:style> block. `w:style` never nests, so
  // a non-greedy match to the first closing tag is safe.
  const xml = stylesXml.replace(
    /<w:style\b([^>]*)>([\s\S]*?)<\/w:style>/g,
    (match, attrs: string, inner: string) => {
      // Only paragraph styles appear in the paragraph style gallery.
      if (!/\bw:type\s*=\s*"paragraph"/.test(attrs)) return match;

      // Already flagged as a quick-format style — nothing to do. This also
      // preserves an explicit `<w:qFormat w:val="0"/>` / "false" (a deliberate
      // opt-out), which we must not override.
      if (/<w:qFormat\b/.test(inner)) return match;

      // Resolve the style's OOXML name.
      const nameMatch = inner.match(/<w:name\b[^>]*\bw:val\s*=\s*"([^"]*)"/);
      if (!nameMatch) return match;

      if (!BUILTIN_QUICK_STYLE_NAMES.has(normalizeName(nameMatch[1]))) {
        return match;
      }

      count++;

      // Inject <w:qFormat/> in a schema-valid position. In the CT_Style
      // sequence, qFormat comes after name/aliases/basedOn/next/link/
      // autoRedefine/hidden/uiPriority/semiHidden/unhideWhenUsed. Placing it
      // immediately before the first of pPr/rPr (or at the end of the block if
      // neither is present) keeps it ordered correctly relative to those.
      const insertBefore = inner.search(/<w:(pPr|rPr)\b/);
      let newInner: string;
      if (insertBefore >= 0) {
        newInner =
          inner.slice(0, insertBefore) + '<w:qFormat/>' + inner.slice(insertBefore);
      } else {
        newInner = inner + '<w:qFormat/>';
      }

      return `<w:style${attrs}>${newInner}</w:style>`;
    }
  );

  return { xml, count };
}

/**
 * Normalizes a docx file buffer. If the buffer is not a valid docx, or has no
 * word/styles.xml, or requires no changes, the original buffer is returned
 * unchanged.
 *
 * Failures are swallowed and the original buffer is returned so that a
 * malformed or unexpected file never blocks an upload.
 */
export function normalizeDocxStyles(buffer: Buffer): Buffer {
  let zip: AdmZip;
  try {
    zip = new AdmZip(buffer);
  } catch {
    // Not a valid zip (e.g., a corrupt upload). Leave it untouched.
    return buffer;
  }

  const stylesEntry = zip.getEntry('word/styles.xml');
  if (!stylesEntry) return buffer;

  let stylesXml: string;
  try {
    stylesXml = stylesEntry.getData().toString('utf-8');
  } catch {
    return buffer;
  }

  const { xml, count } = normalizeStylesXml(stylesXml);
  if (count === 0) return buffer;

  try {
    zip.updateFile('word/styles.xml', Buffer.from(xml, 'utf-8'));
    const out = zip.toBuffer();
    console.log(
      `[docx-style-normalizer] Injected <w:qFormat/> into ${count} built-in paragraph style(s)`
    );
    return out;
  } catch (err) {
    console.warn('[docx-style-normalizer] Failed to rewrite styles.xml:', err);
    return buffer;
  }
}
