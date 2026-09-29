/**
 * Master catalog of available custom fonts from EuroBureau-Fonts.
 *
 * The catalog is loaded at startup from a manifest (`fonts.json`) that lives in
 * the fonts submodule / mounted fonts directory. This lets the set of fonts be
 * managed alongside the font files themselves and picked up automatically on
 * deploy (the fonts directory is bind-mounted into the portal container and the
 * submodule is pulled during the deploy) without a code change.
 *
 * If the manifest is missing or invalid, we fall back to a built-in list baked
 * into the application so the font picker never goes offline.
 *
 * Each entry maps a font name (as it appears in the editor) to a preview
 * filename served at /static-fonts/.
 */
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { config } from '../config.js';

export interface FontEntry {
  name: string;
  file: string; // filename for @font-face preview (relative to /static-fonts/)
}

interface FontManifest {
  version?: number;
  defaults?: string[];
  fonts?: FontEntry[];
}

const MANIFEST_FILENAME = 'fonts.json';

/**
 * Resolve the directory that holds the font files and the fonts.json manifest.
 * Order of precedence:
 *   1. FONTS_DIR env override
 *   2. /data/fonts in production (bind-mounted fonts submodule)
 *   3. the repo `fonts` submodule in development (relative to this file)
 *
 * Kept in sync with the static file mount in index.ts (which imports this).
 */
export function resolveFontsDir(): string {
  if (config.FONTS_DIR) return config.FONTS_DIR;
  if (config.NODE_ENV === 'production') return '/data/fonts';
  const here = path.dirname(fileURLToPath(import.meta.url));
  // src/fonts -> src -> platform -> <repo>/fonts
  return path.join(here, '..', '..', '..', 'fonts');
}

/**
 * Built-in fallback catalog. Used only when the manifest cannot be loaded.
 * Sorted alphabetically by name.
 */
