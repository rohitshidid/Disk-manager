# TODO

The roadmap for Disk Manager, ordered by what actually matters rather than by
effort. See `structure.md` for the architecture and the invariants any fix has
to respect — several items below are easy to implement in a way that quietly
breaks one of them.

Every item says **what**, **why it is worth doing**, and **done when** — because
"add snapshot support" is not a task, it is a heading.

**Legend:** `P1` finish what is half-built · `P2` correctness and trust ·
`P3` new capability · `P4` interface · `P5` platform.

---

## Blocked on you (needs a human, not code)

- [ ] **Grant Full Disk Access to the packaged app, then confirm a whole-volume
      scan completes.** This is still the one thing standing between the app and
      a complete number. macOS gates `~/Desktop`, `~/Music`,
      `~/Library/Mobile Documents` (iCloud) and dozens of app containers behind
      privacy consent; without it `openat()` blocks forever rather than
      returning an error, and `sudo` does not help.

      Verify with:
      ```sh
      ls ~/Library/Application\ Support/com.apple.TCC/ >/dev/null 2>&1 && echo GRANTED || echo NOT GRANTED
      ```

      As of 2026-08-21 this was **NOT GRANTED**, and the app that needed it was
      **Antigravity IDE.app** — the terminal the source version runs inside, not
      Terminal.app. The desktop build changes this: consent now attaches to
      *Disk Manager.app* itself, which is one of the main reasons it exists.
      Once granted, run a full scan and record the real total in `README.md`.

- [ ] **Decide whether to sign and notarize.** The DMG is currently unsigned, so
      every download needs a right-click → Open. An Apple Developer account
      ($99/yr) removes that. `build/entitlements.mac.plist` and
      `build/NOTES.md` already describe exactly what to switch on.

---

## Shipped

Kept for context — these were built and verified against real data.

- [x] Scan `/System/Volumes/Data` rather than `/`, display canonical paths
- [x] Stream-parse ncdu's JSON export; 1.35M nodes in **41 MB RSS**
- [x] Treemap + drill-down list, size/age filters, whole-tree search
- [x] Reversible delete via same-volume quarantine + persistent manifest
- [x] Undo / redo across whole operations (verified: 107 folders, one step)
- [x] Live reclaim counter and free-space projection (verified: 113 → 114 GB)
- [x] Purge gated behind a typed `DELETE`
- [x] Safety guardrails: SIP paths, volume roots, `$HOME`, own quarantine
- [x] Junk finder — found 19.7 GB here; nested hits de-duplicated
- [x] Duplicate finder — size groups → head hash → full hash
- [x] Stall detection: export-growth liveness, highest-fd attribution, two-pass
      confirmation, Full Disk Access recommendation
- [x] Cancel works for root-owned scans (sentinel-file wrapper)
- [x] localhost-only binding, per-run token, `Host` header check
- [x] Move to Trash everywhere, via `NSFileManager -trashItemAtURL:`
- [x] Quick Delete Duplicates — keeps the oldest copy of each set
- [x] Direct permanent erase (`/api/erase`), gated behind a typed `DELETE`
- [x] Hand bin items over to the macOS Trash (`/api/bin/trash`)
- [x] Name the files each removal touched; session record of what went to Trash
- [x] Roll `Modified` and `Last used` up the subtree; `~` marks a truncated walk
- [x] Column sorting, with missing values always sorting last
- [x] **Per-folder refresh** — `FolderRefresher` + `TreeStore.spliceSubtree()`
      wired to `POST /api/refresh` and a Refresh button, with progress, cancel,
      and a toast reporting the delta against the scan
- [x] **Skip-list panel** — the ⚙︎ dialog lists every exclude with per-row
      remove, backed by `POST /api/excludes`, and can rescan on save. Until now
      the skip list was mentioned only in a toast and could not be undone
- [x] **Reveal in Finder and Quick Look** on Explore rows, junk items and
      duplicate rows, plus <kbd>space</kbd> on the focused row
- [x] **Test suite** — 33 tests under `node --test`, covering the parser at
      1-byte chunk boundaries, hardlink dedupe, the mtime rollup, splice
      arithmetic, the `assess()` matrix, `screenTargets()` nesting, the
      quarantine lifecycle against a real filesystem, and the excludes guard
- [x] **Desktop app + DMG** — Electron bundle with Node and `ncdu` inside, an
      icon drawn at build time, ad-hoc signing, and a GitHub Actions workflow
      that publishes the DMG on a tag
- [x] **Website** — `docs/` served by GitHub Pages, download button pointing at
      the latest release asset
- [x] Fixed: `assess()` blocked the quarantine's *ancestors* but not paths
      *inside* it, so a quarantined item browsed in Explore could be re-binned,
      leaving the manifest pointing at a path that had moved
