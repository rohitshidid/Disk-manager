import fs from 'node:fs';
import crypto from 'node:crypto';
import { F_DIR, F_HLDUP, F_NOTREG } from './tree.js';
import { HOME, canonical } from './util.js';

const CHUNK = 64 * 1024;

function hashFile(file, { limit = Infinity } = {}) {
  return new Promise((resolve) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(file, limit === Infinity ? {} : { start: 0, end: limit - 1 });
    let read = 0;
    stream.on('data', (c) => { read += c.length; hash.update(c); });
    stream.on('error', () => resolve(null));
    stream.on('end', () => resolve(hash.digest('hex') + ':' + read));
  });
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i], i);
    }
  }));
  return out;
}

/**
 * Finds byte-identical files.
 *
 * Files of different sizes can't be duplicates, so grouping by size first
 * throws away almost everything for free. Only same-size groups get hashed,
 * and those are hashed in two stages -- 64 KB head first, full file only for
 * what still collides -- so a candidate is usually rejected after one read.
 * Groups are processed largest-first, so the results that matter arrive first
 * even if the byte budget runs out.
 */
export class DupeFinder {
  constructor() { this.reset(); }

  reset() {
    this.status = 'idle';   // idle | running | ready | error | cancelled
    this.phase = '';
    this.groupsTotal = 0;
    this.groupsDone = 0;
    this.bytesHashed = 0;
    this.budget = 0;
    this.results = [];
    this.wasted = 0;
    this.error = null;
    this.rootPath = null;
    this._cancel = false;
  }

  cancel() { this._cancel = true; }

  progress() {
    return {
      status: this.status, phase: this.phase, rootPath: this.rootPath,
      groupsTotal: this.groupsTotal, groupsDone: this.groupsDone,
      bytesHashed: this.bytesHashed, budget: this.budget,
      wasted: this.wasted, groups: this.results.length,
      results: this.status === 'ready' || this.status === 'cancelled' ? this.results.slice(0, 300) : [],
      error: this.error,
    };
  }

  async start(tree, { rootPath = canonical(HOME), minSize = 1024 * 1024, budgetBytes = 60 * 1024 ** 3 } = {}) {
    if (this.status === 'running') throw new Error('A duplicate scan is already running.');
    this.reset();
    this.status = 'running';
    this.rootPath = rootPath;
    this.budget = budgetBytes;
    this.phase = 'collecting';

    try {
      const rootIdx = tree.findByPath(rootPath);
      if (rootIdx < 0) throw new Error(`${rootPath} is not part of the current scan.`);

      // Depth-first walk of the subtree, collecting regular files.
      const bySize = new Map();
      const stack = [rootIdx];
      while (stack.length) {
        const i = stack.pop();
        if (tree.isDeleted(i)) continue;
        const f = tree.flags[i];
        if (f & F_DIR) {
          for (let c = tree.firstChild[i]; c !== -1; c = tree.nextSib[c]) stack.push(c);
          continue;
        }
        if (f & (F_HLDUP | F_NOTREG)) continue;
        const size = tree.ownA[i];
        if (size < minSize) continue;
        let arr = bySize.get(size);
        if (!arr) bySize.set(size, (arr = []));
        arr.push(i);
      }

      const groups = [...bySize.entries()]
        .filter(([, arr]) => arr.length > 1)
        .map(([size, arr]) => ({ size, idxs: arr }))
        .sort((a, b) => b.size * (b.idxs.length - 1) - a.size * (a.idxs.length - 1));

      this.groupsTotal = groups.length;
      this.phase = 'hashing';

      for (const g of groups) {
        if (this._cancel) { this.status = 'cancelled'; break; }
        if (this.bytesHashed >= this.budget) { this.phase = 'budget-reached'; break; }

        const paths = g.idxs.map((i) => ({ idx: i, real: tree.pathOf(i) }));
        const quick = await mapLimit(paths, 4, async (p) => {
          const digest = await hashFile(p.real, { limit: Math.min(CHUNK, g.size) });
          this.bytesHashed += Math.min(CHUNK, g.size);
          return digest;
        });

        const byQuick = new Map();
        quick.forEach((d, i) => {
          if (!d) return;
          if (!byQuick.has(d)) byQuick.set(d, []);
          byQuick.get(d).push(paths[i]);
        });

        for (const candidates of byQuick.values()) {
          if (candidates.length < 2) continue;
          let confirmed;
          if (g.size <= CHUNK) {
            confirmed = new Map([['head', candidates]]);
          } else {
            const full = await mapLimit(candidates, 4, async (p) => {
              const d = await hashFile(p.real);
              this.bytesHashed += g.size;
              return d;
            });
            confirmed = new Map();
            full.forEach((d, i) => {
              if (!d) return;
              if (!confirmed.has(d)) confirmed.set(d, []);
              confirmed.get(d).push(candidates[i]);
            });
          }
          for (const set of confirmed.values()) {
            if (set.length < 2) continue;
            const wasted = g.size * (set.length - 1);
            this.wasted += wasted;
            this.results.push({
              size: g.size,
              wasted,
              files: set.map((p) => ({
                path: tree.displayPath(p.idx),
                realPath: p.real,
                mtime: tree.mtime[p.idx],
                items: 0,
                dsize: tree.subD[p.idx],
              })),
            });
          }
        }
        this.groupsDone++;
      }

      this.results.sort((a, b) => b.wasted - a.wasted);
      if (this.status !== 'cancelled') this.status = 'ready';
    } catch (err) {
      this.status = 'error';
      this.error = err.message;
    }
    return this.progress();
  }
}
