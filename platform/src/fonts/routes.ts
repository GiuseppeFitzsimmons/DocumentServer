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
  // 1. Filter g_fonts_selection_bin
  const binMatch = source.match(/window\["g_fonts_selection_bin"\]\s*=\s*"([^"]+)"/);
  let filteredBinB64 = '';
  if (binMatch) {
    const rawBin = Buffer.from(binMatch[1], 'base64');
    const filteredBin = filterFontsBin(rawBin, allowedFonts);
    filteredBinB64 = filteredBin.toString('base64');
  }

  // 2. Filter __fonts_infos
  const infosMatch = source.match(/window\["__fonts_infos"\]\s*=\s*\[([\s\S]*?)\];/);
  let filteredInfos = '';
  if (infosMatch) {
    filteredInfos = filterFontsInfos(infosMatch[1], allowedFonts);
  }

  // 3. Rebuild the response
  let filtered = source;

  if (binMatch && filteredBinB64) {
    filtered = filtered.replace(
      /window\["g_fonts_selection_bin"\]\s*=\s*"[^"]+"/,
      `window["g_fonts_selection_bin"] = "${filteredBinB64}"`
    );
  }

  if (infosMatch) {
    filtered = filtered.replace(
      /window\["__fonts_infos"\]\s*=\s*\[[\s\S]*?\];/,
      `window["__fonts_infos"] = [\n${filteredInfos}\n];`
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
    res.json({ success: true, count: parsed.data.fonts.length });
  } catch (err) {
    console.error('[fonts] Set preferences error:', err);
    res.status(500).json({ error: 'Failed to save font preferences' });
  }
});

// GET /api/fonts/AllFonts.js — filtered font manifest (per-user)
fontsRouter.get('/AllFonts.js', requireAuth, async (req, res) => {
  try {
    const userId = req.session.userId!;
    const userFonts = await getUserFonts(userId);

    // If user has no preferences, serve all custom fonts
    const fontList = userFonts.length > 0 ? userFonts : FONT_NAMES;
    const allowedSet = new Set(fontList);

    const cacheKey = getCacheKey(fontList);

    if (!filteredCache.has(cacheKey)) {
      const upstream = await fetchUpstreamAllFonts();
      const filtered = buildFilteredAllFonts(upstream, allowedSet);

      // Evict oldest if cache is full
      if (filteredCache.size >= MAX_CACHE_ENTRIES) {
        const firstKey = filteredCache.keys().next().value;
        if (firstKey) filteredCache.delete(firstKey);
      }

      filteredCache.set(cacheKey, filtered);
    }

    res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
    res.setHeader('Cache-Control', 'private, no-cache');
    res.send(filteredCache.get(cacheKey));
  } catch (err) {
    console.error('[fonts] AllFonts.js proxy error:', err);
    res.status(502).json({ error: 'Failed to load font manifest' });
  }
});

// POST /api/fonts/invalidate-cache
fontsRouter.post('/invalidate-cache', requireAuth, (_req, res) => {
  cachedUpstream = null;
  filteredCache.clear();
  res.json({ success: true });
});