- [x] Fixed: `measureDir()` ran `du` synchronously inside a request handler,
      stopping the whole server — progress polling included — for as long as the
      measurement took
- [x] Fixed: "Select all" stayed ticked after navigating to another folder,
      claiming a selection that had just been cleared
- [x] Removed `scanPromise`, which was assigned three times and never read

---

## P1 — finish what is half-built

- [ ] **Sweep results are truncated.** `MAX_SURVEY_PROBES=600` /
      `MAX_CONFIRMS=80` cap the blocked-folder sweep, so it reported 4 of 33+
      known blockers and set `truncated: true`. Root cause: probing every
      `~/Library/Containers/*/Data` individually does not scale.
      *Better approach:* recognise that the `<app>/Data` shape is universally
      gated without FDA and collapse it to one finding rather than enumerating
      hundreds. **Done when:** a sweep on a machine without FDA reports every
      blocked location, or one collapsed finding per pattern, without setting
      `truncated`.

- [ ] **`condenseBlockers()` never fires for the container pattern.** It needs
      ≥5 blocked children under one parent; container blockers are one per
      parent (`<app>/Data`). Add a shape-based rule alongside the ratio rule.
      **Done when:** 31 blocked group containers collapse to one entry, while a
      directory where only a minority block still lists them individually — the
      existing behaviour that stops 112 readable containers vanishing from the
      totals.

---

## P2 — correctness and trust

These are the ones where the app currently shows a number that is wrong, or
could remove something without understanding what it is removing.

- [ ] **Purgeable space and local snapshots.** `df` avail is not the truth on
      APFS: Time Machine local snapshots hold gigabytes that macOS reports as
      free-ish and reclaims under pressure. On most Macs this is the single
      largest block of recoverable space, and the app cannot currently see it at
      all. Read `tmutil listlocalsnapshots /` and show the gap between what
      `df` says and what is actually available, with a way to thin them.
      **Done when:** the status bar can explain the difference between free and
      purgeable, and a snapshot can be deleted from the UI with the same
      confirmation weight as a purge.

- [ ] **iCloud dataless files.** A file evicted to iCloud has an apparent size
      but occupies almost nothing on disk, and deleting it deletes it from the
      cloud too. Today the app would happily bin one and free nothing, having
      told the user it would free 4 GB. Detect `SF_DATALESS` (`st_flags`) and
      both exclude those bytes from the reclaim projection and warn before
      removal. **Done when:** a dataless file shows its real on-disk cost and
      removing one carries its own confirmation.

- [ ] **Duplicate finder reports an upper bound.** APFS clones share blocks, so
      deleting one copy frees nothing. Compare `st_blocks` against apparent size
      to flag likely clones instead of only warning in prose. This matters more
      now that Quick Delete Duplicates can clear every set in one click.
      **Done when:** a cloned pair is labelled as such and excluded from the
      "recoverable" total.

- [ ] **Persistent audit log.** The Trash record is deliberately session-scoped
      (invariant 6) and that is right — but "what did I delete last Tuesday" is
      a different question, and one this app can answer honestly because it is
      recording its own actions rather than describing a Trash it has not
      looked at. Append JSONL to `~/Library/Application Support/DiskManager/`.
      **Done when:** every removal, restore and purge is recorded with path,
      size, destination and time, and the log is readable from the Bin tab.

- [ ] **`atime` still stops at the first 600 rows** of a directory, and at a
      30,000-stat budget; rows past that show `—` with no explanation. Folders
      that were measured but truncated say so with a `~`, so only the
      never-measured rows are still silent. Paginate the lookup on scroll.

- [ ] **Duplicate hashing is not resumable** and stops at a 60 GB budget with no
      way to continue where it left off.

- [ ] **Hashing runs on the main thread.** Fine today (streaming I/O), but move
      SHA-256 to `worker_threads` before raising the budget.

- [ ] **Cross-volume deletes are refused by the bin** rather than falling back
      to copy → verify → unlink. "Move to Trash" already handles other volumes
      (the system picks `/Volumes/X/.Trashes/<uid>`), so an external drive can
      be cleaned that way — but the quarantine, and therefore Undo, cannot reach
      it. **Done when:** binning something on an external drive works, and the
      copy is verified before the original is unlinked.

- [ ] **Compress the scan cache.** `last-scan.json` is ~250 MB uncompressed here
      and grows with the tree. ncdu supports `-c` (zstd) and Node ≥23.8 has zstd
      streams, which should cut it by roughly an order of magnitude.

---

## P3 — new capabilities