const FALLBACK_CATALOG: FontEntry[] = [
  { name: "Achafont", file: "Achafont.ttf" },
  { name: "Allura", file: "Allura-Regular.ttf" },
  { name: "Amatic SC", file: "AmaticSC-Regular.ttf" },
  { name: "Anchor Steam NF", file: "AnchorSteamNF.ttf" },
  { name: "Anton", file: "Anton-Regular.ttf" },
  { name: "Antique Book Cover", file: "Antique Book Cover.otf" },
  { name: "Ardeco", file: "Ardeco.ttf" },
  { name: "Art Nouveau Caps", file: "ArtNouveauCaps.ttf" },
  { name: "Attentica 4F", file: "Attentica 4F UltraLight.ttf" },
  { name: "Bangers", file: "Bangers.ttf" },
  { name: "Baskervville", file: "Baskervville-Regular.ttf" },
  { name: "Bebas Neue", file: "BebasNeue-Regular.ttf" },
  { name: "Bellefair", file: "Bellefair-Regular.ttf" },
  { name: "Bete Noir NF", file: "BeteNoirNF.ttf" },
  { name: "Big Apple NF", file: "BigAppleNF.ttf" },
  { name: "Bigelow Rules", file: "BigelowRules-Regular.ttf" },
  { name: "Boecklins Universe", file: "Boecklins Universe.ttf" },
  { name: "Breamcatcher", file: "breamcatcher rg.otf" },
  { name: "Bulletin Gothic", file: "BulletinGothic.otf" },
  { name: "Camelot Caps", file: "CamelotCaps.ttf" },
  { name: "Canterbury", file: "Canterbury.ttf" },
  { name: "Carnivalee Freakshow", file: "Carnevalee Freakshow.ttf" },
  { name: "Caslon Antique", file: "CaslonAntique.ttf" },
  { name: "Caslon OS", file: "CaslonOS-Regular.otf" },
  { name: "Chelsea", file: "Chelsea.ttf" },
  { name: "Chopin Script", file: "ChopinScript.ttf" },
  { name: "ChunkFive", file: "Chunk.otf" },
  { name: "ChunkFive Print", file: "Chunk Five Print.otf" },
  { name: "Cinzel", file: "Cinzel-Regular.ttf" },
  { name: "Cinzel Decorative", file: "CinzelDecorative-Regular.ttf" },
  { name: "Copperplate CC", file: "CopperplateCC-Heavy.otf" },
  { name: "Cormorant", file: "Cormorant-Regular.otf" },
  { name: "Cormorant Garamond", file: "CormorantGaramond-VariableFont_wght.ttf" },
  { name: "Cormorant Infant", file: "CormorantInfant-Regular.otf" },
  { name: "Cormorant SC", file: "CormorantSC-Regular.otf" },
  { name: "Cormorant Unicase", file: "CormorantUnicase-Regular.otf" },
  { name: "Cormorant Upright", file: "CormorantUpright-Regular.otf" },
  { name: "Crimson", file: "Crimson-Roman.ttf" },
  { name: "Dancing Script", file: "Dancing Script.ttf" },
  { name: "Debussy", file: "debussy.ttf" },
  { name: "Eileen Caps", file: "EileenCaps-Regular.ttf" },
  { name: "Elsie Swash Caps", file: "ElsieSwashCaps-Regular.ttf" },
  { name: "Emilys Candy", file: "EmilysCandy-Regular.ttf" },
  { name: "Eutemia Ornaments", file: "Eutemia Ornaments.ttf" },
  { name: "Fancy Pants NF", file: "FancyPantsNF.ttf" },
  { name: "Fashion Victim", file: "FashionVictim.ttf" },
  { name: "Ferrum", file: "ferrum.otf" },
  { name: "Fledgling", file: "fledgling-sb.otf" },
  { name: "Floral Capitals", file: "FloralCapitals.ttf" },
  { name: "FoglihtenDeH02", file: "FoglihtenDeH02.otf" },
  { name: "FoglihtenDeH04", file: "FoglihtenDeH04.otf" },
  { name: "FoglihtenNo04", file: "FoglihtenNo04-070.otf" },
  { name: "Ghastly Panic", file: "Ghastly Panic.ttf" },
  { name: "Gmarket Sans Bold", file: "GmarketSansBold.otf" },
  { name: "Great Vibes", file: "GreatVibes-Regular.ttf" },
  { name: "Griffy", file: "Griffy-Regular.ttf" },
  { name: "Grusskarten Gotisch", file: "GrusskartenGotisch.ttf" },
  { name: "Henny Penny", file: "HennyPenny-Regular.ttf" },
  { name: "Herr Von Muellerhoff", file: "HerrVonMuellerhoff-Regular.ttf" },
  { name: "IM FELL Flowers 2", file: "IMFeFlow2.ttf" },
  { name: "Inter", file: "Inter-VariableFont_opsz,wght.ttf" },
  { name: "International", file: "International.ttf" },
  { name: "Jost", file: "Jost-Regular.ttf" },
  { name: "Kingthings Willowless", file: "Kingthings Willowless.ttf" },
  { name: "Kismet NF", file: "KismetNF.ttf" },
  { name: "Kramer", file: "Kramer.ttf" },
  { name: "League Spartan", file: "SpartanMB-Regular.otf" },
  { name: "Libre Bodoni", file: "LibreBodoni-Regular.ttf" },
  { name: "Libre Franklin", file: "LibreFranklin-Regular.ttf" },
  { name: "Lime Glory Caps", file: "LimeGloryCaps.ttf" },
  { name: "Limelight", file: "Limelight-Regular.ttf" },
  { name: "Lintsec", file: "Lintsec.ttf" },
  { name: "London Tube", file: "LondonTube-MABx.ttf" },
  { name: "Lovers Quarrel", file: "LoversQuarrel-Regular.ttf" },
  { name: "Marcellus SC", file: "MarcellusSC-Regular.ttf" },
  { name: "Montserrat", file: "Montserrat-Regular.ttf" },
  { name: "Mystery Quest", file: "MysteryQuest-Regular.ttf" },
  { name: "Ntoday Std", file: "NtodayStd-Ultra-KS.otf" },
  { name: "Original Surfer", file: "OriginalSurfer-Regular.ttf" },
  { name: "Ornements ADF", file: "OrnementsADF.ttf" },
  { name: "Our Gang NF", file: "OurGangNF.ttf" },
  { name: "Pacifico", file: "Pacifico.ttf" },
  { name: "Parisienne", file: "Parisienne-Regular.ttf" },
  { name: "Park Lane NF", file: "ParkLaneNF.ttf" },
  { name: "Parseltongue", file: "PARSELTO.TTF" },
  { name: "Peignot", file: "Peignot.ttf" },
  { name: "Pitch Display", file: "Pitch Display Regular Demo.ttf" },
  { name: "Poiret One", file: "PoiretOne-Regular.ttf" },
  { name: "Poppins", file: "Poppins-Regular.ttf" },
  { name: "Quigley Wiggly", file: "QUIGLEYW.TTF" },
  { name: "Railway", file: "Railway.otf" },
  { name: "Rhubarb Pie", file: "RhubarbPie.ttf" },
  { name: "Ritzy Remix NF", file: "RitzyRemixNF.ttf" },
  { name: "Roboto", file: "Roboto-Regular.ttf" },
  { name: "Sanchez", file: "Sanchez-Regular.ttf" },
  { name: "Space Patrol", file: "SpacePatrol.ttf" },
  { name: "Spartan MB", file: "SpartanMB-Regular.otf" },
  { name: "Spicy Rice", file: "SpicyRice-Regular.ttf" },
  { name: "TeX Gyre Bonum", file: "texgyrebonum-regular.otf" },
  { name: "TeXGyrePagella", file: "texgyrepagella-regular.otf" },
  { name: "TeXGyreTermes", file: "texgyretermes-regular.otf" },
  { name: "Timepiece", file: "Timepiece.TTF" },
  { name: "Twentieth Century", file: "TwCenMT-Regular.ttf" },
  { name: "Ultra", file: "Ultra.ttf" },
  { name: "Vivian", file: "Vivian.ttf" },
  { name: "Westminster Gotisch", file: "WestminsterGotisch.ttf" },
  { name: "XAyax", file: "XAyax.ttf" },
  { name: "XAyax Outline", file: "XAyaxOutline.ttf" },
  { name: "Yesteryear", file: "Yesteryear-Regular.ttf" },
  { name: "Young Serif", file: "YoungSerif-Regular.ttf" },
  { name: "Zombified", file: "Zombified.ttf" },
];

