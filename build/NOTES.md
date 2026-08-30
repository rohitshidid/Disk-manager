# Build notes

Why the packaging is configured the way it is. electron-builder validates its
config against a schema and rejects unknown keys, so this cannot live in
`package.json` next to the settings it explains.

### `asar: false`

The server runs as a **child process** — `process.execPath` with
`ELECTRON_RUN_AS_NODE=1`, pointed at `server/index.js`. A Node child reading its
entry point out of an `asar` archive works, but only through Electron's patched
`fs`, and it turns every path the server derives (`__dirname`, the `public/`
directory it serves) into something that has to be unpacked or rewritten. The
source is public anyway, so the archive buys nothing here.

### `identity: null`

There is no Developer ID on this project, so the DMG is unsigned. electron-builder
still applies an **ad-hoc** signature on arm64 — macOS will not execute an
unsigned arm64 binary at all, which is a different thing from Gatekeeper asking
the user to approve a downloaded app. Users get the "unidentified developer"
prompt; the website and the README both explain the right-click → Open path.

To sign for real later: set `identity` to the Developer ID name (or leave it and
export `CSC_LINK`/`CSC_KEY_PASSWORD`), turn `hardenedRuntime` on, and add
notarization credentials (`APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`,
`APPLE_TEAM_ID`). `build/entitlements.mac.plist` is already written for that
case — including `disable-library-validation`, which the bundled ncdu and its
two dylibs need, since they are ad-hoc signed rather than carrying the app's
team ID.

### `arm64` only

`vendor/bin/ncdu` is vendored from the build machine's Homebrew install, so the
DMG matches the machine that built it. Producing a universal or x64 build means
supplying an x64 ncdu:

```sh
arch -x86_64 /usr/local/bin/brew install ncdu     # on an Intel Homebrew prefix
node build/bundle-ncdu.mjs /usr/local/bin/ncdu
```

then adding `"x64"` (or `"universal"`) to `build.mac.target[0].arch`. Note that
a universal build needs a universal ncdu, which means `lipo -create` over both
copies and re-signing.

### `extraResources`

`vendor/bin` lands at `Contents/Resources/bin`, which is where `electron/main.js`
looks for it and what it passes to the server as `DM_NCDU`. The `lib/` folder
beside the binary holds `libncursesw` and `libzstd`, reached through
`@loader_path` — see `build/bundle-ncdu.mjs`.
