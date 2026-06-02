(function(window, undefined) {

    window.Asc.plugin.init = function() {
        console.log("[FontFilter] init called");

        var current = window;
        for (var depth = 0; depth < 10; depth++) {
            try {
                var hasCommon = !!(current.Common);
                var hasAscFonts = !!(current.AscFonts);
                var hasFontInfos = !!(current.AscFonts && current.AscFonts.g_font_infos);
                var fontCount = hasFontInfos ? current.AscFonts.g_font_infos.length : 0;
                var fontItems = 0;
                try { fontItems = current.document.querySelectorAll('a.font-item').length; } catch(e) {}

                console.log("[FontFilter] depth=" + depth +
                    " Common=" + hasCommon +
                    " AscFonts=" + hasAscFonts +
                    " g_font_infos=" + fontCount +
                    " fontItemsDOM=" + fontItems
                );

                if (current === current.parent) break;
                current = current.parent;
            } catch(e) {
                console.log("[FontFilter] depth=" + depth + " BLOCKED: " + e.message);
                break;
            }
        }
    };

    window.Asc.plugin.button = function(id) {};

})(window);
