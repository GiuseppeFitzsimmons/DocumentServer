// nginx njs script to intercept EPUB download requests from DocumentServer.
// Sets $epub_file_id variable if the request is an epub download.
// nginx config uses this to conditionally route to the platform exporter.

function extractEpubFileId(r) {
    var cmd = r.args.cmd;
    if (!cmd) return '';

    try {
        var parsed = JSON.parse(cmd);
        if (parsed.outputformat !== 72) return '';

        var docKey = parsed.id;
        if (!docKey) return '';

        var lastUnderscore = docKey.lastIndexOf('_');
        if (lastUnderscore === -1) return '';

        return docKey.substring(0, lastUnderscore);
    } catch (e) {
        return '';
    }
}

export default { extractEpubFileId };
