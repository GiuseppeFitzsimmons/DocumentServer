# DS "develop" image

Compiles our mounted `sdkjs` / `web-apps` / `sdkjs-forms` against the prebuilt
core from the official documentserver image. No C++/Qt build.

Purpose: validate from-source JS changes (e.g. an sdkjs cursor-position method)
without owning the full DS build. Not a prod image — bases on the official
`onlyoffice/documentserver` layout, not the Euro-Office fork.

## 1. Build the image (one-time, ~2.5GB pull on slow link)

```
docker build --no-cache \
  --build-arg DOCUMENTSERVER_IMAGE=onlyoffice/documentserver:latest \
  --build-arg BUILDTOOLS_BRANCH=master \
  -t documentserver-develop deploy/build-ds-develop
```

## 2. Run (first run compiles mounted modules, ~15-20 min)

```
bash deploy/build-ds-develop/run.sh
```

Serves the test editor at http://localhost/example. Port 80 must be free
(dev stack nginx uses 8000, so no conflict).

## Notes

- Mounted `sdkjs` is non-minified source, so symbol names are NOT mangled —
  injected methods (e.g. `pluginMethod_EOGetCursor`) keep their names after
  compile.
- `run_build_js.py` auto-detects addons, so mounted `sdkjs-forms` is picked up.
- Grunt rewrites mounted files in place (inode change); re-run `run.sh` to
  pick up fresh edits (image is `--rm`, so just stop and start again).
- Version note: `latest` + build_tools `master` are matched to each other.
  Matching prod's 9.3.1 is a separate concern — do that only after the
  from-source path is proven here.
