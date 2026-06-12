// nginx njs script to intercept EPUB download requests from DocumentServer
// and redirect them to the platform's Pandoc-based epub exporter.
//
// DS epub downloads hit: /{version}/downloadas/{docKey}?cmd={json}
// where cmd JSON contains "outputformat":72 for EPUB.
// The docKey format is "{fileId}_{timestamp}".

function interceptEpub(r) {
    var cmd = r.args.cmd;
    if (!cmd) {
        r.internalRedirect('@downloadas_backend');
        return;
    }

    try {
        var parsed = JSON.parse(cmd);

        // outputformat 72 = EPUB (0x0040 + 0x0008)
        if (parsed.outputformat !== 72) {
            r.internalRedirect('@downloadas_backend');
            return;
        }

        // Extract the document key from the cmd
        var docKey = parsed.id;
        if (!docKey) {
            r.internalRedirect('@downloadas_backend');
            return;
        }

        // Document key format: "{fileId}_{timestamp}" - extract the fileId
        var lastUnderscore = docKey.lastIndexOf('_');
        if (lastUnderscore === -1) {
            r.internalRedirect('@downloadas_backend');
            return;
        }

        var fileId = docKey.substring(0, lastUnderscore);

        // Proxy to the platform's epub exporter (subrequest)
        r.internalRedirect('/internal-epub-export/' + fileId);

    } catch (e) {
        // JSON parse failed, pass through
        r.internalRedirect('@downloadas_backend');
    }
}

export default { interceptEpub };
