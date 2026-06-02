(function(window, undefined) {

    window.Asc.plugin.init = function() {};
    window.Asc.plugin.button = function(id) {};

    window.Asc.plugin.onDocumentReady = function() {
        console.log("[FontFilter] Plugin running. Diagnosing frame hierarchy...");

        var current = window;
        for (var depth = 0; depth < 10; depth++) {
            try {
                var hasCommon = !!(current.Common);
                var hasAscFonts = !!(current.AscFonts);
                var hasNotification = !!(current.Common && current.Common.NotificationCenter);
                var hasFontInfos = !!(current.AscFonts && current.AscFonts.g_font_infos);
                var fontCount = hasFontInfos ? current.AscFonts.g_font_infos.length : 0;
                var fontItems = 0;
                try { fontItems = current.document.querySelectorAll('a.font-item').length; } catch(e) {}
                var dropdownItems = 0;
                try { dropdownItems = current.document.querySelectorAll('.dropdown-menu li').length; } catch(e) {}

                console.log("[FontFilter] depth=" + depth +
                    " Common=" + hasCommon +
                    " AscFonts=" + hasAscFonts +
                    " NotificationCenter=" + hasNotification +
                    " g_font_infos=" + fontCount +
                    " fontItemsDOM=" + fontItems +
                    " dropdownLIs=" + dropdownItems
                );

                if (current === current.parent) {
                    console.log("[FontFilter] Reached top at depth " + depth);
                    break;
                }
                current = current.parent;
            } catch(e) {
                console.log("[FontFilter] depth=" + depth + " BLOCKED: " + e.message);
                break;
            }
        }
    };

})(window);
