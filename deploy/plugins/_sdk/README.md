# Self-hosted OnlyOffice plugin SDK

Vendored copies of the editor plugin SDK runtime so plugins load same-origin
instead of from `onlyoffice.github.io`. This keeps plugin loading on
EuroBureau's own infrastructure (privacy, availability, supply-chain control).

Files under `v1/` (`plugins.js`, `plugins-ui.js`, `plugins.css`) are OnlyOffice's
plugin SDK (AGPL/Apache, same licence as the Document Server), fetched from
`https://onlyoffice.github.io/sdkjs-plugins/v1/`.

They are COPYed into the Document Server image at
`sdkjs-plugins/v1/` (see `deploy/Dockerfile.documentserver`) and served through
the existing nginx `/sdkjs-plugins/` proxy. Plugins reference them at
`/sdkjs-plugins/v1/<file>`.

## Updating

When bumping the Document Server version, re-fetch these to match the editor's
expected plugin API version:

    curl -sL https://onlyoffice.github.io/sdkjs-plugins/v1/plugins.js    -o v1/plugins.js
    curl -sL https://onlyoffice.github.io/sdkjs-plugins/v1/plugins-ui.js -o v1/plugins-ui.js
    curl -sL https://onlyoffice.github.io/sdkjs-plugins/v1/plugins.css   -o v1/plugins.css
