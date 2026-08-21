# Disk Manager

A visual disk-usage explorer for macOS. It scans your disk with `ncdu`, shows
where the space actually went, and lets you delete things **reversibly** —
every deletion can be undone, and nothing is erased until you explicitly purge.

```
npm start          # then open http://127.0.0.1:4173
npm run dev        # same, but opens the browser for you
```

No dependencies to install. Node 20+ and `ncdu` (`brew install ncdu`).

---

## Why it doesn't scan `/`

On macOS 26, `/` is a **sealed, read-only system volume** holding about 12 GB.
Your real data — the other ~300 GB — lives on a separate APFS volume mounted at
`/System/Volumes/Data`, which is surfaced back at `/Users`, `/Applications` and
friends through firmlinks.

So `sudo ncdu -x /` (where `-x` means "stay on one filesystem") scans the 12 GB
of files you are not allowed to touch, and stops at the boundary of everything
you actually care about. This app scans `/System/Volumes/Data` instead and
displays paths in their familiar form: you see `/Users/you/Downloads`, not
`/System/Volumes/Data/Users/you/Downloads`.

## How deletion works

Nothing is unlinked when you press Delete. The item is **renamed** into a
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

## Safety

A blocklist refuses deletion outright inside SIP-protected and boot-critical
trees (`/System`, `/usr/bin`, `/bin`, `/private/var/db`, …), for volume roots
and your home directory itself, and for any path containing the app's own
quarantine.

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
`~/Desktop` or `~/Music`. Only Full Disk Access does. See below.

## The four tabs

**Explore** — breadcrumbs, a sortable list and a squarified treemap side by
side, both showing the current folder. Columns include *Modified* and *Last
used*, so you can find things that are both big and untouched. Filter by size or
age; search the whole tree by name.

**Junk finder** — sweeps for the known space sinks on a dev Mac: `node_modules`,
Xcode `DerivedData` and iOS DeviceSupport, `.venv`, `.next`, `__pycache__`,
package-manager caches (npm/pnpm/yarn/bun/Homebrew/Gradle/Maven/Cargo/Go), iOS
backups, Docker images, Trash, and downloads untouched for 90+ days. Each
category is labelled `safe` / `caution` / `danger` and says what regenerating it
costs. Nested hits are dropped, so a `__pycache__` inside a flagged `.venv` is
not counted twice.

**Duplicates** — byte-identical files. Grouped by size first (different sizes
can't be duplicates), then a 64 KB head hash, then a full hash only for what
still collides — so a same-size-but-different file is rejected after one small
read. Largest potential savings are processed first.

> APFS can store two files sharing the same blocks (a clone). Deleting one of
> those frees nothing, so the figure here is an upper bound.

**Bin** — everything currently quarantined, with its original path, size and
deletion time. Restore or purge individually or in bulk.

## When a scan gets stuck (read this one)

**Grant Full Disk Access to your terminal before the first full scan.**

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

* **Skip it and rescan** — remembers that one folder in `excludes.json`.
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

## Notes

* The last scan is cached, so reopening the app reloads a 1.3M-item tree in
  about 2 seconds instead of rescanning.
* Sizes are *disk usage*, matching what `df` reports — not apparent size.
  Hardlinked files are counted once.
* The server binds to `127.0.0.1` only, requires a per-run token on every API
  call, and rejects requests whose `Host` header isn't localhost (DNS-rebinding
  protection — this process can delete files).
* A 1.35M-item tree occupies ~41 MB of RSS: the filesystem is held as parallel
  typed arrays rather than one object per file, which would be gigabytes.
