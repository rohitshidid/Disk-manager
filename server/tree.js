import { DATA_VOLUME, canonical, underDataVolume, normalizePath } from './util.js';

/* Flags */
export const F_DIR      = 1;   // directory
export const F_ERR      = 2;   // ncdu could not read it (permissions)
export const F_HLDUP    = 4;   // hardlink we've already counted elsewhere
export const F_DELETED  = 8;   // quarantined during this session
export const F_NOTREG   = 16;  // socket / fifo / device
// Detached by a per-folder refresh. Typed arrays cannot be compacted without
// renumbering every index, and half the app holds indices, so a replaced
// subtree is unlinked and flagged rather than removed. Nothing reachable from
// the root is stale; only whole-tree walks need to skip these.
export const F_STALE    = 32;

const MAX_NODES = 12_000_000;

function growTyped(arr, Type, cap) {
  const next = new Type(cap);
  next.set(arr);
  return next;
}

/**
 * A whole filesystem tree stored as parallel typed arrays.
 *
 * A scan of this Mac's data volume is ~3.5M inodes. One JS object per node
 * would be several gigabytes of heap; the same data as structure-of-arrays is
 * roughly 200 MB and stays fast to walk.
 */
export class TreeStore {
  constructor(cap = 1 << 16) {
    this.cap = cap;
    this.n = 0;
    this.parent = new Int32Array(cap);
    this.firstChild = new Int32Array(cap).fill(-1);
    this.lastChild = new Int32Array(cap).fill(-1);
    this.nextSib = new Int32Array(cap).fill(-1);
    this.childCount = new Uint32Array(cap);
    this.ownD = new Float64Array(cap);
    this.ownA = new Float64Array(cap);
    this.subD = new Float64Array(cap);
    this.subA = new Float64Array(cap);
    this.subItems = new Uint32Array(cap);
    this.mtime = new Uint32Array(cap);
    // Newest mtime anywhere in the subtree. A directory's own mtime only moves
    // when an entry is added, removed or renamed directly inside it, so it says
    // nothing about a file edited three levels down -- which is what people
    // mean when they ask when a folder last changed.
    this.subMtime = new Uint32Array(cap);
    this.flags = new Uint8Array(cap);
    this.nameOff = new Uint32Array(cap);
    this.nameLen = new Uint16Array(cap);
    this.nameBuf = Buffer.alloc(cap * 16);
    this.nameEnd = 0;
    this.truncated = false;
    this.readErrors = 0;
    this.rootPath = DATA_VOLUME;
    this.scannedAt = null;
    this._pathCache = new Map(); // canonical dir path -> node index
  }

  _ensure(extra = 1) {
    if (this.n + extra <= this.cap) return;
    const cap = Math.max(this.cap * 2, this.n + extra);
    for (const [k, T] of [
      ['parent', Int32Array], ['firstChild', Int32Array], ['lastChild', Int32Array],
      ['nextSib', Int32Array], ['childCount', Uint32Array], ['ownD', Float64Array],
      ['ownA', Float64Array], ['subD', Float64Array], ['subA', Float64Array],
      ['subItems', Uint32Array], ['mtime', Uint32Array], ['subMtime', Uint32Array],
      ['flags', Uint8Array],
      ['nameOff', Uint32Array], ['nameLen', Uint16Array],
    ]) {
      const old = this[k];
      this[k] = growTyped(old, T, cap);
      if (k === 'firstChild' || k === 'lastChild' || k === 'nextSib') {
        this[k].fill(-1, this.cap);
      }
    }
    this.cap = cap;
  }

  _ensureNames(bytes) {
    if (this.nameEnd + bytes <= this.nameBuf.length) return;
    const next = Buffer.alloc(Math.max(this.nameBuf.length * 2, this.nameEnd + bytes));
    this.nameBuf.copy(next, 0, 0, this.nameEnd);
    this.nameBuf = next;
  }

  add(parent, name, flags, dsize, asize, mtime) {
    if (this.n >= MAX_NODES) { this.truncated = true; return -1; }
    this._ensure(1);
    const i = this.n++;
    const bytes = Buffer.byteLength(name);
    this._ensureNames(bytes);
    this.nameBuf.write(name, this.nameEnd);
    this.nameOff[i] = this.nameEnd;
    this.nameLen[i] = Math.min(bytes, 65535);
    this.nameEnd += bytes;

    this.parent[i] = parent;
    this.flags[i] = flags;
    this.ownD[i] = dsize;
    this.ownA[i] = asize;
    this.subD[i] = dsize;
    this.subA[i] = asize;
    this.mtime[i] = mtime;
    this.subMtime[i] = mtime;
    if (flags & F_ERR) this.readErrors++;

    if (parent >= 0) {
      const last = this.lastChild[parent];
      if (last === -1) this.firstChild[parent] = i;
      else this.nextSib[last] = i;
      this.lastChild[parent] = i;
      this.childCount[parent]++;
    }
    return i;
  }

