# TODO

Backlog for Disk Manager. Ordered by what actually matters, not by effort.
See `structure.md` for architecture and the invariants any fix must respect.

---

## Blocked on you (needs a human, not code)

- [ ] **Grant Full Disk Access, then confirm a whole-volume scan completes.**
      This is the one thing preventing a complete scan. macOS gates `~/Desktop`,
      `~/Music`, `~/Library/Mobile Documents` (iCloud) and dozens of app
      containers behind privacy consent; without it `openat()` blocks forever
      rather than returning an error, and `sudo` does not help.
      Verify with: `ls ~/Library/Application\ Support/com.apple.TCC/ >/dev/null 2>&1 && echo GRANTED || echo NOT GRANTED`
      As of the last check: **NOT GRANTED**, and the app that needs it is
      **Antigravity IDE.app** (the terminal this runs in), not Terminal.app.
      Once granted, re-run a full scan and record the real total in `README.md`.

- [ ] **Decide whether to commit the repo.** It currently has zero commits.

---

## High priority — known gaps

- [ ] **No UI for the skip list.** `excludes.json` is only surfaced as a toast
      ("N folders were not counted"). Skipped folders distort every total from
      then on, invisibly and permanently. Needs a Settings panel listing them
      with per-row remove, backed by the existing `POST /api/excludes`.
      *This is the most dangerous gap: silently wrong numbers.*

- [ ] **`POST /api/reveal` is a dead endpoint.** Implemented server-side, never
      called. Wire "Reveal in Finder" into the row hover menu, the junk list
      and the Bin — being able to eyeball something before deleting it matters.

- [ ] **No automated tests.** Everything was verified with throwaway scripts in
      a scratchpad. Port the ones that caught real bugs into `test/`:
      - `NcduParser` at 1-byte chunk boundaries, with quotes/brackets in names
      - hardlink dedupe (`hlnkc`) counted once
      - quarantine lifecycle: delete → undo → redo → undo → purge
      - `safety.assess()` matrix, especially the blocked cases
      - `safety.screenTargets()` collapsing nested targets
      - `isSkippable()` refusing volume roots
      - trash round trip: file, directory, name collision, SIP path refused
      - `goneNodes` surviving a later `syncTree()` (a bin+undo cycle must not
        resurrect the bytes of something already trashed)
      Run with `node --test`; no framework needed.

- [ ] **Sweep results are truncated.** `MAX_SURVEY_PROBES=600` / `MAX_CONFIRMS=80`
      cap the blocked-folder sweep, so it reported 4 of 33+ known blockers and
      set `truncated: true`. Root cause: probing every `~/Library/Containers/*/Data`
      individually does not scale. Better approach: recognise that the
      `<app>/Data` shape is *universally* gated without FDA and collapse it to
      one finding, rather than enumerating hundreds.

- [ ] **`condenseBlockers()` never fires for the container pattern.** It needs
      ≥5 blocked children under one parent; container blockers are one per
      parent (`<app>/Data`). Add a shape-based rule alongside the ratio rule.

---

## Medium — correctness and polish

- [ ] **`atime` only for the first 600 rows** of a directory; the rest show `—`
      with no explanation. Either paginate the lookup on scroll or label it.
- [ ] **"Select all" checkbox is not reset on navigation** — it stays checked
      after moving to another folder while the selection has been cleared.
- [ ] **No column sorting.** Always size-descending. Clicking Name / Size /
      Items / Modified / Last used to sort is the obvious expectation.
- [ ] **No per-folder refresh.** Any change means a full rescan. A "Refresh this
      folder" action that re-runs ncdu on one subtree and splices the result
      into the existing `TreeStore` would make the app feel live.
- [ ] **Duplicate finder reports an upper bound.** APFS clones share blocks, so
      deleting one frees nothing. Compare `st_blocks` against apparent size to
      flag likely clones instead of only warning in prose. This matters more now
      that Quick Delete Duplicates can clear every set in one click.
- [ ] **Duplicate hashing is not resumable** and stops at a 60 GB budget with no
      way to continue where it left off.
- [ ] **Hashing runs on the main thread.** Fine today (streaming I/O), but move
      SHA-256 to `worker_threads` before raising the budget.
- [ ] **`scanPromise` is assigned and never read** in `server/index.js` — either
      await it somewhere meaningful or delete it.
- [ ] **Cross-volume deletes are refused by the bin** rather than falling back
      to copy → verify → unlink. "Move to Trash" now handles other volumes (the
      system picks `/Volumes/X/.Trashes/<uid>`), so an external drive can be
      cleaned that way — but the quarantine, and therefore Undo, still cannot
      reach it.

---

## Low — nice to have

- [ ] **Compress the scan cache.** `last-scan.json` is ~145 MB uncompressed.
      ncdu supports `-c` (zstd) and Node ≥23.8 has zstd streams, which should
      cut it by roughly an order of magnitude.
- [ ] **Junk finder hides small fry.** The 1 MB floor means 8,819 `__pycache__`
      directories collapse to the 107 that clear it. Show an aggregate row
      ("+8,712 smaller, 0.2 GB total") so the number is not misleading.
- [ ] **Scan history / diff.** Keep the last few exports and show what grew
      since yesterday — usually the fastest way to find what ate the disk.
- [ ] **Packaging.** Ship as an Electron or menu-bar app so it is not
      `npm start` in a terminal, and so FDA attaches to *its* bundle rather
      than to whichever terminal launched it. Would neatly sidestep the whole
      permissions problem.
- [ ] **Keyboard and accessibility.** Arrow-key row navigation, ARIA labels on
      the treemap tiles, visible focus rings. Only ⌘Z / ⇧⌘Z / `/` / Backspace
      exist today.
- [ ] **Optional auto-purge policy** for bin items older than N days. You chose
      manual purge deliberately; revisit only if the bin gets unwieldy.
- [ ] **Export a report** (CSV or Markdown) of the largest folders.

---

## Done

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
- [x] Stall detection via export growth, highest-fd attribution, two-pass
      confirmation, Full Disk Access recommendation
- [x] Cancel works for root-owned scans (sentinel-file wrapper)
- [x] localhost-only binding, per-run token, `Host` header check
- [x] Move to Trash in every section, via `NSFileManager -trashItemAtURL:` —
      verified for files, directories, names with spaces and quotes, and
      correctly refused for SIP paths
- [x] Quick Delete Duplicates — keeps the oldest copy of each set, trashes the
      rest, one confirmation, list pruned in place without a rescan
- [x] Direct permanent erase (`/api/erase`) alongside the bin and the Trash,
      gated behind a typed `DELETE`
- [x] Hand bin items over to the macOS Trash (`/api/bin/trash`)
- [x] Fixed: purge un-marked its nodes, so the tree handed purged bytes back
- [x] Name TCC refusals properly (`~/Library/Containers` and friends) instead
      of "may be protected, in use, or on a volume with no Trash", and stop
      spending an admin prompt on a refusal root cannot lift
