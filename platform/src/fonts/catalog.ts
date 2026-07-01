/**
 * Master catalog of available custom fonts from EuroBureau-Fonts.
 * Each entry maps a font name (as it appears in the editor) to a preview filename.
 * Sorted alphabetically by name.
 */
export interface FontEntry {
  name: string;
  file: string; // filename for @font-face preview (relative to /static-fonts/)
}

export const FONT_CATALOG: FontEntry[] = [
  { name: "Allura", file: "Allura-Regular.ttf" },
  { name: "Amatic SC", file: "AmaticSC-Regular.ttf" },
  { name: "Art Nouveau Caps", file: "ArtNouveauCaps.ttf" },
  { name: "Bangers", file: "Bangers.ttf" },
  { name: "Baskervville", file: "Baskervville-Regular.ttf" },
  { name: "Bebas Neue", file: "BebasNeue-Regular.ttf" },
  { name: "Bellefair", file: "Bellefair-Regular.ttf" },
  { name: "Bete Noir NF", file: "BeteNoirNF.ttf" },
  { name: "Boecklins Universe", file: "Boecklins Universe.ttf" },
  { name: "Breamcatcher", file: "breamcatcher rg.otf" },
  { name: "Bulletin Gothic", file: "BulletinGothic.otf" },
  { name: "Camelot Caps", file: "CamelotCaps.ttf" },
  { name: "Canterbury", file: "Canterbury.ttf" },
  { name: "Carnivalee Freakshow", file: "Carnevalee Freakshow.ttf" },
  { name: "Caslon Antique", file: "CaslonAntique.ttf" },
  { name: "Caslon OS", file: "CaslonOS-Regular.otf" },
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
  { name: "Eileen Caps", file: "EileenCaps-Regular.ttf" },
  { name: "Elsie Swash Caps", file: "ElsieSwashCaps-Regular.ttf" },
  { name: "Emilys Candy", file: "EmilysCandy-Regular.ttf" },
  { name: "Eutemia Ornaments", file: "Eutemia Ornaments.ttf" },
  { name: "Fancy Pants NF", file: "FancyPantsNF.ttf" },
  { name: "FoglihtenDeH02", file: "FoglihtenDeH02.otf" },
  { name: "FoglihtenDeH04", file: "FoglihtenDeH04.otf" },
  { name: "Ghastly Panic", file: "Ghastly Panic.ttf" },
  { name: "Gmarket Sans Bold", file: "GmarketSansBold.otf" },
  { name: "Great Vibes", file: "GreatVibes-Regular.ttf" },
  { name: "Henny Penny", file: "HennyPenny-Regular.ttf" },
  { name: "Herr Von Muellerhoff", file: "HerrVonMuellerhoff-Regular.ttf" },
  { name: "Inter", file: "Inter-VariableFont_opsz,wght.ttf" },
  { name: "Kismet NF", file: "KismetNF.ttf" },
  { name: "Kramer", file: "Kramer.ttf" },
  { name: "League Spartan", file: "SpartanMB-Regular.otf" },
  { name: "Libre Bodoni", file: "LibreBodoni-Regular.ttf" },
  { name: "Lime Glory Caps", file: "LimeGloryCaps.ttf" },
  { name: "Limelight", file: "Limelight-Regular.ttf" },
  { name: "Lovers Quarrel", file: "LoversQuarrel-Regular.ttf" },
  { name: "Montserrat", file: "Montserrat-Regular.ttf" },
  { name: "Ornements ADF", file: "OrnementsADF.ttf" },
  { name: "Pacifico", file: "Pacifico.ttf" },
  { name: "Parisienne", file: "Parisienne-Regular.ttf" },
  { name: "Park Lane NF", file: "ParkLaneNF.ttf" },
  { name: "Parseltongue", file: "PARSELTO.TTF" },
  { name: "Poiret One", file: "PoiretOne-Regular.ttf" },
  { name: "Poppins", file: "Poppins-Regular.ttf" },
  { name: "Quigley Wiggly", file: "QUIGLEYW.TTF" },
  { name: "Roboto", file: "Roboto-Regular.ttf" },
  { name: "Space Patrol", file: "SpacePatrol.ttf" },
  { name: "Spartan MB", file: "SpartanMB-Regular.otf" },
  { name: "Spicy Rice", file: "SpicyRice-Regular.ttf" },
  { name: "TeX Gyre Bonum", file: "texgyrebonum-regular.otf" },
  { name: "TeXGyrePagella", file: "texgyrepagella-regular.otf" },
  { name: "TeXGyreTermes", file: "texgyretermes-regular.otf" },
  { name: "XAyax", file: "XAyax.ttf" },
  { name: "XAyax Outline", file: "XAyaxOutline.ttf" },
  { name: "Yesteryear", file: "Yesteryear-Regular.ttf" },
  { name: "Young Serif", file: "YoungSerif-Regular.ttf" },
  { name: "Zombified", file: "Zombified.ttf" },
];

export const FONT_NAMES = FONT_CATALOG.map(f => f.name);
export const FONT_CATALOG_SET = new Set(FONT_NAMES);

// Default font set for users who haven't customized their preferences
export const DEFAULT_FONTS = [
  "Baskervville",
  "Caslon OS",
  "Cormorant",
  "Dancing Script",
  "Libre Bodoni",
  "TeX Gyre Bonum",
  "TeXGyrePagella",
  "TeXGyreTermes",
];