  name(i) {
    return this.nameBuf.toString('utf8', this.nameOff[i], this.nameOff[i] + this.nameLen[i]);
  }

  /** Compare a node's name to an ASCII literal without allocating a string. */
  nameIs(i, literal) {
    const len = this.nameLen[i];
    if (len !== literal.length) return false;
    const off = this.nameOff[i];
    for (let k = 0; k < len; k++) {
      if (this.nameBuf[off + k] !== literal.charCodeAt(k)) return false;
    }
    return true;
  }

  isDir(i) { return i >= 0 && (this.flags[i] & F_DIR) !== 0; }
  isDeleted(i) { return i >= 0 && (this.flags[i] & F_DELETED) !== 0; }
  /** Left over from a refresh: unreachable from the root, and to be skipped by
   *  anything that walks the arrays by index rather than by child links. */
  isStale(i) { return i >= 0 && (this.flags[i] & F_STALE) !== 0; }

  /** Roll subtree totals up into every ancestor. Children always have a
   *  higher index than their parent, so one reverse pass is enough. */
  aggregate() {
    const { parent, subD, subA, subItems, subMtime } = this;
    for (let i = this.n - 1; i >= 1; i--) {
      const p = parent[i];
      if (p < 0) continue;
      subD[p] += subD[i];
      subA[p] += subA[i];
      subItems[p] += subItems[i] + 1;
      // Children always sit at a higher index than their parent, so one
      // reverse pass carries the newest mtime all the way to the root.
      if (subMtime[i] > subMtime[p]) subMtime[p] = subMtime[i];
    }
  }

  /** Absolute on-disk path (data-volume prefixed). */
  pathOf(i) {
    if (!(i >= 0 && i < this.n)) return null;
    const parts = [];
    let cur = i;
    while (cur > 0) { parts.push(this.name(cur)); cur = this.parent[cur]; }
    const base = this.n ? this.name(0) : DATA_VOLUME;
    if (!parts.length) return base;
    parts.reverse();
    return base.replace(/\/$/, '') + '/' + parts.join('/');
  }

  /** Path as the user thinks of it: /Users/me/... */
  displayPath(i) { return canonical(this.pathOf(i)); }

  children(i) {
    const out = [];
    if (!(i >= 0 && i < this.n)) return out;
    for (let c = this.firstChild[i]; c !== -1; c = this.nextSib[c]) out.push(c);
    return out;
  }

  /** Resolve a display or absolute path to a node index, or -1. */
  findByPath(p) {
    if (!this.n || typeof p !== 'string') return -1;
    const root = this.name(0).replace(/\/+$/, '');
    let abs = normalizePath(p).replace(/\/+$/, '') || '/';
    if (abs !== root && !abs.startsWith(root + '/')) {
      // Also accept the display form (/Users/...) of a data-volume path.
      const alt = underDataVolume(abs).replace(/\/+$/, '') || DATA_VOLUME;
      if (alt !== root && !alt.startsWith(root + '/')) return -1;
      abs = alt;
    }
    if (abs === root) return 0;
    const cached = this._pathCache.get(abs);
    if (cached !== undefined) return cached;
    const segs = abs.slice(root.length + 1).split('/');
    let cur = 0;
    for (const seg of segs) {
      let found = -1;
      for (let c = this.firstChild[cur]; c !== -1; c = this.nextSib[c]) {
        if (this.nameIs(c, seg)) { found = c; break; }
      }
      if (found === -1) return -1;
      cur = found;
    }
    if (this.isDir(cur)) this._pathCache.set(abs, cur);
    return cur;
  }

  /** Apply a size delta to a node and every ancestor (used by delete/undo so
   *  the view updates without a rescan). */
  bubble(i, deltaD, deltaA, deltaItems) {
    if (!(i >= 0 && i < this.n)) return;
    for (let cur = this.parent[i]; cur >= 0; cur = this.parent[cur]) {
      this.subD[cur] += deltaD;
      this.subA[cur] += deltaA;
      this.subItems[cur] = Math.max(0, this.subItems[cur] + deltaItems);
      if (cur === 0) break;
    }
  }

  markDeleted(i, deleted) {
    if (!(i >= 0 && i < this.n)) return;
    if (deleted && this.isDeleted(i)) return;
    if (!deleted && !this.isDeleted(i)) return;
    const d = this.subD[i], a = this.subA[i], items = this.subItems[i] + 1;
    if (deleted) { this.flags[i] |= F_DELETED; this.bubble(i, -d, -a, -items); }
    else { this.flags[i] &= ~F_DELETED; this.bubble(i, d, a, items); }
  }

