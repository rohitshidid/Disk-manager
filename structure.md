# Project structure

Visual disk-usage explorer for macOS with reversible deletes. Zero runtime
dependencies — Node's standard library plus the `ncdu` binary.

```
Disk manager/
├── package.json          npm start → server/index.js (no deps)
├── README.md             user-facing guide: how it works, why, gotchas
├── structure.md          this file — architecture and invariants
├── TODO.md               backlog
├── server/               Node backend (~1,650 lines)
│   ├── index.js   (520)  HTTP server, routes, auth, tree↔quarantine sync
│   ├── scanner.js (425)  ncdu process, live tailing, stall detection
│   ├── quarantine.js(342) delete / undo / redo / restore / purge + manifest
│   ├── tree.js    (335)  TreeStore (typed arrays) + NcduParser (streaming)
│   ├── dupes.js   (175)  duplicate finder (size → head hash → full hash)
│   ├── junk.js    (148)  rules for caches, build artefacts, package stores
│   ├── util.js     (76)  paths, formatting, df, shell quoting
│   ├── safety.js   (74)  deletion blocklist and risk assessment
│   └── elevate.js  (43)  one native admin prompt per batch
└── public/               frontend, vanilla ES modules (~1,260 lines)
    ├── app.js     (747)  all UI logic and state
    ├── styles.css (300)  theme-aware styling, light + dark
    ├── index.html (164)  markup shell; `__TOKEN__` is substituted at serve time
    └── treemap.js  (53)  squarified treemap layout
```

---

## Data flow

### Scanning

```
POST /api/scan
  └─ Scanner.start()
       ├─ pre-create last-scan.json mode 0666   (so a root-owned ncdu can be tailed)
       ├─ spawn ncdu -x -e -0 [--exclude …] -o last-scan.json /System/Volumes/Data
       │    wrapped in a /bin/sh loop that polls a cancel sentinel file, so Cancel
       │    works even when ncdu runs as root and we cannot signal it
       └─ _tail() reads newly-appended bytes every 200 ms
            └─ NcduParser.write(chunk)  →  TreeStore.add(...)
                 └─ on completion: TreeStore.aggregate()   (one reverse pass)
```

The export is tailed rather than piped because an elevated child cannot stream
through a pipe we own, and one code path serves both privileged and plain runs.

### Deleting

```
UI selection
  └─ POST /api/assess          risk verdict per path, no side effects
  └─ confirm dialog            typed DELETE for `danger`
  └─ POST /api/delete
       └─ Quarantine.deleteMany()
            ├─ safety.assess()            blocked paths refused outright
            ├─ drop targets nested inside other targets
            ├─ sameVolume() check         a rename must stay on one volume
            └─ performMoves()
                 ├─ fs.rename() unprivileged where possible
                 └─ one runElevated() batch for whatever returned EACCES/EPERM
       └─ syncTree()           subtract sizes from ancestors, no rescan needed
```

Undo/redo move whole operations between `undoStack` and `redoStack`. Purge is
the only irreversible action and clears both.

---

## Module notes

### `tree.js` — the filesystem in typed arrays

A scan of this Mac is ~1.35M inodes for `~/Documents` alone. One JS object per
node would be gigabytes; parallel typed arrays hold 1.35M nodes in **41 MB RSS**.

| Array | Type | Meaning |
|---|---|---|
| `parent`, `firstChild`, `lastChild`, `nextSib` | `Int32Array` | tree links, `-1` = none |
| `ownD`, `ownA` | `Float64Array` | this node's own disk / apparent size |
| `subD`, `subA` | `Float64Array` | subtree totals after `aggregate()` |
| `subItems`, `childCount` | `Uint32Array` | counts |
| `mtime` | `Uint32Array` | unix seconds |
| `flags` | `Uint8Array` | `F_DIR 1`, `F_ERR 2`, `F_HLDUP 4`, `F_DELETED 8`, `F_NOTREG 16` |
| `nameOff`, `nameLen` + `nameBuf` | `Uint32/Uint16` + `Buffer` | names in one buffer |

Children always get a higher index than their parent, so `aggregate()` is a
single reverse loop. `nameIs()` compares bytes without allocating a string —
that is what makes the junk sweep over every node cost ~50 ms.

`NcduParser` is an incremental parser for ncdu's format
`[1, 2, {meta}, [ {dir}, {file}, [ {subdir}, … ] ]]`. A full-volume export is
hundreds of MB, past what `JSON.parse` accepts, so it scans for structural
characters while tracking string/escape state and `JSON.parse`s one object at a
time. A partial object at a chunk boundary is retained and re-scanned from its
start. Verified at 1-byte chunk sizes with quotes and brackets in filenames.

### `scanner.js` — stall detection

macOS blocks `openat()` **forever** on folders it is withholding privacy
consent for. This subsystem exists entirely to survive that.

- **Liveness = export file growth**, set in `_tail()`. Not the item counter,
  which only ticks every 2,000 items and would make a slow region of large
  files look identical to a block.
- `ncduOpenDir()` picks the **highest numbered file descriptor**, not the
  longest path. ncdu opens directories as it descends, so the highest fd is the
  deepest. Path length is useless: firmlinks make the scan root
  `/System/Volumes/Data` a longer string than `/Users/you` beneath it.
