# Project structure

Visual disk-usage explorer for macOS with reversible deletes. Zero runtime
dependencies — Node's standard library plus the `ncdu` binary.

```
Disk manager/
├── package.json          npm start → server/index.js (no deps)
├── README.md             user-facing guide: how it works, why, gotchas
├── structure.md          this file — architecture and invariants
├── TODO.md               backlog
├── server/               Node backend (~2,700 lines)
│   ├── index.js   (770)  HTTP server, routes, auth, tree↔quarantine sync
│   ├── scanner.js (463)  ncdu process, live tailing, stall detection
│   ├── refresh.js (165)  re-measure one folder and splice it into the tree
│   ├── quarantine.js(373) delete / undo / redo / restore / purge + manifest
│   ├── dispose.js  (210) macOS Trash + permanent erase
│   ├── tree.js    (345)  TreeStore (typed arrays) + NcduParser (streaming)
│   ├── dupes.js   (175)  duplicate finder (size → head hash → full hash)
│   ├── junk.js    (148)  rules for caches, build artefacts, package stores
│   ├── util.js     (76)  paths, formatting, df, shell quoting
│   ├── safety.js  (157)  blocklist, risk assessment, batch screening, TCC
│   └── elevate.js  (43)  one native admin prompt per batch
├── public/               frontend, vanilla ES modules (~1,900 lines)
│   ├── app.js    (1240)  all UI logic and state
│   ├── styles.css (355)  theme-aware styling, light + dark
│   ├── index.html (215)  markup shell; `__TOKEN__` is substituted at serve time
│   └── treemap.js  (53)  squarified treemap layout
├── electron/             desktop shell
│   └── main.js           starts the server as a child, opens the window
├── build/                packaging
│   ├── make-icon.mjs     draws icon.icns — rasteriser + PNG encoder, no deps
│   ├── bundle-ncdu.mjs   vendors ncdu + dylibs, relinks to @loader_path
│   ├── after-pack.cjs    ad-hoc signs the packed bundle
│   ├── entitlements.mac.plist
│   └── NOTES.md          why the packaging is configured this way
├── test/                 node --test, 33 tests, no framework
└── docs/                 the website, served by GitHub Pages
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

### Removing

Three destinations share one front half. `screenTargets()` is the single gate:
it refuses blocked paths, demands confirmation for `danger`/`caution`, drops
targets nested inside other targets, and checks the path still exists — so a
path one destination refuses is refused by all of them.

```
UI selection
  └─ POST /api/assess          risk verdict per path, no side effects
  └─ confirm dialog            typed DELETE for `danger`, always for erase
  └─ POST /api/delete | /api/trash | /api/erase
       └─ safety.screenTargets()      shared gate, see above
       ├─ /api/delete → Quarantine.deleteMany()
       │    ├─ sameVolume() check      a rename must stay on one volume
       │    └─ performMoves()          fs.rename(), then one elevated batch
       ├─ /api/trash  → dispose.trashMany()
       │    ├─ one osascript -l JavaScript process for the whole batch
       │    │    NSFileManager -trashItemAtURL: per path
       │    └─ elevated `mv` into ~/.Trash for what it could not write
       └─ /api/erase  → dispose.eraseMany()
            └─ fs.rm(recursive), then one elevated `rm -rf` batch
       └─ syncTree() / markGone()     subtract sizes from ancestors, no rescan
