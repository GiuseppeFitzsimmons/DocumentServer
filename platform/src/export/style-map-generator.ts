/**
 * Style Map Generator - produces a JSON mapping of docx style names to CSS strings.
 * Used by the pandoc Lua filter (inject-styles.lua) to apply formatting.
 *
 * The map is keyed by style NAME (not ID), because pandoc uses style names
 * in the custom-style attribute when using -f docx+styles.
 */

import AdmZip from 'adm-zip';
import { XMLParser } from 'fast-xml-parser';
import { writeFileSync } from 'fs';

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  trimValues: false,
});

interface StyleDef {
  id: string;
  name: string;
  type: string;
  font: string | null;
  parentId: string | null;
  pPr?: Record<string, unknown>;
  rPr?: Record<string, unknown>;
}

interface StyleMapOutput {
  bodyFont: string;
  styles: Record<string, string>;  // styleName → CSS string
  headingStyles: Record<string, string>;  // "heading 1" → CSS string
}

export function generateStyleMap(docxPath: string, outputPath: string): void {
  const zip = new AdmZip(docxPath);
  const stylesXml = zip.getEntry('word/styles.xml')?.getData().toString('utf-8');
  if (!stylesXml) {
    writeFileSync(outputPath, JSON.stringify({ bodyFont: 'serif', styles: {}, headingStyles: {} }));
    return;
  }

  const parsed = xmlParser.parse(stylesXml);
  const styles = ensureArray(getPath(parsed, ['w:styles', 'w:style']));

  // Extract docDefaults font
  const docDefaultFont = getFontFromRFonts(getPath(parsed, ['w:styles', 'w:docDefaults', 'w:rPrDefault', 'w:rPr', 'w:rFonts'])) || 'serif';

  // Build style map
  const styleDefs = new Map<string, StyleDef>();
  const nameToId = new Map<string, string>();

  for (const style of styles) {
    if (!style || typeof style !== 'object') continue;
    const obj = style as Record<string, unknown>;
    const id = obj['@_w:styleId'] as string;
    if (!id) continue;

    const name = getPath(obj, ['w:name', '@_w:val']) as string || '';
    const type = (obj['@_w:type'] as string) || 'paragraph';
    const basedOn = getPath(obj, ['w:basedOn', '@_w:val']) as string | null;
    const font = getFontFromRFonts(getPath(obj, ['w:rPr', 'w:rFonts']))
      ?? getFontFromRFonts(getPath(obj, ['w:pPr', 'w:rPr', 'w:rFonts']));
    const pPr = obj['w:pPr'] as Record<string, unknown> | undefined;
    const rPr = obj['w:rPr'] as Record<string, unknown> | undefined;

    styleDefs.set(id, { id, name, type, font, parentId: basedOn || null, pPr, rPr });
    if (name) nameToId.set(name.toLowerCase(), id);
  }

  // Resolve Normal style font as body font
  let bodyFont = docDefaultFont;
  const normalId = nameToId.get('normal');
  if (normalId) {
    const resolved = resolveFont(normalId, styleDefs, docDefaultFont);
    if (resolved) bodyFont = resolved;
  }

  // Build CSS for each named style
  const output: StyleMapOutput = { bodyFont, styles: {}, headingStyles: {} };

  for (const [, def] of styleDefs) {
    if (!def.name || def.type !== 'paragraph') continue;

    const css = buildCssForStyle(def, styleDefs, bodyFont, docDefaultFont);
    if (css) {
      output.styles[def.name.toLowerCase()] = css;

      // Also store heading styles separately
      if (def.name.toLowerCase().match(/^heading\s*\d$/)) {
        output.headingStyles[def.name.toLowerCase()] = css;
      }
    }
  }

  writeFileSync(outputPath, JSON.stringify(output));
}

