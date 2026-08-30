# Releasing

**Releasing is one act: changing the version in `package.json`.** Everything
else follows from that automatically.

```sh
./release.sh
```

That is the whole procedure. The rest of this file explains what it does, so
that when something goes wrong you are not reading a black box.

---

## How it works

Releases are driven by the **version**, not by tags you push.

Every push to `main` runs `.github/workflows/release.yml`, which asks one
question: *does a tag `v<version-in-package.json>` already exist?*

* **It exists** — this version is already published. The workflow stops after
  about fifteen seconds. Push as often as you like; a README fix does not cost
  a 121 MB build.
* **It does not exist** — this is a new version. The workflow builds the DMG on
  a clean macOS runner, tags the commit, and publishes a GitHub release with
  the DMG attached.

So the *tag is created by CI*, never locally. That is deliberate: one
mechanism, in one place. A release cannot half-happen because a tag went up
without a build, or a build ran against a commit nobody tagged.

It also means the version bump is the release, wherever you make it — the
script, your editor, or GitHub's web UI. `release.sh` is a safe front door to
that, not a separate mechanism.

```
./release.sh ──> bump package.json ──> commit ──> push
                                                   │
                                                   ▼
                                    workflow: is v1.2.0 tagged?
                                        no ──> test, build DMG,
                                               tag v1.2.0, publish
                                       yes ──> stop, nothing to do
```

## What `./release.sh` does

1. **Refuses to start** if you are not on `main`, the working tree is dirty,
   or `origin/main` has commits you do not. A dirty tree matters more than it
   sounds: whatever is lying around would be swept into the release commit and
   shipped inside the download.
2. **Runs the tests.** A failure stops everything, before anything is changed.
3. **Asks what kind of bump** — patch, minor or major — showing the resulting
   version for each. Pass `patch`, `minor` or `major` as an argument to skip
   the question.
4. **Refuses** if the resulting tag already exists, because CI would silently
   do nothing and you would be watching an Actions tab where nothing happens.
5. Bumps `package.json` and `package-lock.json`, commits `release: vX.Y.Z`,
   pushes.
6. **Watches the build** and prints the download URL when it lands.

```sh
./release.sh                 # ask what to bump
./release.sh patch           # skip the question
./release.sh minor --dry-run # show what would happen, change nothing
```

## What CI does

`.github/workflows/release.yml`, on an Apple-silicon runner:

1. `npm ci`
2. `npm test` — 33 tests
3. `npm run dist` — vendors `ncdu` and its dylibs, draws the icon, packages
   with Electron, ad-hoc signs the bundle
4. **Verifies the bundle**: `codesign --verify --deep --strict`, and that the
   vendored `ncdu` runs with an empty environment. The second check is the
   point of vendoring — it proves the DMG works on a Mac with no Homebrew.
5. Tags the commit and publishes the release with the DMG attached

The asset is always named `DiskManager-arm64.dmg`, with no version in it, so
the website can link to a URL that never changes:

```
https://github.com/rohitshidid/Disk-manager/releases/latest/download/DiskManager-arm64.dmg
```

The version is still visible in the release title, the tag, the mounted DMG's
volume name, and the app's *About Disk Manager* panel.

## One-time repository settings

Both are already done, but if a release ever fails with a permissions error,
check these first:

* **Settings → Actions → General → Workflow permissions** must be
  **Read and write**. Otherwise the publish step gets a 403 after doing all the
  build work.
* **Settings → Pages → Source** is *Deploy from a branch*, `main` / `/docs`.

## When something goes wrong

**The build failed.** Nothing needs rolling back. The version in `package.json`
is already bumped and pushed, and CI will notice that tag is still missing, so
fixing the problem and pushing the fix is enough to trigger it again.

```sh
gh run list --workflow=release.yml --limit 5
gh run view <run-id> --log-failed
```

**The release published but the DMG is broken.** Delete the release *and* its
tag, then push a fix — CI will rebuild the same version:

```sh
gh release delete v1.2.0 --yes --cleanup-tag
git push                       # any commit; CI sees v1.2.0 untagged again
```

**You want to rebuild a version without changing anything.** Actions → Release
→ *Run workflow* → tick **force**. This is how v1.1.0 was published after its
first build failed.

**Nothing happened when I pushed.** The version in `package.json` already has a
tag. That is the intended behaviour — bump the version to release.

### Failures worth recognising

| Symptom | Cause |
|---|---|
| `GitHub Personal Access Token is not set ... GH_TOKEN` | electron-builder tried to publish by itself. `npm run dist` passes `--publish never` to stop it; if that flag is ever dropped, this comes back. |
| `403` on the publish step | Workflow permissions are read-only. See above. |
| `code has no resources but signature indicates they must be present` | The ad-hoc signing step in `build/after-pack.cjs` did not run. On Apple silicon that bundle will not launch at all. |
| ncdu check fails with a dyld error | The vendored dylibs were not relinked to `@loader_path`. See `build/bundle-ncdu.mjs`. |

## Releasing by hand

If CI is unavailable and something has to go out:

```sh
npm test
npm run dist
gh release create v1.2.0 release/DiskManager-arm64.dmg \
  --title "Disk Manager 1.2.0" --generate-notes
```

Remember to bump `package.json` to match in the same commit, or the next push
will try to release that version all over again.