- `findBlockedChild()` probes children in killable `ls` subprocesses. A first
  pass at 3 s produces *suspects*; each is re-probed alone at 12 s before being
  named, because a scan saturating the disk makes ordinary folders look slow.
- `surveyBlockers()` sweeps common hotspots two levels deep (sandbox containers
  gate at `<app>/Data`) so the user is interrupted once instead of per folder.

### `quarantine.js`

Deletes are renames into `~/Library/Application Support/DiskManager/quarantine/<id>/<name>`
— instant at any size and exactly reversible. `manifest.json` records the
original path and survives restarts. `_reconcile()` on startup drops entries
whose quarantined copy vanished, so the UI never promises an undo it cannot
deliver. Restores never clobber: if the original name is taken, the item lands
beside it as `name (restored <timestamp>)`.

### `safety.js`

`assess()` returns `blocked` / `danger` / `caution` / `ok`. Blocked covers SIP
trees, volume roots, `$HOME` itself, and any path containing the app's own
quarantine. `danger` = outside `/Users` (typed confirmation). `caution` = over
1 GiB or over 10,000 files.

### `dupes.js`

Different sizes cannot be duplicates, so grouping by size discards almost
everything for free. Only same-size groups are hashed: 64 KB head first, full
file only for what still collides. Largest potential savings first, so useful
results arrive before any budget runs out.

---

## HTTP API

All `/api/*` calls require the `x-dm-token` header. The token is minted per
process run and substituted into `index.html` at serve time.

| Route | Purpose |
|---|---|
| `GET  /api/state` | scan progress, quarantine summary, disk usage, excludes |
| `POST /api/scan` | start a scan (`{root, elevated}`) |
| `POST /api/scan/cached` | re-parse the previous export (~2 s vs a full rescan) |
| `POST /api/scan/cancel` | writes the cancel sentinel |
| `POST /api/scan/skip` | add one folder to the skip list, then rescan |
| `POST /api/scan/find-blockers` | sweep for blocked folders — **reports only** |
| `POST /api/scan/apply-blockers` | commit the last sweep's findings |
| `POST /api/excludes` | overwrite the skip list |
| `GET  /api/dir?path=` | one directory: children, crumbs, atimes |
| `GET  /api/search` | name / size / age query across the tree |
| `GET  /api/junk` | junk categories |
| `POST`/`GET`/`POST` `/api/dupes[/cancel]` | duplicate finder |
| `POST /api/assess` | risk verdicts, no side effects |
| `POST /api/delete` | quarantine a batch |
| `POST /api/undo` · `/api/redo` | move an operation between stacks |
| `POST /api/restore` · `/api/purge` | per-item restore; irreversible erase |
| `POST /api/privacy-settings` | open the Full Disk Access pane |
| `POST /api/reveal` | reveal a path in Finder — *not yet called by the UI* |

---

## On-disk state

`~/Library/Application Support/DiskManager/`

| File | Purpose |
|---|---|
| `quarantine/<id>/<name>` | deleted items, awaiting restore or purge |
| `manifest.json` | entries + `undoStack` / `redoStack`; survives restarts |
| `last-scan.json` | raw ncdu export, reused for instant reload (~145 MB) |
| `excludes.json` | folders to skip; reapplied to every scan |
| `.scan-cancel` | sentinel polled by the elevated scan wrapper |

---

## Tuning constants

| Constant | Value | File |
|---|---|---|
| `STALL_MS` | 25 s with no export growth | `scanner.js` |
| `FIRST_PASS_MS` / `CONFIRM_MS` | 3 s suspect / 12 s verdict | `scanner.js` |
| `MAX_SURVEY_DEPTH` | 2 | `scanner.js` |
| `MAX_SURVEY_PROBES` / `MAX_CONFIRMS` | 600 / 80 | `scanner.js` |
| `MAX_NODES` | 12,000,000 | `tree.js` |
| `CHUNK` | 64 KB head hash | `dupes.js` |
| `BIG_BYTES` / `MANY_ITEMS` | 1 GiB / 10,000 | `safety.js` |

---

## Invariants — do not break these

1. **Never call `fs.readdir`/`fs.stat` on a path that might be gated.** They
   have no timeout and block forever on exactly the folders we are trying to
   identify. Use `lsDir()`, which spawns a killable subprocess. This was a real
   bug: it hung the API precisely when the UI needed to explain the hang.
2. **Never await stall diagnosis in a request handler.** `maybeDiagnoseStall()`
   runs in the background, at most once per stall episode; the answer appears
   on a later poll.
3. **An exclude can never be at or above a volume root.** `isSkippable()`
   enforces it; otherwise every later scan silently returns nothing.
4. **Only purge unlinks.** Every other path is a rename that can be walked back.
5. **One admin prompt per batch**, never per file. The server itself never runs
   as root.
6. **Register both path forms when excluding** — `lsof` reports firmlinked
   `/Users/...` while ncdu walks `/System/Volumes/Data/Users/...`.
7. **Rejected promises must be caught** in scan start paths; an unhandled
   rejection is fatal in Node and would take the server down mid-delete.
8. **`sudo` ≠ privacy consent.** Root reaches other users' files; only Full
   Disk Access reaches `~/Desktop`, `~/Music`, iCloud Drive and app containers.
