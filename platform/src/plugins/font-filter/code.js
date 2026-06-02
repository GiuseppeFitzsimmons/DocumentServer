(function(window, undefined) {

    window.Asc.plugin.init = function() {
        // We know init fires (proven by the earlier TypeError).
        // callCommand runs in editor model context and CAN access AscFonts.
        // Problem: mutating g_font_infos doesn't update the already-rendered combobox.
        // Solution: We need to also trigger the UI to re-render with filtered data.

        this.callCommand(function() {
            // This runs inside the editor's SDK context
            var allowedFonts = ['arial', 'times new roman', 'courier new'];
            var allowedSet = {};
            for (var i = 0; i < allowedFonts.length; i++) {
                allowedSet[allowedFonts[i]] = true;
            }

            // Filter g_font_infos
            var fontInfos = window.AscFonts && window.AscFonts.g_font_infos;
            if (!fontInfos) return 'no fontInfos';

            var newInfos = [];
            var newMap = {};
            for (var i = 0; i < fontInfos.length; i++) {
                var info = fontInfos[i];
                var name = info.m_wsFontName;
                if (!name) continue;
                if (name === 'ASCW3' || allowedSet[name.toLowerCase()]) {
                    newMap[name] = newInfos.length;
                    newInfos.push(info);
                }
            }

            window.AscFonts.g_font_infos = newInfos;
            window.AscFonts.g_map_font_index = newMap;

            // Now try to trigger a re-render of the font UI
            // The editor sends fonts to UI via asc_onInitEditorFonts
            // We can re-fire that event with filtered data
            var editor = window.Asc && window.Asc.editor;
            if (editor && editor.sendEvent) {
                // Build gui_fonts array matching what asc_onInitEditorFonts expects
                var guiFonts = [];
                for (var i = 0; i < newInfos.length; i++) {
                    if (newInfos[i].m_wsFontName === 'ASCW3') continue;
                    guiFonts.push(newInfos[i]);
                }
                editor.sendEvent('asc_onInitEditorFonts', guiFonts);
                return 're-fired asc_onInitEditorFonts with ' + guiFonts.length + ' fonts';
            }

            return 'filtered g_font_infos to ' + newInfos.length + ' but no editor to re-fire event';
        }, false, true);
    };

    window.Asc.plugin.button = function(id) {};

})(window);
