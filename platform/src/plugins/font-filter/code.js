(function(window, undefined) {

    window.Asc.plugin.init = function() {};
    window.Asc.plugin.button = function(id) {};

    window.Asc.plugin.onDocumentReady = function() {
        this.callCommand(function() {
            // Hardcoded allowed fonts — everything else gets removed
            var allowedFonts = ['Arial', 'Times New Roman', 'Courier New'];
            var allowedSet = {};
            for (var i = 0; i < allowedFonts.length; i++) {
                allowedSet[allowedFonts[i].toLowerCase()] = true;
            }

            var fontInfos = window.AscFonts && window.AscFonts.g_font_infos;
            var mapIndex = window.AscFonts && window.AscFonts.g_map_font_index;

            if (!fontInfos || !mapIndex) {
                return;
            }

            var newInfos = [];
            var newMap = {};
            for (var i = 0; i < fontInfos.length; i++) {
                var info = fontInfos[i];
                var name = info.m_wsFontName;
                if (!name && info.asc_getFontName) name = info.asc_getFontName();
                if (!name) continue;

                if (name === 'ASCW3' || allowedSet[name.toLowerCase()]) {
                    newMap[name] = newInfos.length;
                    newInfos.push(info);
                }
            }

            window.AscFonts.g_font_infos = newInfos;
            window.AscFonts.g_map_font_index = newMap;
        }, false, true);
    };

})(window);
