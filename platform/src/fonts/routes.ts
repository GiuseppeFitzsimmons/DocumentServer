import { Router } from 'express';
import { z } from 'zod';
import { config } from '../config.js';
import { requireAuth } from '../auth/middleware.js';
import { filterFontsBin } from './binary-filter.js';
import { FONT_CATALOG, FONT_NAMES, FONT_CATALOG_SET, DEFAULT_FONTS } from './catalog.js';
import { getUserFonts, setUserFonts } from './preferences.js';

export const fontsRouter = Router();

// Cache upstream AllFonts.js (same for all users)
let cachedUpstream: string | null = null;

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
  // Always include DejaVu Sans for full Unicode coverage (symbols, special chars)
  const fontsWithFallback = new Set([...allowedFonts, 'DejaVu Sans']);

  // 1. Filter __fonts_infos: replace non-allowed entries with ASCW3 placeholder
  //    (preserves array indexes so sprite thumbnails and __fonts_ranges stay valid)
  const infosMatch = source.match(/window\["__fonts_infos"\]\s*=\s*\[([\s\S]*?)\];/);
  let filtered = source;

  if (!infosMatch) return source;

  // Parse all entries
  const allEntries: { name: string; raw: string }[] = [];
  const regex = /\["([^"]+)",([\d\-,]+)\]/g;
  let match;
  while ((match = regex.exec(infosMatch[1])) !== null) {
    allEntries.push({ name: match[1], raw: match[0] });
  }

  // Build filtered infos preserving positions
  const filteredEntries = allEntries.map(entry => {
    if (fontsWithFallback.has(entry.name)) return entry.raw;
    return '["ASCW3",0,0,-1,-1,-1,-1,-1,-1]';
  });

  filtered = filtered.replace(
    /window\["__fonts_infos"\]\s*=\s*\[[\s\S]*?\];/,
    `window["__fonts_infos"] = [\n${filteredEntries.join(',\n')}\n];`
  );

  // 2. Filter g_fonts_selection_bin to same set
  const binMatch = filtered.match(/window\["g_fonts_selection_bin"\]\s*=\s*"([^"]+)"/);
  if (binMatch) {
    const rawBin = Buffer.from(binMatch[1], 'base64');
    const filteredBin = filterFontsBin(rawBin, fontsWithFallback);
    const filteredBinB64 = filteredBin.toString('base64');
    filtered = filtered.replace(
      /window\["g_fonts_selection_bin"\]\s*=\s*"[^"]+"/,
      `window["g_fonts_selection_bin"] = "${filteredBinB64}"`
    );
  }

  return filtered;
}

// Per-user filtered response cache (keyed by userId)
const userFilteredCache = new Map<string, string>();
// Default fonts response (for unauthenticated/sessionless requests)
let defaultFilteredResponse: string | null = null;

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
  const schema = z.object({ fonts: z.array(z.string()).min(1).max(14) });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Must select between 1 and 14 fonts.' });
    return;
  }

  try {
    const userId = req.session.userId!;
    await setUserFonts(userId, parsed.data.fonts);

    // Rebuild the filtered AllFonts.js immediately
    const upstream = await fetchUpstreamAllFonts();
    const fontsToServe = parsed.data.fonts.length > 0 ? parsed.data.fonts : DEFAULT_FONTS;
    const filtered = buildFilteredAllFonts(upstream, new Set(fontsToServe));
    userFilteredCache.set(userId, filtered);
    console.log(`[fonts] Rebuilt AllFonts.js for user ${userId} with ${fontsToServe.length} fonts`);

    res.json({ success: true, count: parsed.data.fonts.length });
  } catch (err) {
    console.error('[fonts] Set preferences error:', err);
    res.status(500).json({ error: 'Failed to save font preferences' });
  }
});

// GET /api/fonts/AllFonts.js — filtered font manifest (per-user)
fontsRouter.get('/AllFonts.js', async (req, res) => {
  try {
    const userId = req.session?.userId;
    let fontList: string[] = DEFAULT_FONTS;

    if (userId) {
      // Check per-user cache
      const cached = userFilteredCache.get(userId);
      if (cached) {
        res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
        res.setHeader('Cache-Control', 'no-store');
        res.send(cached);
        return;
      }

      const userFonts = await getUserFonts(userId);
      if (userFonts.length > 0) fontList = userFonts;
    }

    const upstream = await fetchUpstreamAllFonts();
    const filtered = buildFilteredAllFonts(upstream, new Set(fontList));

    // Cache per-user, or cache the default
    if (userId) {
      userFilteredCache.set(userId, filtered);
    } else {
      defaultFilteredResponse = filtered;
    }

    res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.send(filtered);
  } catch (err) {
    console.error('[fonts] AllFonts.js proxy error:', err);
    res.status(502).send('// AllFonts.js proxy error');
  }
});

// POST /api/fonts/invalidate-cache
fontsRouter.post('/invalidate-cache', requireAuth, (_req, res) => {
  cachedUpstream = null;
  userFilteredCache.clear();
  defaultFilteredResponse = null;
  res.json({ success: true });
});