  /** Take a node out of its parent's child list. The node keeps its own
   *  children, so the whole branch comes away in one piece. */
  _unlink(i) {
    const p = this.parent[i];
    if (p < 0) return;
    let prev = -1;
    for (let c = this.firstChild[p]; c !== -1; c = this.nextSib[c]) {
      if (c === i) break;
      prev = c;
    }
    if (prev === -1) this.firstChild[p] = this.nextSib[i];
    else this.nextSib[prev] = this.nextSib[i];
    if (this.lastChild[p] === i) this.lastChild[p] = prev;
    if (this.childCount[p] > 0) this.childCount[p]--;
    this.parent[i] = -1;
    this.nextSib[i] = -1;
  }

  /** Flag a detached branch, and hand back the read errors it was contributing
   *  so the scan summary does not count them twice after a refresh. */
  _flagStale(root) {
    let errors = 0;
    const stack = [root];
    while (stack.length) {
      const i = stack.pop();
      if (this.flags[i] & F_STALE) continue;
      this.flags[i] |= F_STALE;
      if (this.flags[i] & F_ERR) errors++;
      for (let c = this.firstChild[i]; c !== -1; c = this.nextSib[c]) stack.push(c);
    }
    this.readErrors = Math.max(0, this.readErrors - errors);
    return errors;
  }

  /**
   * Swap the subtree at `idx` for a freshly scanned one.
   *
   * `sub` is a TreeStore of its own, rooted at the same folder and already
   * aggregated. Its nodes are appended here rather than written over the old
   * ones, which is what keeps the invariant every other method rests on: a
   * child always sits at a higher index than its parent, so `aggregate()` and
   * the mtime rollup stay single reverse passes. `sub` is walked in index
   * order, so each node's parent has already been mapped by the time it is
   * needed.
   *
   * The old nodes are detached and flagged `F_STALE`, not removed -- see the
   * flag's comment. They are reclaimed by the next full scan.
   *
   * Returns the new index of the refreshed folder, or -1 if it could not be
   * spliced (the scan root, or a tree that would overflow).
   */
  spliceSubtree(idx, sub) {
    if (!(idx > 0 && idx < this.n) || !sub || !sub.n) return -1;
    const parent = this.parent[idx];
    if (parent < 0) return -1;
    if (this.n + sub.n > MAX_NODES) { this.truncated = true; return -1; }

    const oldD = this.subD[idx];
    const oldA = this.subA[idx];
    const oldItems = this.subItems[idx] + 1;
    const wasDeleted = this.isDeleted(idx);

    this._unlink(idx);
    this._flagStale(idx);

    // The folder keeps the name it already had: ncdu's root record carries the
    // path it was handed, not the basename.
    const keptName = this.name(idx);
    const map = new Int32Array(sub.n);
    for (let i = 0; i < sub.n; i++) {
      const p = i === 0 ? parent : map[sub.parent[i]];
      const ni = this.add(
        p,
        i === 0 ? keptName : sub.name(i),
        sub.flags[i] & ~(F_DELETED | F_STALE),
        sub.ownD[i], sub.ownA[i], sub.mtime[i],
      );
      if (ni === -1) { this.truncated = true; return -1; }
      map[i] = ni;
    }
    const newIdx = map[0];

    // Total the appended range on its own. Every node in it has its parent in
    // the same range except newIdx, whose parent is the live tree above.
    for (let i = this.n - 1; i > newIdx; i--) {
      const p = this.parent[i];
      this.subD[p] += this.subD[i];
      this.subA[p] += this.subA[i];
      this.subItems[p] += this.subItems[i] + 1;
      if (this.subMtime[i] > this.subMtime[p]) this.subMtime[p] = this.subMtime[i];
    }

    // A folder that was in the bin when the refresh ran is on disk again only
    // if the user restored it; either way the fresh measurement is the truth,
    // so the mark is dropped and index.js re-derives it from the manifest.
    if (wasDeleted) this.flags[newIdx] &= ~F_DELETED;

    this.bubble(newIdx, this.subD[newIdx] - oldD, this.subA[newIdx] - oldA,
      (this.subItems[newIdx] + 1) - oldItems);

    // Sizes bubble as a delta, but the newest-mtime rollup cannot: if the
    // newest file under here was deleted, the ancestors' value has to come
    // down, and a delta has no way to express that. Recomputing each ancestor
    // from its own children is exact and costs only the fan-out along one
    // path to the root.
    for (let cur = this.parent[newIdx]; cur >= 0; cur = this.parent[cur]) {
      let newest = this.mtime[cur];
      for (let c = this.firstChild[cur]; c !== -1; c = this.nextSib[c]) {
        if (this.subMtime[c] > newest) newest = this.subMtime[c];
      }
      this.subMtime[cur] = newest;
      if (cur === 0) break;
    }

    // Every cached path under the old branch now points at a detached node.
    this._pathCache.clear();
    return newIdx;
  }
}