```

Undo/redo move whole operations between `undoStack` and `redoStack`, and apply
only to the quarantine — the other two destinations have left the app's
custody. Purge and erase are the irreversible actions; purge clears both stacks.

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
| `mtime` | `Uint32Array` | unix seconds, this node only |
| `subMtime` | `Uint32Array` | newest mtime anywhere in the subtree |
| `flags` | `Uint8Array` | `F_DIR 1`, `F_ERR 2`, `F_HLDUP 4`, `F_DELETED 8`, `F_NOTREG 16` |
| `nameOff`, `nameLen` + `nameBuf` | `Uint32/Uint16` + `Buffer` | names in one buffer |

Children always get a higher index than their parent, so `aggregate()` is a
single reverse loop — which is also why the newest-mtime rollup is free: it
rides along in the pass that already totals sizes, one `max` per node.

That rollup is the difference between a date that means something and one that
does not. A directory's own `mtime` moves only when an entry is added, removed
or renamed *directly* inside it, so a file edited three levels down leaves every
ancestor looking untouched. Both are kept: `mtime` for the narrow question,
`subMtime` for the one people are actually asking. `nameIs()` compares bytes without allocating a string —
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

### `refresh.js` — measuring one folder again

A full scan is minutes; a project folder is seconds. `FolderRefresher` runs ncdu
with the *same* flags, skip list and cancellable wrapper the full scan uses — so
a folder measures the same either way — parses the result into its own
`TreeStore`, and hands it to `TreeStore.spliceSubtree()`.

It keeps its own export file and its own cancel sentinel. `last-scan.json` has
to survive a refresh or reopening the app would reload one folder instead of the
volume, and a shared sentinel would let cancelling a refresh stop a full scan
that happened to be running.

`spliceSubtree()` **appends** the new nodes rather than overwriting the old ones,
which is what preserves the invariant everything else rests on: a child always
sits at a higher index than its parent. The replaced branch is unlinked and
flagged `F_STALE` rather than removed — half the app holds node indices, and
compacting the arrays would renumber every one of them. Sizes bubble up as a
delta; the newest-mtime rollup cannot, because if the newest file under there
was deleted the ancestors' value has to come *down*, so each ancestor is
recomputed from its own children along the one path to the root.

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

`screenTargets()` applies `assess()` to a whole batch and collapses nesting.
Every removal path calls it, which is what keeps "the bin refuses this" and
"the Trash refuses this" from drifting apart.

`privacyRefusal()` explains a failure macOS has already returned. It covers
`~/Library/Containers`, `~/Library/Group Containers` and the six privacy
folders — a separate list from `scanner.js`'s `TCC_PROTECTED`, which is about
*reading*: those folders hang an unconsented `openat()` forever, while these
refuse writes immediately with `EPERM`. The overlap is only partial, so
conflating them would mislabel each.

### `dispose.js`

The two removals that hand the item to somebody else.

`trashMany()` shells out to `NSFileManager -trashItemAtURL:` through JXA rather
than moving files into `~/.Trash` itself. Only the system API picks the correct
per-volume trash, matches Finder's collision naming, and records the put-back
location. One `osascript` process handles the whole batch; paths go in through a
JSON file rather than argv, because a few thousand long paths would otherwise
exceed `ARG_MAX`, and verdicts come back as a 0/1 per path through another file.

The bridge does not carry `NSError` back usefully, so a refusal is diagnosed on
the Node side: if the parent directory is not writable it is retried as root in
one batch and chowned back, and anything else is reported as a refusal.

`eraseMany()` is `fs.rm` with one elevated `rm -rf` batch for the leftovers.

`trashPaths()` is the unscreened primitive, exported for one caller only:
quarantined items, which `assess()` blocks by name because they live under the
app's own directory but which the user has by definition already deleted.

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
| `GET  /api/state` | scan progress, quarantine summary, disk usage, excludes, Trash record |
| `POST /api/scan` | start a scan (`{root, elevated}`) |
| `POST /api/scan/cached` | re-parse the previous export (~2 s vs a full rescan) |
| `POST /api/scan/cancel` | writes the cancel sentinel |
| `POST /api/scan/skip` | add one folder to the skip list, then rescan |
| `POST /api/scan/find-blockers` | sweep for blocked folders — **reports only** |
| `POST /api/scan/apply-blockers` | commit the last sweep's findings |
| `POST /api/excludes` | overwrite the skip list; `{rescan:true}` starts a scan |
| `POST /api/refresh` | re-measure one folder and splice it in |
| `POST /api/refresh/cancel` | writes the refresh sentinel |
| `GET  /api/dir?path=` | one directory: children, crumbs, atimes |
| `GET  /api/search` | name / size / age query across the tree |
| `GET  /api/junk` | junk categories |
| `POST`/`GET`/`POST` `/api/dupes[/cancel]` | duplicate finder |
| `POST /api/assess` | risk verdicts, no side effects |
| `POST /api/delete` | quarantine a batch |
| `POST /api/trash` | move a batch to the macOS Trash |
| `POST /api/erase` | permanently delete a batch — no bin, no Trash |
| `POST /api/bin/trash` | hand quarantined items over to the macOS Trash |
| `POST /api/open-trash` | open `~/.Trash` in Finder |
| `POST /api/undo` · `/api/redo` | move an operation between stacks |
| `POST /api/restore` · `/api/purge` | per-item restore; irreversible erase |
| `POST /api/privacy-settings` | open the Full Disk Access pane |
| `POST /api/reveal` | reveal a path in Finder |
| `POST /api/quicklook` | preview a path with `qlmanage -p` |

---

## On-disk state

`~/Library/Application Support/DiskManager/`

| File | Purpose |
|---|---|
| `quarantine/<id>/<name>` | deleted items, awaiting restore or purge |
| `manifest.json` | entries + `undoStack` / `redoStack`; survives restarts |
| `last-scan.json` | raw ncdu export, reused for instant reload (~250 MB here) |
| `refresh-scan.json` | one folder's export; deleted after the splice |
| `.refresh-cancel` | sentinel for a refresh, kept separate from `.scan-cancel` |
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
| `STALL_MS` (refresh) | 20 s with no export growth | `refresh.js` |
| `MAX_NODES` | 12,000,000 | `tree.js` |
| `CHUNK` | 64 KB head hash | `dupes.js` |
| `ATIME_DEADLINE_MS` | 4 s per listing | `index.js` |
| `ATIME_TOTAL_STATS` / `ATIME_ROW_STATS` | 30,000 / 5,000 | `index.js` |
| `ATIME_CONCURRENCY` | 32 `lstat`s in flight | `index.js` |
| rows given an atime per listing | first 600 | `index.js` |
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
4. **Only purge and `/api/erase` unlink.** Both are gated behind a typed
   `DELETE` in the UI. Every other path is a rename that can be walked back —
   into the quarantine, where this app can undo it, or into the macOS Trash,
   where Finder can.
5. **Try root before blaming privacy.** An unwritable parent is an ordinary
   permission problem and root fixes it, including inside a folder that is also
   privacy-gated. Only a path POSIX says is movable, that macOS refused anyway,
   is a TCC refusal — and root cannot lift that one, so it is reported rather
   than prompted for. Reversing the two costs the user an admin prompt on a
   guaranteed refusal, or a wrong explanation on a fixable one.
6. **The Trash record is memory-only.** `trashedThisRun` in `index.js` is
   never written to disk. Finder can empty the Trash or put an item back
   without telling us, so a record that survived a restart would be asserting
   things about a Trash it has not looked at. Session scope is the honest
   scope, and the UI says so. The list is capped at the 500 most recent items.
7. **The atime rollup must never enumerate a directory.** `newestAtime()`
   takes its descendants from the tree, which already knows them, and only
   ever calls `lstat` — never `readdir`. It also stays inside a deadline and a
   stat budget, and reports `atimeApprox` rather than pretending a truncated
   walk was complete. `lstat` still has no timeout, so the outer
   `Promise.race` is what guarantees the listing returns.
8. **A node marked gone stays gone, and is remembered by path.** `syncTree()`
   reconciles marks against `quarantine.live()`, so an item that leaves the
   quarantine gets un-marked and its bytes handed back to the tree. That is
   right for a restore and wrong for everything else, so trash, erase and purge
   register the path in `gonePaths`, which `syncTree()` resolves and folds into
   its desired set on every pass. **Paths, not indices**: a refresh appends new
   nodes and detaches the old ones, so an index taken beforehand would afterwards
   address a stale branch and the subtraction would land somewhere nobody can
   see. Both sets are cleared when a scan starts.
9. **One admin prompt per batch**, never per file. The server itself never runs
   as root.
10. **Register both path forms when excluding** — `lsof` reports firmlinked
    `/Users/...` while ncdu walks `/System/Volumes/Data/Users/...`.
11. **Rejected promises must be caught** in scan start paths; an unhandled
    rejection is fatal in Node and would take the server down mid-delete.
12. **`sudo` ≠ privacy consent.** Root reaches other users' files; only Full
    Disk Access reaches `~/Desktop`, `~/Music`, iCloud Drive and app containers.
13. **Anything walking the arrays by index must skip `F_STALE`.** A refresh
    leaves the branch it replaced in the arrays, unlinked from the root. Walks
    that follow child links are safe by construction; `findJunk()` and
    `/api/search` are not, and would otherwise report everything inside a
    refreshed folder twice, at two different sizes. There is a test for this.
14. **Validate a refresh in the route, not only in `FolderRefresher`.** Its own
    guards throw before it has touched its state, so a refusal raised in there
    leaves `progress()` reporting what the *previous* refresh did — and a client
    polling for completion reads that stale `ready` as this one succeeding.
15. **The quarantine is blocked in both directions.** `assess()` refuses paths
    at, above *and* inside it. Above: deleting an ancestor eats the manifest.
    Inside: a quarantined item re-binned from Explore would be renamed within
    the quarantine, leaving the manifest pointing at a path that had moved. The
    Bin tab's own actions work from the manifest and never come through
    `assess()`, so they are unaffected.