// Default font set for users who haven't customized their preferences.
// Used as a fallback when the manifest omits a "defaults" list.
const FALLBACK_DEFAULT_FONTS = [
  "Baskervville",
  "Caslon OS",
  "Cormorant",
  "Dancing Script",
  "Libre Bodoni",
  "TeX Gyre Bonum",
  "TeXGyrePagella",
  "TeXGyreTermes",
];

/**
 * Validate and normalize a parsed manifest into a catalog + defaults.
 * Throws if the manifest does not contain a usable font list.
 */
export function parseManifest(raw: unknown): { catalog: FontEntry[]; defaults: string[] } {
  const manifest = raw as FontManifest;
  if (!manifest || !Array.isArray(manifest.fonts)) {
    throw new Error('manifest missing "fonts" array');
  }

  const catalog: FontEntry[] = [];
  const seen = new Set<string>();
  for (const entry of manifest.fonts) {
    if (
      !entry ||
      typeof entry.name !== 'string' ||
      typeof entry.file !== 'string' ||
      entry.name.trim() === '' ||
      entry.file.trim() === ''
    ) {
      continue; // skip malformed entries rather than failing the whole load
    }
    if (seen.has(entry.name)) continue; // first definition wins
    seen.add(entry.name);
    catalog.push({ name: entry.name, file: entry.file });
  }

  if (catalog.length === 0) {
    throw new Error('manifest contained no valid font entries');
  }

  const names = new Set(catalog.map(f => f.name));
  let defaults = Array.isArray(manifest.defaults)
    ? manifest.defaults.filter(d => typeof d === 'string' && names.has(d))
    : [];
  if (defaults.length === 0) {
    // Keep the built-in defaults, but only those present in this catalog.
    defaults = FALLBACK_DEFAULT_FONTS.filter(d => names.has(d));
    if (defaults.length === 0) {
      // Last resort: first few catalog entries so the picker has something.
      defaults = catalog.slice(0, Math.min(8, catalog.length)).map(f => f.name);
    }
  }

  return { catalog, defaults };
}

function loadCatalog(): { catalog: FontEntry[]; defaults: string[] } {
  const manifestPath = path.join(resolveFontsDir(), MANIFEST_FILENAME);
  try {
    const text = readFileSync(manifestPath, 'utf-8');
    const parsed = parseManifest(JSON.parse(text));
    console.log(
      `[fonts] Loaded catalog from ${manifestPath}: ${parsed.catalog.length} fonts, ${parsed.defaults.length} defaults`
    );
    return parsed;
  } catch (err) {
    console.warn(
      `[fonts] Could not load font manifest at ${manifestPath} (${(err as Error).message}); ` +
      `using built-in fallback catalog (${FALLBACK_CATALOG.length} fonts)`
    );
    return { catalog: FALLBACK_CATALOG, defaults: FALLBACK_DEFAULT_FONTS };
  }
}

const loaded = loadCatalog();

export const FONT_CATALOG: FontEntry[] = loaded.catalog;
export const FONT_NAMES = FONT_CATALOG.map(f => f.name);
export const FONT_CATALOG_SET = new Set(FONT_NAMES);
export const DEFAULT_FONTS = loaded.defaults;
