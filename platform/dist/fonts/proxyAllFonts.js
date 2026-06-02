import { Router } from 'express';
import { config } from '../config.js';
export const fontsProxyRouter = Router();
// Hardcoded allowed fonts for POC — in production this would come from user preferences/DB
const ALLOWED_FONTS = [
    'Arial',
    'Times New Roman',
    'Courier New',
];
let cachedOriginal = null;
/**
 * Fetches the real AllFonts.js from the Document Server,
 * filters __fonts_infos to only include allowed fonts,
 * and serves the filtered version.
 */
fontsProxyRouter.get('/sdkjs/common/AllFonts.js', async (req, res) => {
    try {
        console.log('[FontProxy] Serving filtered AllFonts.js');
        // Fetch the original from DS (internal network)
        if (!cachedOriginal) {
            const dsResponse = await fetch(`${config.DS_URL}/sdkjs/common/AllFonts.js`);
            if (!dsResponse.ok) {
                res.status(502).send('Failed to fetch AllFonts.js from Document Server');
                return;
            }
            cachedOriginal = await dsResponse.text();
        }
        const filtered = filterAllFonts(cachedOriginal, ALLOWED_FONTS);
        res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
        res.setHeader('Cache-Control', 'no-cache');
        res.send(filtered);
    }
    catch (err) {
        console.error('AllFonts proxy error:', err);
        res.status(500).send('Internal error');
    }
});
function filterAllFonts(source, allowedFonts) {
    // AllFonts.js sets:
    //   window["__fonts_files"] = [...]
    //   window["__fonts_infos"] = [[name, fileIdx, ...], ...]
    //
    // We need to:
    // 1. Parse __fonts_infos
    // 2. Keep only entries where entry[0] is in allowedFonts
    // 3. Rebuild the file
    // Extract __fonts_infos array using regex
    const infosMatch = source.match(/window\["__fonts_infos"\]\s*=\s*(\[[\s\S]*?\]);\s*$/m);
    if (!infosMatch) {
        // If we can't parse it, return original (don't break the editor)
        console.warn('Could not parse __fonts_infos from AllFonts.js, serving unfiltered');
        return source;
    }
    // Try a different approach: eval-free JSON-like parsing
    // The infos array contains sub-arrays like ["FontName", idx, n, n, n, n, n, n, n]
    // We'll do string manipulation to filter entries
    // Split on the infos assignment
    const infosStart = source.indexOf('window["__fonts_infos"]');
    if (infosStart === -1) {
        return source;
    }
    // Find the array start
    const arrayStart = source.indexOf('[', infosStart);
    // Find matching end bracket — the array is one big [...] with nested [...]
    let depth = 0;
    let arrayEnd = -1;
    for (let i = arrayStart; i < source.length; i++) {
        if (source[i] === '[')
            depth++;
        else if (source[i] === ']') {
            depth--;
            if (depth === 0) {
                arrayEnd = i;
                break;
            }
        }
    }
    if (arrayEnd === -1) {
        return source;
    }
    const arrayStr = source.substring(arrayStart, arrayEnd + 1);
    // Parse the array — it's valid JS array literal, we can use Function constructor
    // This is safe since we control the source (it comes from our own DS)
    let infosArray;
    try {
        infosArray = new Function('return ' + arrayStr)();
    }
    catch (e) {
        console.warn('Failed to parse __fonts_infos array:', e);
        return source;
    }
    // Filter: keep only fonts whose name (index 0) is in allowedFonts
    // Also always keep "ASCW3" (internal symbol font)
    const allowedSet = new Set(allowedFonts.map(f => f.toLowerCase()));
    const filtered = infosArray.filter((entry) => {
        const name = entry[0];
        return name === 'ASCW3' || allowedSet.has(name.toLowerCase());
    });
    // Rebuild the source with filtered array
    const before = source.substring(0, arrayStart);
    const after = source.substring(arrayEnd + 1);
    const newArrayStr = JSON.stringify(filtered);
    return before + newArrayStr + after;
}
//# sourceMappingURL=proxyAllFonts.js.map