- [ ] **Application uninstaller.** Group an `.app` with everything it left
      behind — `~/Library/Containers`, `Application Support`, `Preferences`,
      `Caches`, `Logs`, `Saved Application State`, `LaunchAgents` — by bundle
      ID, and remove them as one reversible unit. The tree is already in memory,
      so this is one pass plus an `Info.plist` read per app.
      **Done when:** selecting an app shows every associated path with its size,
      and binning the group is one undoable operation.

- [ ] **Duplicate *folders*, not just files.** Hash a directory from its
      children's hashes and identical trees fall out — copied project folders,
      double-imported photo libraries, `Documents` restored twice from a backup.
      Usually a larger win than file-level duplicates and a much easier decision
      for the user, because the answer is "this whole folder is a copy of that
      one". **Done when:** identical directory trees are reported as single
      rows, with nested duplicates collapsed into their outermost parent.

- [ ] **Safe vendor cleanups.** Offer `brew cleanup`, `docker system prune`,
      `xcrun simctl delete unavailable`, `npm cache clean` as first-class
      actions rather than deleting those directories by hand. Safer (the tool
      knows what it can spare) and usually reclaims more.
      **Done when:** each is a row in the Junk tab showing a dry-run estimate
      before it runs, and its output is shown afterwards.

- [ ] **Scan history and diff.** Keep the last few exports and show what grew
      since yesterday — usually the fastest route to whatever ate the disk.
      The cache already exists; this is mostly a second `TreeStore` and a walk.
      **Done when:** a Changes view lists the largest growth and shrinkage
      between two scans, by folder.

- [ ] **Multi-volume support.** A volume picker covering external drives and
      other APFS volumes, with the cross-volume quarantine from P2 so Undo works
      there too. **Done when:** an external drive can be scanned, browsed and
      cleaned with the same three destinations as the boot volume.

- [ ] **Near-duplicate media.** Perceptual hashing for photos and video, where
      byte-identical matching finds nothing but the savings are real — the same
      shot exported twice at different quality. Its own project; keep it behind
      a clearly-labelled "these are similar, not identical" heading, and never
      pre-select anything.

- [ ] **Type breakdown.** Roll sizes up by kind — video, photos, audio,
      archives, code, disk images — and let the treemap filter by it.
      **Done when:** the Explore tab can answer "how much of this is video"
      without a search.

---

## P4 — interface

- [ ] **Keyboard and accessibility.** Arrow-key row navigation, ARIA labels on
      treemap tiles, visible focus rings, a focus ring that survives re-render.
      Today: <kbd>⌘Z</kbd>, <kbd>⇧⌘Z</kbd>, <kbd>/</kbd>, <kbd>space</kbd>,
      <kbd>backspace</kbd>.

- [ ] **Proactive Full Disk Access onboarding.** Run the `com.apple.TCC`
      readability probe at startup and guide the grant, instead of discovering
      the problem 25 seconds into a wedged scan. In the packaged app this is
      near-conclusive, because consent attaches to the bundle rather than to
      whatever launched it. **Done when:** first run without FDA shows a single
      explanatory screen with a button, not a stalled progress bar.

- [ ] **Undo history panel.** The stacks exist and survive restarts; the UI
      exposes only their top. Show the list, with what each operation touched.

- [ ] **Protected paths.** A user-maintained "never suggest this" list, so the
      junk finder stops proposing the one cache you actually need.

- [ ] **Junk finder hides small fry.** The 1 MB floor means 8,819 `__pycache__`
      directories collapse to the 107 that clear it. Show an aggregate row
      ("+8,712 smaller, 0.2 GB total") so the number is not misleading.

- [ ] **Optional auto-purge policy** for bin items older than N days. Manual
      purge was chosen deliberately; revisit only if the bin gets unwieldy.

- [ ] **Export a report** (CSV or Markdown) of the largest folders, so a scan
      can be handed to somebody else or diffed by hand.

---

## P5 — platform

- [ ] **Menu-bar mode.** A small resident presence with free-space watch and a
      notification when the volume drops below a threshold. The Electron shell
      makes this cheap now.

- [ ] **Sign and notarize.** See "Blocked on you". Removes the right-click →
      Open dance for every user who downloads the DMG.

- [ ] **Universal / Intel build.** `vendor/bin/ncdu` currently comes from the
      build machine's Homebrew, so the DMG is arm64-only. An x64 build needs an
      x64 ncdu; a universal one needs `lipo -create` over both and a re-sign.
      See `build/NOTES.md`.

- [ ] **Headless CLI / JSON mode.** `disk-manager scan --json` so a scan can be
      scripted, diffed or run on a schedule without the window.

- [ ] **Scheduled scans.** A weekly background scan feeding the P3 diff view, so
      "what grew this week" is answered before it is asked.