function buildCssForStyle(
  def: StyleDef,
  allStyles: Map<string, StyleDef>,
  bodyFont: string,
  docDefault: string
): string | null {
  const parts: string[] = [];

  // Font
  const font = resolveFont(def.id, allStyles, docDefault);
  if (font && font !== bodyFont) {
    parts.push(`font-family: '${font}'`);
  }

  // Paragraph properties (resolve through chain)
  const pPr = resolvePPr(def.id, allStyles);
  if (pPr) {
    // text-align
    const jc = getPath(pPr, ['w:jc', '@_w:val']) as string | undefined;
    if (jc) {
      const map: Record<string, string> = { left: 'left', start: 'left', center: 'center', right: 'right', end: 'right' };
      if (map[jc]) {
        parts.push(`text-align: ${map[jc]}`);
        parts.push('text-indent: 0pt');
      }
    }

    // spacing
    const spacing = pPr['w:spacing'] as Record<string, unknown> | undefined;
    if (spacing) {
      const line = spacing['@_w:line'];
      const lineRule = spacing['@_w:lineRule'] as string | undefined;
      if (line !== undefined) {
        const lineVal = Number(line);
        if (!isNaN(lineVal)) {
          if (!lineRule || lineRule === 'auto') {
            const mult = Math.round((lineVal / 240) * 100) / 100;
            if (mult <= 5) parts.push(`line-height: ${Math.round(mult * 100)}%`);
          } else {
            parts.push(`line-height: ${lineVal / 20}pt`);
          }
        }
      }
      const before = spacing['@_w:before'];
      if (before !== undefined) {
        const val = Number(before);
        if (!isNaN(val) && val > 0) parts.push(`margin-top: ${val / 20}pt`);
      }
      const after = spacing['@_w:after'];
      if (after !== undefined) {
        const val = Number(after);
        if (!isNaN(val) && val > 0) parts.push(`margin-bottom: ${val / 20}pt`);
      }
    }

    // indentation
    const ind = pPr['w:ind'] as Record<string, unknown> | undefined;
    if (ind) {
      const firstLine = ind['@_w:firstLine'];
      if (firstLine !== undefined) {
        const val = Number(firstLine);
        if (!isNaN(val)) parts.push(`text-indent: ${val / 20}pt`);
      }
      const left = ind['@_w:left'] ?? ind['@_w:start'];
      if (left !== undefined) {
        const val = Number(left);
        if (!isNaN(val) && val > 0) parts.push(`margin-left: ${val / 20}pt`);
      }
    }

    // font-size from rPr inside pPr
    const sz = getPath(pPr, ['w:rPr', 'w:sz', '@_w:val']);
    if (sz !== undefined) {
      const val = Number(sz);
      if (!isNaN(val)) parts.push(`font-size: ${val / 2}pt`);
    }
  }

  // Also check top-level rPr for font-size
  if (!parts.some(p => p.startsWith('font-size'))) {
    const sz = resolveRPrProperty(def.id, allStyles, ['w:sz', '@_w:val']);
    if (sz !== undefined) {
      const val = Number(sz);
      if (!isNaN(val)) parts.push(`font-size: ${val / 2}pt`);
    }
  }

  return parts.length > 0 ? parts.join('; ') : null;
}

function resolveFont(styleId: string, styles: Map<string, StyleDef>, docDefault: string, depth = 0): string | null {
  if (depth > 10) return null;
  const def = styles.get(styleId);
  if (!def) return null;
  if (def.font) return def.font;
  if (def.parentId) return resolveFont(def.parentId, styles, docDefault, depth + 1);
  return null;
}

function resolvePPr(styleId: string, styles: Map<string, StyleDef>, depth = 0): Record<string, unknown> | undefined {
  if (depth > 10) return undefined;
  const def = styles.get(styleId);
  if (!def) return undefined;
  if (def.pPr) return def.pPr;
  if (def.parentId) return resolvePPr(def.parentId, styles, depth + 1);
  return undefined;
}

function resolveRPrProperty(styleId: string, styles: Map<string, StyleDef>, propPath: string[], depth = 0): unknown {
  if (depth > 10) return undefined;
  const def = styles.get(styleId);
  if (!def) return undefined;
  if (def.rPr) {
    const val = getPath(def.rPr, propPath);
    if (val !== undefined) return val;
  }
  if (def.parentId) return resolveRPrProperty(def.parentId, styles, propPath, depth + 1);
  return undefined;
}

function getFontFromRFonts(rFonts: unknown): string | null {
  if (!rFonts || typeof rFonts !== 'object') return null;
  const obj = rFonts as Record<string, unknown>;
  const ascii = obj['@_w:ascii'];
  if (typeof ascii === 'string' && ascii.trim()) return ascii.trim();
  const hAnsi = obj['@_w:hAnsi'];
  if (typeof hAnsi === 'string' && hAnsi.trim()) return hAnsi.trim();
  return null;
}

function getPath(obj: unknown, path: string[]): unknown {
  let current: unknown = obj;
  for (const key of path) {
    if (current === null || current === undefined || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

function ensureArray(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (value === undefined || value === null) return [];
  return [value];
}
