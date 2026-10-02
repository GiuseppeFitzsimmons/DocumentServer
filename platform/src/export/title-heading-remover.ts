/**
 * Title Heading Remover - strips pandoc's synthesized document-title heading
 * from the epub body.
 *
 * When pandoc is invoked with `--metadata title=...`, its EPUB writer injects
 * the title into the body as a level-1 heading carrying the `unnumbered` class
 * (e.g. `<h1 class="unnumbered">Untitled</h1>`), in addition to the optional
 * title page. This is produced by the WRITER, after Lua filters run, so it
 * cannot be removed via an AST filter — it must be stripped post-write.
 *
 * We only remove the FIRST such heading encountered in document order (the
 * synthesized title), leaving any genuinely unnumbered body headings intact.
 * The title page itself remains controlled by the --epub-title-page toggle.
 */

import AdmZip from 'adm-zip';
import { writeFileSync } from 'fs';

/**
 * Removes the synthesized unnumbered title heading from the epub's content.
 * Best-effort: returns silently if the epub can't be opened or the heading
 * isn't found.
 */
export async function removeSynthesizedTitleHeading(epubPath: string): Promise<void> {
  let zip: AdmZip;
  try {
    zip = new AdmZip(epubPath);
  } catch (err) {
    console.warn(`title-heading-remover: failed to open epub: ${err}`);
    return;
  }

  // Content files in spine-ish order; nav/title_page excluded.
  const entries = zip.getEntries()
    .filter(e => {
      if (e.isDirectory) return false;
      if (!/\.(xhtml|html)$/i.test(e.entryName)) return false;
      const lower = e.entryName.toLowerCase();
      if (lower.includes('nav')) return false;
      if (lower.includes('title_page')) return false;
      return true;
    })
    .sort((a, b) => a.entryName.localeCompare(b.entryName));

  for (const entry of entries) {
    const content = entry.getData().toString('utf-8');
    const stripped = stripFirstUnnumberedTitle(content);
    if (stripped !== null) {
      zip.updateFile(entry.entryName, Buffer.from(stripped, 'utf-8'));
      writeFileSync(epubPath, zip.toBuffer());
      return; // Only the first (synthesized) title heading is removed.
    }
  }
}

/**
 * Removes the first `<h1 ... class="...unnumbered...">...</h1>` from the given
 * XHTML. Returns the modified content, or null if no such heading is present.
 *
 * Exported for unit testing.
 */
export function stripFirstUnnumberedTitle(content: string): string | null {
  // Match an <h1> whose class attribute contains the "unnumbered" token,
  // capturing the whole element (non-greedy inner).
  const h1Regex = /<h1\b[^>]*\bclass="[^"]*\bunnumbered\b[^"]*"[^>]*>[\s\S]*?<\/h1>\s*/i;
  if (!h1Regex.test(content)) return null;
  return content.replace(h1Regex, '');
}
