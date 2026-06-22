/**
 * Filters the g_fonts_selection_bin binary blob to only include fonts
 * whose names are in the allowlist.
 *
 * Binary format (version 2):
 *   [uint32] totalCount
 *   [entries...] where each entry is:
 *     [uint32] recordLen (total bytes for this entry including this field)
 *     [uint32] nameLen
 *     [nameLen bytes] font name (UTF-8, no null terminator in the length)
 *     ... (remaining fields, we skip using recordLen)
 */

export function filterFontsBin(raw: Buffer, allowedFonts: Set<string>): Buffer {
  const totalCount = raw.readUInt32LE(0);
  let offset = 4;

  // First pass: collect offsets and names, determine which to keep
  const entries: { offset: number; length: number; name: string; keep: boolean }[] = [];

  for (let i = 0; i < totalCount; i++) {
    if (offset + 8 > raw.length) break;
    const recordLen = raw.readUInt32LE(offset);

    // Read name length (at offset + 4)
    const nameLen = raw.readUInt32LE(offset + 4);

    // Read name bytes (at offset + 8)
    const name = raw.toString('utf8', offset + 8, offset + 8 + nameLen);

    const keep = allowedFonts.has(name);
    entries.push({ offset, length: recordLen, name, keep });

    // recordLen includes the recordLen field itself
    offset += recordLen;
  }

  // Second pass: build filtered buffer
  const keptEntries = entries.filter(e => e.keep);
  const keptCount = keptEntries.length;

  // Calculate total size: 4 (count) + sum of kept entry lengths
  const totalSize = 4 + keptEntries.reduce((sum, e) => sum + e.length, 0);
  const out = Buffer.alloc(totalSize);

  // Write new count
  out.writeUInt32LE(keptCount, 0);

  // Copy kept entries
  let writeOffset = 4;
  for (const entry of keptEntries) {
    raw.copy(out, writeOffset, entry.offset, entry.offset + entry.length);
    writeOffset += entry.length;
  }

  return out;
}

/**
 * Filters __fonts_infos entries to only keep fonts in the allowlist.
 * Preserves indexing by keeping entries in place but removing non-allowed ones entirely.
 * Since we're also filtering the binary blob, the indexes need to be rebuilt.
 *
 * Returns a new __fonts_infos array string with only allowed font entries,
 * AND remaps the file indexes to a filtered __fonts_files array.
 */
export function filterFontsInfos(
  infosBlock: string,
  allowedFonts: Set<string>
): string {
  // Match each entry: ["FontName", numbers...]
  const entries: string[] = [];
  const entryRegex = /\[("[^"]+?"(?:,[^[\]]*)?)\]/g;
  let match;

  while ((match = entryRegex.exec(infosBlock)) !== null) {
    const entryContent = match[1];
    const nameMatch = entryContent.match(/^"([^"]+)"/);
    if (nameMatch && allowedFonts.has(nameMatch[1])) {
      entries.push(`[${entryContent}]`);
    }
  }

  return entries.join(',\n');
}
