# Disk Manager

A visual disk-usage explorer for macOS. It scans the volume your data actually
lives on, shows where the space went, and lets you delete things **reversibly**
— nothing is erased unless you ask for it in so many words.

**[Download the app](https://github.com/rohitshidid/Disk-manager/releases/latest/download/DiskManager-arm64.dmg)** ·
[website](https://rohitshidid.github.io/Disk-manager/) ·
[architecture](structure.md) · [roadmap](TODO.md)

---

## Running it

### The app

Download the DMG from the [website](https://rohitshidid.github.io/Disk-manager/)
or the [releases page](https://github.com/rohitshidid/Disk-manager/releases/latest),
drag **Disk Manager** into Applications, then **right-click it → Open → Open**.
The build is unsigned, so a plain double-click is refused the first time; you
only do this once.

Node and `ncdu` are inside the bundle. Nothing else has to be installed.

Then grant it **Full Disk Access** and relaunch — see
[the section on that](#when-a-scan-gets-stuck-read-this-one), which is the one
part of this README worth reading before you start.

### From source

```sh
brew install ncdu        # the only external requirement
npm start                # then open http://127.0.0.1:4173
npm run dev              # same, but opens the browser for you
```

No dependencies to install for the app itself — Node 20+ and `ncdu`. If 4173 is
taken it walks up until it finds a free port and prints the URL it chose;
`PORT=…` picks a different starting point.

Run this way, Full Disk Access attaches to whichever **terminal app** launched
it rather than to Disk Manager. That is the single most confusing thing about
the source version, and the main reason the packaged app exists.

### Everything else

```sh
npm test                 # 33 tests, node --test, no framework
npm run app              # the Electron shell against your working tree
npm run dist             # build release/DiskManager-arm64.dmg
npm run icon             # redraw build/icon.icns
npm run vendor:ncdu      # re-vendor ncdu and its dylibs into vendor/bin
```

---

## Why it doesn't scan `/`

On modern macOS, `/` is a **sealed, read-only system volume** holding about
12 GB. Your real data — the other few hundred gigabytes — lives on a separate
APFS volume mounted at `/System/Volumes/Data`, which is surfaced back at
`/Users`, `/Applications` and friends through firmlinks.

So `sudo ncdu -x /` (where `-x` means "stay on one filesystem") scans the 12 GB
of files you are not allowed to touch, and stops at the boundary of everything
you actually care about. This app scans `/System/Volumes/Data` instead and
displays paths in their familiar form: you see `/Users/you/Downloads`, not
`/System/Volumes/Data/Users/you/Downloads`.

## Three ways to remove something

Every list in the app offers the same three actions, and they differ only in
who ends up holding the file:

| Action | Where it goes | How to get it back | When the space returns |
|---|---|---|---|
| **Move to bin** | this app's quarantine | ⌘Z, or Restore in the Bin tab | on Purge |
| **Move to Trash** | the macOS Trash | Finder's "Put Back" | when you empty the Trash |
| **Delete permanently** | nowhere | you don't | immediately |

Only the third one unlinks anything, and it is gated behind typing `DELETE`.

**Move to Trash** is the one to reach for if you would rather review things in
Finder than in here. It uses the system's own `NSFileManager -trashItemAtURL:`,
not a hand-rolled `mv` into `~/.Trash`, which matters more than it sounds: the
system picks the right trash for files on other volumes
(`/Volumes/X/.Trashes/<uid>`), resolves name collisions the way Finder expects,
and records where the file came from so "Put Back" actually works. Because it
is not restricted to one volume, it is currently the only way to clean an
external drive.

## How the bin works

Nothing is unlinked when you press "Move to bin". The item is **renamed** into a
quarantine folder on the same volume:

```
~/Library/Application Support/DiskManager/quarantine/<id>/<name>
```

A rename within one volume is instant no matter how large the folder is, and it
is exactly reversible. The original path is recorded in `manifest.json`, which
survives restarts — so Undo still works tomorrow.

Space is reclaimed only when you **Purge**, which is the one irreversible action
in the app. It is gated behind typing `DELETE`. The status bar always shows how
much a purge would free right now, and what your free space would become:

```
314 GB used · 114 GB free  → 126 GB free after purge
```

That is the loop the app is built around: bin things as you find them, watch the
number climb, purge once when it is worth it.

### Undo / redo

* **Undo** (⌘Z) restores the whole last delete operation, including a 107-folder
  batch, as one step.
* **Redo** (⇧⌘Z) re-bins it.
* **Restore** on an individual item in the Bin takes it out of the undo history.
* If something new has taken the original name, the restore lands beside it as
  `name (restored 2026-08-21T15-30-00)` rather than overwriting it.
* Purging clears both stacks — those items are genuinely gone.

### When macOS refuses

Some folders cannot be removed by any means the app has, and no amount of
admin rights changes that. `~/Library/Containers` and `~/Library/Group
Containers` — every sandboxed app's private storage — are the common case, and
the six privacy folders (`~/Desktop`, `~/Documents`, `~/Downloads`, `~/Music`,
`~/Pictures`, `~/Movies`) behave the same way.

This is worth being precise about, because the POSIX permissions actively
mislead you. A directory you created yourself, inside `~/Library/Containers`,
owned by you, with a writable parent, still cannot be renamed, trashed or
deleted: `mv` reports `Operation not permitted`. Nothing about the file is
wrong — macOS is withholding consent from the *process*.

So the app does not try to elevate out of it. An admin prompt would be spent
discovering that root does not help either. It names the folder, says Full Disk
Access is the fix, and offers a button that opens the right settings pane.
Remember that a new consent only applies to freshly launched processes, so the
app must be quit and reopened, not reloaded.

## Safety

A blocklist refuses deletion outright inside SIP-protected and boot-critical
trees (`/System`, `/usr/bin`, `/bin`, `/private/var/db`, …), for volume roots
and your home directory itself, and for anything at, above **or inside** the
app's own quarantine — the last of those because a quarantined item re-binned
from the Explore tab would leave the manifest pointing at a path that had moved,
and a restore reporting the copy as missing for an item sitting right there. The
Bin tab's own Restore, Trash and Purge work from the manifest and are unaffected.

Beyond that:

| Level | When | What happens |
|---|---|---|
| `caution` | over 1 GB, or over 10,000 files | summary + confirmation |
| `danger`  | outside `/Users` | confirmation **and** you must type `DELETE` |

Deletes that need root (files outside your home) trigger the native macOS
authorization dialog — **one prompt per batch**, never one per file. The server
itself never runs as root.

Note that root and privacy consent are different things: `sudo` gets you into
other users' folders and system directories, but it does **not** get you into
`~/Desktop` or `~/Music`. Only Full Disk Access does.

## The four tabs

**Explore** — breadcrumbs, a sortable list and a squarified treemap side by
side, both showing the current folder. Click any column heading to sort by it,
and again to reverse it; the default is size, largest first. Hovering a row
offers **Look** (Quick Look, same as the space bar in Finder), **Finder**
(reveal), **Trash** and **Bin**; clicking a row focuses it so <kbd>space</kbd>
previews it.

The date columns are about the folder's *contents*, not the folder:

* **Modified** — the newest change anywhere inside, however deep. A folder whose
  own record says 2020 but which holds a file edited yesterday reads as
  yesterday, which is what anyone actually means by asking when it last changed.
* **Folder** — the folder's own date, kept as a separate column because it does
  mean something narrower: when an entry was last added, removed or renamed
  *directly* inside. Blank for files, where it is identical to Modified.
* **Last used** — the newest access time anywhere inside, same idea.

Modified is free: the scan already has every file's date, so one pass up the
tree carries the newest to the top. Last used is not — macOS does not report
access times in the scan, so it costs one `lstat` per file underneath. That is
bounded by a deadline and a stat budget, and a folder too large to finish is
marked with a `~` meaning "newest found so far" rather than quietly guessing.

The size and age filters use these same rolled-up dates, so *untouched 3
months+* means nothing inside changed — not merely that the folder's own entry
list held still while files under it were being edited.

**↻ Refresh folder** re-measures the folder you are looking at instead of the
whole volume: seconds rather than minutes. See
[Refreshing one folder](#refreshing-one-folder) below.

**Junk finder** — sweeps for the known space sinks on a dev Mac: `node_modules`,
Xcode `DerivedData`, iOS DeviceSupport, Archives and simulator devices, `.venv`,
`.next`, `.turbo`, `__pycache__`, `.pytest_cache`, application caches and logs,
package-manager caches (npm/pnpm/yarn/bun/Homebrew/Gradle/Maven/Cargo/Go/pip),
iOS backups, Docker images, Trash, and downloads untouched for 90+ days. Each
category is labelled `safe` / `caution` / `danger` and says what regenerating it
costs. Nested hits are dropped, so a `__pycache__` inside a flagged `.venv` is
not counted twice, and anything under 1 MB is left out.

**Duplicates** — byte-identical files. Grouped by size first (different sizes
can't be duplicates), then a 64 KB head hash, then a full hash only for what
still collides — so a same-size-but-different file is rejected after one small
read. Largest potential savings are processed first.

Each set pre-selects every copy except the **oldest**, on the assumption that
the earliest-modified file is the original and the rest were copied from it.
**Quick Delete Duplicates** applies that to every set at once and sends the
copies to the macOS Trash — one confirmation for the whole run, showing which
file each set keeps. Removed copies disappear from the list without a rescan,
and a set that drops to a single remaining copy stops being listed at all.

> APFS can store two files sharing the same blocks (a clone). Deleting one of
> those frees nothing, so the figure here is an upper bound.

**Bin** — everything currently quarantined, with its original path, size and
deletion time. Restore, move to the macOS Trash, or purge — individually or in
bulk. Moving a bin item to the Trash is a handover: it leaves the bin, drops out
of the undo history and out of the reclaim total, and Finder takes over.

Below it, **Moved to the macOS Trash** records what this session sent there,
with the original path, size and time. Every removal already names the files it
touched as it happens, but a toast is gone in four seconds and the rows vanish
from the list with it — so the same information stays here, next to an *Open
Trash in Finder* button. It is a record, not a manager: Finder owns those files,
so there is nothing here to restore or purge. It is also not kept across a
restart, because the Trash can be emptied or put back without this app hearing
about it, and a list that outlived the process would be describing a Trash it
knows nothing about.

## Refreshing one folder

A full scan of the data volume takes minutes. One project folder takes seconds.
**↻ Refresh folder** re-runs `ncdu` on just the folder you are looking at —
same flags, same skip list, same cancellable wrapper, so a folder measures the
same whether it arrived through a refresh or a full scan — and splices the
result into the tree already in memory.

Every ancestor total, the treemap and the free-space projection stay correct,
because the splice carries the difference all the way up to the root. When it
finishes, the toast says what changed:

```
/Users/you/Projects re-measured — 9.8 GB, 1.2 GB larger than the scan said
```

The old branch is not deleted from the typed arrays — half the app holds node
indices, and compacting would renumber every one of them — so it is unlinked
and flagged `F_STALE` instead. Anything that walks the arrays by index rather
than by child links skips those; that is why the junk sweep and the search both
check `isStale()`, and why there is a test for it.

## The skip list

If a scan wedges on a folder macOS will not answer for, you can skip it — but a
skipped folder is simply **missing from every total from then on**, invisibly
and permanently. The ⚙︎ button in the toolbar lists everything currently
skipped, with a Remove button on each row and a *Save & rescan* that puts the
folders back into your numbers.

Granting Full Disk Access is the better fix, and the panel says so with a button
that opens the right pane.

## When a scan gets stuck (read this one)

**Grant Full Disk Access before the first full scan.**

In the packaged app, grant it to **Disk Manager** itself: System Settings →
Privacy & Security → Full Disk Access. Then quit and reopen the app — TCC only
applies to newly launched processes.

Running from source, the permission attaches to the **app that owns the
terminal**, not to `node` and not to `ncdu`. To find which app that is:

```sh
pid=$$; while :; do
  read -r ppid comm <<< "$(ps -o ppid=,comm= -p $pid)"
  [ -z "$comm" ] && break; echo "$comm"
  case "$comm" in */Contents/MacOS/*) break;; esac
  [ "$ppid" -le 1 ] && break; pid=$ppid
done
```

Check whether you already have it — this is the standard test, because
`com.apple.TCC` is readable *only* by a process with Full Disk Access:

```sh
ls ~/Library/Application\ Support/com.apple.TCC/ >/dev/null 2>&1 \
  && echo "GRANTED" || echo "NOT GRANTED"
```

macOS gates `~/Desktop`, `~/Documents`, `~/Downloads`, `~/Music`, `~/Pictures`
and `~/Movies` behind separate privacy consents. A process that lacks consent
for one of them does not get a permission error when it opens that folder — the
`openat()` call **blocks, waiting for a consent prompt that a background process
never gets to show.** It waits forever. `sudo` does not help; TCC is not about
being root.

On this machine a plain `ncdu` run wedged, verifiably and indefinitely, on five
folders: `~/Music/Music`, `~/Desktop`, `~/Library/Mobile Documents` (iCloud
Drive), and two `~/Library/Group Containers` entries. `/home` blocks too — it is
an autofs automount. Each was confirmed by a 20-second probe that never
returned.

So the app watches for it. Liveness is measured by the **export file growing**,
not by an item counter — a slow region of very large files must not look like a
block. If nothing has been written for 25 seconds, the app:

1. Finds ncdu's deepest open directory via `lsof`, choosing the **highest file
   descriptor** rather than the longest path. ncdu opens directories as it
   descends, so the highest fd is the deepest; path length is useless here,
   because firmlinks make the scan root `/System/Volumes/Data` a longer string
   than the far deeper `/Users/you` beneath it.
2. Probes that directory's children in short-lived, killable `ls` processes.
   Anything that does not answer is a *suspect*, not a verdict.
3. Re-probes each suspect alone with much longer patience. A scan saturating
   the disk can make an ordinary folder look slow for a second or two; only a
   folder that still never answers is named. Without this second pass the app
   would tell you to skip folders that are perfectly fine and silently drop
   them from your totals.
4. Says whether that folder is privacy-protected, and if so offers a button
   that opens the Full Disk Access pane directly.

If no child is confirmed, the app says it is still working out which folder is
responsible rather than blaming whichever folder ncdu happens to be inside.

All of this runs in the background and is never awaited by the API — diagnosing
a wedged scan must not wedge the UI that is explaining it. None of these probes
use `fs.readdir`, which has no timeout and would block forever on exactly the
folders we are trying to identify.

You then get two options:

* **Skip it and rescan** — remembers that one folder in `excludes.json`, which
  the ⚙︎ panel can undo later.
* **Find all blocked folders** — sweeps your home folder, `~/Library`,
  `~/Library/Containers` and `~/Library/Group Containers` and finds every
  folder that never answers, in one pass, so you are interrupted once instead
  of once per folder. On this machine that turned up **33** of them: `~/Desktop`,
  `~/Library/Mobile Documents` (iCloud Drive), and 31 group containers
  belonging to Office, WhatsApp, Telegram, Docker, Zoom, Shortcuts and others.
  Discovering those one stall at a time would have meant 33 interruptions.

  The sweep uses the same two-pass logic, and confirms suspects in parallel —
  these probes sit blocked in a syscall rather than doing work, so running them
  together turns six minutes into about eighty seconds.

  If most of a directory's children are blocked it collapses them into the
  parent. It deliberately did *not* collapse here: only 31 of 143 group
  containers block, so naming the parent would have hidden the 112 readable
  ones from your totals.

Skipped folders are simply missing from the totals, which is why granting Full
Disk Access is the better fix.

Cancel works even when the scan is running as root: the elevated wrapper polls
for a sentinel file rather than relying on us being able to signal it. A skip
can never exclude the scan root itself — that would make every future scan come
back empty.

---

## How it is put together

Zero runtime dependencies. Node's standard library, the `ncdu` binary, and one
page of vanilla ES modules. `structure.md` has the full architecture and the
twelve invariants; the short version:

```
server/     Node backend — HTTP, scanning, quarantine, safety
public/     the page: app.js, styles.css, index.html, treemap.js
electron/   the desktop shell (starts the server as a child process)
build/      icon generator, ncdu vendoring, packaging notes, entitlements
test/       node --test, 33 tests, no framework
docs/       the website, served by GitHub Pages
```

* **The tree lives in typed arrays.** A scan here is 2.7M inodes; one JS object
  per node would be gigabytes. Fifteen parallel typed arrays hold 1.35M nodes in
  **41 MB RSS**, and children always get a higher index than their parent, so
  the size totals and the newest-mtime rollup are a single reverse pass.
* **The export is tailed, not piped.** An elevated `ncdu` cannot stream through
  a pipe this process owns, so the export file is read as it grows — one code
  path for both the privileged and the plain run, and live progress for free.
* **The parser is incremental.** A full-volume export is hundreds of megabytes,
  past what `JSON.parse` accepts, so it scans for structural characters while
  tracking string/escape state and parses one object at a time. Verified at
  1-byte chunk sizes, with quotes and brackets inside filenames.
* **One gate for every removal.** `safety.screenTargets()` is shared by the bin,
  the Trash and permanent erase, which is what stops "the bin refuses this" and
  "the Trash refuses this" drifting apart.

### Testing

```sh
npm test
```

33 tests on `node --test`, no framework. They cover the cases that caught real
bugs: the parser at 1-byte chunk boundaries and with quotes/brackets/backslashes
in filenames, hardlink dedupe, the mtime rollup, `spliceSubtree()` arithmetic
and the stale-branch flag, the `assess()` matrix including every blocked case,
`screenTargets()` collapsing nested targets, the quarantine lifecycle against a
real filesystem (delete → undo → redo → restore → purge, plus manifest
persistence and the never-clobber rule), the junk sweep's de-duplication, and
the guard that stops an exclude ever being at or above the scan root.

### Packaging

`npm run dist` produces `release/DiskManager-arm64.dmg`:

1. `build/make-icon.mjs` draws the icon — a disk-usage ring — with a small
   rasteriser and a PNG encoder built on the runtime's own zlib, and assembles
   the `.icns`. No image library, and the icon is diffable as source.
2. `build/bundle-ncdu.mjs` copies `ncdu` and the two Homebrew dylibs it links
   against into `vendor/bin`, rewrites every install name to `@loader_path`,
   and re-signs. Homebrew's binary refers to `/opt/homebrew/…` by absolute
   path, so copying it alone would produce something that runs on exactly the
   machines that did not need it.
3. electron-builder packages the app and `build/after-pack.cjs` ad-hoc signs
   the bundle. This is not cosmetic: packaging invalidates the signature
   Electron shipped with, and on Apple silicon a bundle whose signature does not
   verify will not launch at all.

`build/NOTES.md` explains the configuration choices, including what to change
to sign and notarize properly, and what an Intel or universal build would need.

### Releasing

Tagging publishes the DMG and updates what the website's Download button
points at:

```sh
npm version minor
git push --follow-tags
```

`.github/workflows/release.yml` runs the tests, builds on an Apple-silicon
runner, checks the bundle is signed and that the vendored `ncdu` runs without
Homebrew present, then attaches the DMG to a GitHub release. The website links
to `/releases/latest/download/DiskManager-arm64.dmg`, which is why the asset
name carries no version.

### The website

`docs/` is served by GitHub Pages from the `main` branch. It is one
self-contained HTML file — no build step, no framework, no external requests.
To preview it:

```sh
python3 -m http.server 4611 --directory docs
```

## Notes

* The last scan is cached, so reopening the app reloads a 2.7M-item tree in
  about 2 seconds instead of rescanning.
* Sizes are *disk usage*, matching what `df` reports — not apparent size.
  Hardlinked files are counted once.
* The server binds to `127.0.0.1` only, requires a per-run token on every API
  call, and rejects requests whose `Host` header isn't localhost (DNS-rebinding
  protection — this process can delete files). There is no telemetry and no
  network use at all.
* A 1.35M-item tree occupies ~41 MB of RSS. The rolled-up modified date adds one
  more array — 4 bytes per node, about 5 MB at that size — and is computed
  during the pass that already totals up sizes, so it costs no extra time.
