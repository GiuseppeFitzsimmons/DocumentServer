(function(window, undefined) {

    // Fonts to keep — everything else gets removed from the dropdown
    var ALLOWED_FONTS = [
        'Arial',
        'Times New Roman',
        'Courier New'
    ];

    window.Asc.plugin.init = function() {
        // The plugin runs in the editor's JS context via callCommand
        this.callCommand(function() {
            var allowedFonts = Asc.scope.allowedFonts;
            var allowedSet = {};
            for (var i = 0; i < allowedFonts.length; i++) {
                allowedSet[allowedFonts[i].toLowerCase()] = true;
            }

            // Access the internal font infos array
            var fontInfos = window.AscFonts && window.AscFonts.g_font_infos;
            var mapIndex = window.AscFonts && window.AscFonts.g_map_font_index;

            if (!fontInfos || !mapIndex) {
                console.log('[FontFilter] Could not access font data');
                return;
            }

            // Filter: remove fonts not in allowed list
            // We keep "ASCW3" (internal symbol font) always
            var newInfos = [];
            var newMap = {};
            for (var i = 0; i < fontInfos.length; i++) {
                var info = fontInfos[i];
                var name = info.m_wsFontName || (info.asc_getFontName && info.asc_getFontName());
                if (!name) continue;

                if (name === 'ASCW3' || allowedSet[name.toLowerCase()]) {
                    newMap[name] = newInfos.length;
                    newInfos.push(info);
                }
            }

            // Replace the global arrays
            window.AscFonts.g_font_infos = newInfos;
            window.AscFonts.g_map_font_index = newMap;

            console.log('[FontFilter] Filtered fonts. Remaining: ' + newInfos.length);
        }, false, true, function(result) {
            console.log('[FontFilter] Command completed');
        });
    };

    window.Asc.plugin.button = function(id) {};

    window.Asc.plugin.onDocumentReady = function() {
        // Set scope data that callCommand can access
        Asc.scope.allowedFonts = ALLOWED_FONTS;

        // Run the filter
        this.callCommand(function() {
            var allowedFonts = Asc.scope.allowedFonts;
            var allowedSet = {};
            for (var i = 0; i < allowedFonts.length; i++) {
                allowedSet[allowedFonts[i].toLowerCase()] = true;
            }

            var fontInfos = window.AscFonts && window.AscFonts.g_font_infos;
            var mapIndex = window.AscFonts && window.AscFonts.g_map_font_index;

            if (!fontInfos || !mapIndex) {
                console.log('[FontFilter] Could not access font data');
                return;
            }

            var newInfos = [];
            var newMap = {};
            for (var i = 0; i < fontInfos.length; i++) {
                var info = fontInfos[i];
                var name = info.m_wsFontName || (info.asc_getFontName && info.asc_getFontName());
                if (!name) continue;

                if (name === 'ASCW3' || allowedSet[name.toLowerCase()]) {
                    newMap[name] = newInfos.length;
                    newInfos.push(info);
                }
            }

            window.AscFonts.g_font_infos = newInfos;
            window.AscFonts.g_map_font_index = newMap;

            console.log('[FontFilter] Filtered fonts on document ready. Remaining: ' + newInfos.length);
        }, false, true);
    };

})(window);
