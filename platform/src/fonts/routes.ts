import { Router } from 'express';
import { z } from 'zod';
import { config } from '../config.js';
import { requireAuth } from '../auth/middleware.js';
import { filterFontsBin, filterFontsInfos } from './binary-filter.js';
import { FONT_CATALOG, FONT_NAMES, FONT_CATALOG_SET } from './catalog.js';
import { getUserFonts, setUserFonts } from './preferences.js';

export const fontsRouter = Router();

// Cache upstream AllFonts.js (same for all users)
let cachedUpstream: string | null = null;

// Per-user filtered cache (keyed by sorted font list hash)
const filteredCache = new Map<string, string>();
const MAX_CACHE_ENTRIES = 100;

async function fetchUpstreamAllFonts(): Promise<string> {
  if (cachedUpstream) return cachedUpstream;
  const dsUrl = config.DS_INTERNAL_URL || config.DS_URL;
  const url = `${dsUrl}/sdkjs/common/AllFonts.js`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Failed to fetch AllFonts.js from DS: ${res.status}`);
  }
  cachedUpstream = await res.text();
  return cachedUpstream;
}

function buildFilteredAllFonts(source: string, allowedFonts: Set<string>): string {
  // 1. Parse and filter __fonts_infos, building an old→new index map
  const infosMatch = source.match(/window\["__fonts_infos"\]\s*=\s*\[([\s\S]*?)\];/);
  let filtered = source;

  if (!infosMatch) return source;

  // Parse all infos entries with their original indexes
  const allEntries: { index: number; name: string; raw: string }[] = [];
  const regex = /\["([^"]+)",([\d\-,]+)\]/g;
  let match;
  while ((match = regex.exec(infosMatch[1])) !== null) {
    allEntries.push({ index: allEntries.length, name: match[1], raw: match[0] });
  }

  // Build filtered infos: keep allowed entries at their original positions,
  // replace others with null so sprite indexes stay aligned
  const filteredEntries: string[] = [];
  const keptIndexes = new Set<number>();
  for (const entry of allEntries) {
    if (allowedFonts.has(entry.name)) {
      filteredEntries.push(entry.raw);
      keptIndexes.add(entry.index);
    } else {
      // Placeholder: "ASCW3" with valid file index 0 — editor skips these in the font list
      filteredEntries.push(`["ASCW3",0,0,-1,-1,-1,-1,-1,-1]`);
    }
  }

  // Replace __fonts_infos (same length as original, preserving indexes)
  filtered = filtered.replace(
    /window\["__fonts_infos"\]\s*=\s*\[[\s\S]*?\];/,
    `window["__fonts_infos"] = [\n${filteredEntries.join(',\n')}\n];`
  );

  // 2. __fonts_ranges stays untouched — indexes still valid since we preserved positions

  // 3. Filter g_fonts_selection_bin
  const binMatch = filtered.match(/window\["g_fonts_selection_bin"\]\s*=\s*"([^"]+)"/);
  if (binMatch) {
    const rawBin = Buffer.from(binMatch[1], 'base64');
    const filteredBin = filterFontsBin(rawBin, allowedFonts);
    const filteredBinB64 = filteredBin.toString('base64');
    filtered = filtered.replace(
      /window\["g_fonts_selection_bin"\]\s*=\s*"[^"]+"/,
      `window["g_fonts_selection_bin"] = "${filteredBinB64}"`
    );
  }

  return filtered;
}

function getCacheKey(fonts: string[]): string {
  return fonts.slice().sort().join('|');
}

// --- Public API endpoints ---

// GET /api/fonts/catalog — list all available fonts with filenames
fontsRouter.get('/catalog', requireAuth, (_req, res) => {
  res.json(FONT_CATALOG);
});

// GET /api/fonts/preferences — get current user's selected fonts
fontsRouter.get('/preferences', requireAuth, async (req, res) => {
  try {
    const userId = req.session.userId!;
    const fonts = await getUserFonts(userId);
    res.json(fonts);
  } catch (err) {
    console.error('[fonts] Get preferences error:', err);
    res.status(500).json({ error: 'Failed to load font preferences' });
  }
});

// POST /api/fonts/preferences — set current user's font selection
fontsRouter.post('/preferences', requireAuth, async (req, res) => {
  const schema = z.object({ fonts: z.array(z.string()).min(1).max(FONT_NAMES.length) });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Must select at least 1 font.' });
    return;
  }

  try {
    const userId = req.session.userId!;
    await setUserFonts(userId, parsed.data.fonts);

    // Rebuild the filtered AllFonts.js immediately
    const upstream = await fetchUpstreamAllFonts();
    currentFilteredResponse = buildFilteredAllFonts(upstream, new Set(parsed.data.fonts));
    console.log(`[fonts] Rebuilt AllFonts.js with ${parsed.data.fonts.length} fonts after preference save`);

    res.json({ success: true, count: parsed.data.fonts.length });
  } catch (err) {
    console.error('[fonts] Set preferences error:', err);
    res.status(500).json({ error: 'Failed to save font preferences' });
  }
});

// GET /api/fonts/AllFonts.js — filtered font manifest (per-user)
// Strategy: when preferences are saved, we pre-build the filtered response.
// All requests (authenticated or not) get the same pre-built response.
let currentFilteredResponse: string | null = null;

fontsRouter.get('/AllFonts.js', async (req, res) => {
  try {
    // If no pre-built response exists, build one now
    if (!currentFilteredResponse) {
      const userId = req.session?.userId;
      let fontList = FONT_NAMES;
      if (userId) {
        const userFonts = await getUserFonts(userId);
        if (userFonts.length > 0) fontList = userFonts;
      }
      const upstream = await fetchUpstreamAllFonts();
      currentFilteredResponse = buildFilteredAllFonts(upstream, new Set(fontList));
      console.log(`[fonts] Built initial AllFonts.js with ${fontList.length} fonts`);
    }

    res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.send(currentFilteredResponse);
  } catch (err) {
    console.error('[fonts] AllFonts.js proxy error:', err);
    res.status(502).send('// AllFonts.js proxy error');
  }
});

// POST /api/fonts/invalidate-cache
fontsRouter.post('/invalidate-cache', requireAuth, (_req, res) => {
  cachedUpstream = null;
  currentFilteredResponse = null;
  filteredCache.clear();
  res.json({ success: true });
});