/**
 * Incremental parser for ncdu's JSON export.
 *
 * Format: [1, 2, {metadata}, [ {dir}, {file}, [ {subdir}, ... ], ... ] ]
 * The first element of every nested array is that directory's own record;
 * the rest are its files (objects) and subdirectories (arrays).
 *
 * We stream it because a full-volume export is hundreds of megabytes -- far
 * past what JSON.parse can take in one string.
 */
export class NcduParser {
  constructor(tree, { onProgress } = {}) {
    this.tree = tree;
    this.onProgress = onProgress;
    this.depth = 0;
    this.dirStack = [];      // array depth -> node index
    this.pendingHeader = [];  // array depth -> next object is the dir record
    this.leftover = null;
    this.inString = false;
    this.escaped = false;
    this.objDepth = 0;
    this.objStart = 0;
    this.hardlinks = new Set();
    this.bytes = 0;
    this.count = 0;
  }

  write(chunk) {
    this.bytes += chunk.length;
    let buf = this.leftover ? Buffer.concat([this.leftover, chunk]) : chunk;
    this.leftover = null;
    let i = 0;
    const len = buf.length;
    while (i < len) {
      const c = buf[i];
      if (this.inString) {
        if (this.escaped) this.escaped = false;
        else if (c === 0x5c) this.escaped = true;
        else if (c === 0x22) this.inString = false;
        i++;
        continue;
      }
      if (c === 0x22) { this.inString = true; i++; continue; }
      if (this.objDepth > 0) {
        if (c === 0x7b) this.objDepth++;
        else if (c === 0x7d) {
          this.objDepth--;
          if (this.objDepth === 0) { this._object(buf.toString('utf8', this.objStart, i + 1)); }
        }
        i++;
        continue;
      }
      if (c === 0x7b) { this.objDepth = 1; this.objStart = i; i++; continue; }
      if (c === 0x5b) { this._arrayOpen(); i++; continue; }
      if (c === 0x5d) { this._arrayClose(); i++; continue; }
      i++;
    }
    if (this.objDepth > 0) {
      // Keep the partial object and re-scan it from the start next time.
      this.leftover = Buffer.from(buf.subarray(this.objStart));
      this.objDepth = 0;
      this.inString = false;
      this.escaped = false;
      this.objStart = 0;
    }
    if (this.onProgress && this.count - (this._lastReport ?? 0) > 20000) {
      this._lastReport = this.count;
      this.onProgress({ items: this.count, bytes: this.bytes });
    }
  }

  end() {
    if (this.onProgress) this.onProgress({ items: this.count, bytes: this.bytes });
  }

  /** Directory ncdu is currently inside -- the one to name if a scan wedges. */
  currentDir() {
    for (let d = this.depth; d >= 2; d--) {
      const idx = this.dirStack[d];
      if (idx !== undefined && idx >= 0) return idx;
    }
    return -1;
  }

  _arrayOpen() {
    this.depth++;
    this.pendingHeader[this.depth] = this.depth >= 2;
  }

  _arrayClose() {
    if (this.depth >= 2) this.dirStack[this.depth] = -1;
    this.depth--;
  }

  _object(text) {
    if (this.depth < 2) return; // file-level metadata header
    let o;
    try { o = JSON.parse(text); } catch { return; }

    const isDirRecord = this.pendingHeader[this.depth];
    let flags = 0;
    if (isDirRecord) flags |= F_DIR;
    if (o.read_error) flags |= F_ERR;
    if (o.notreg) flags |= F_NOTREG;

    let dsize = o.dsize ?? 0;
    let asize = o.asize ?? 0;
    if (o.hlnkc && o.ino !== undefined) {
      if (this.hardlinks.has(o.ino)) { flags |= F_HLDUP; dsize = 0; asize = 0; }
      else this.hardlinks.add(o.ino);
    }

    const parent = isDirRecord
      ? (this.depth > 2 ? this.dirStack[this.depth - 1] : -1)
      : this.dirStack[this.depth];

    const idx = this.tree.add(parent ?? -1, o.name ?? '?', flags, dsize, asize, o.mtime ?? 0);
    if (idx === -1) return;
    this.count++;
    if (isDirRecord) {
      this.dirStack[this.depth] = idx;
      this.pendingHeader[this.depth] = false;
    }
  }
}
