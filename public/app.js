import { squarify } from './treemap.js';

const TOKEN = document.body.dataset.token;
const $ = (id) => document.getElementById(id);

/* ---------------------------------------------------------------- helpers */

async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(path, {
    method,
    headers: { 'x-dm-token': TOKEN, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

function fmt(n) {
  if (!Number.isFinite(n)) return '—';
  const neg = n < 0; n = Math.abs(n);
  const u = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return (neg ? '-' : '') + (n < 10 && i > 0 ? n.toFixed(1) : Math.round(n)) + ' ' + u[i];
}

function fmtDate(unix) {
  if (!unix) return '—';
  const d = new Date(unix * 1000);
  const days = (Date.now() - d) / 86400000;
  if (days < 1) return 'today';
  if (days < 30) return `${Math.floor(days)}d ago`;
  if (days < 365) return `${Math.floor(days / 30)}mo ago`;
  return `${Math.floor(days / 365)}y ago`;
}

function toast(msg, kind = '') {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = msg;
  $('toasts').append(el);
  setTimeout(() => { el.style.opacity = '0'; setTimeout(() => el.remove(), 250); }, kind === 'err' ? 7000 : 4000);
}

/** Promise-based confirm dialog. `typed` demands the word DELETE. */
function confirmDlg({ title, html, okLabel = 'Confirm', typed = false }) {
  return new Promise((resolve) => {
    const dlg = $('confirmDlg');
    $('dlgTitle').textContent = title;
    $('dlgBody').innerHTML = html;
    $('dlgOk').textContent = okLabel;
    $('dlgType').value = '';
    $('dlgTypeWrap').classList.toggle('hidden', !typed);
    $('dlgOk').disabled = typed;

    const onType = () => { $('dlgOk').disabled = $('dlgType').value.trim().toUpperCase() !== 'DELETE'; };
    const close = (val) => {
      $('dlgType').removeEventListener('input', onType);
      $('dlgOk').removeEventListener('click', ok);
      $('dlgCancel').removeEventListener('click', cancel);
      dlg.close();
      resolve(val);
    };
    const ok = () => close(true);
    const cancel = () => close(false);

    if (typed) $('dlgType').addEventListener('input', onType);
    $('dlgOk').addEventListener('click', ok);
    $('dlgCancel').addEventListener('click', cancel);
    dlg.addEventListener('cancel', (e) => { e.preventDefault(); close(false); }, { once: true });
    dlg.showModal();
    if (typed) $('dlgType').focus();
  });
}

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/* ------------------------------------------------------------------ state */

const state = {
  server: null,
  dir: null,
  searchMode: false,
  selected: new Set(),
  binSelected: new Set(),
  tab: 'explore',
  pollTimer: null,
};

/* --------------------------------------------------------------- chrome */

function renderStatus() {
  const s = state.server;
  if (!s) return;
  const { disk, quarantine: q, scan } = s;

  $('undoBtn').disabled = !q.canUndo;
  $('redoBtn').disabled = !q.canRedo;
  $('undoBtn').title = q.undoLabel ? `Undo: ${q.undoLabel} (⌘Z)` : 'Nothing to undo';
  $('redoBtn').title = q.redoLabel ? `Redo: ${q.redoLabel} (⇧⌘Z)` : 'Nothing to redo';

  $('binCount').textContent = q.reclaimable.count;
  $('reclaimBytes').textContent = fmt(q.reclaimable.bytes);
  $('reclaimCount').textContent = q.reclaimable.count;
  $('purgeFooter').disabled = q.reclaimable.count === 0;
  $('purgeSel').disabled = state.binSelected.size === 0;
  $('restoreSel').disabled = state.binSelected.size === 0;
  $('purgeAll').disabled = q.reclaimable.count === 0;

  if (disk) {
    $('diskUsed').textContent = fmt(disk.used);
    $('diskFree').textContent = fmt(disk.avail);
    const usedPct = (disk.used / disk.size) * 100;
    const reclaimPct = Math.min((q.reclaimable.bytes / disk.size) * 100, usedPct);
    $('gaugeUsed').style.width = (usedPct - reclaimPct) + '%';
    $('gaugeReclaim').style.width = reclaimPct + '%';
    $('projection').textContent = q.reclaimable.bytes > 0
      ? `→ ${fmt(disk.availAfterPurge)} free after purge`
      : '';
  }

  // Scan chrome
  const scanning = scan.status === 'scanning';
  $('scanBar').classList.toggle('hidden', !scanning);
  $('scanBtn').disabled = scanning;
  if (scanning) {
    const secs = Math.round(scan.elapsedMs / 1000);
    const mode = scan.stalledMs ? 'stalled' : 'running';
    const changed = $('scanBar').dataset.mode !== mode;
    $('scanBar').dataset.mode = mode;
    if (scan.stalledMs) {
      const where = scan.stalledAt;
      const secsStuck = Math.round(scan.stalledMs / 1000);
      // macOS gates Desktop/Documents/Downloads/Music/Pictures behind a privacy
      // prompt. A background process without consent blocks forever instead of
      // getting a permission error, so name the real cause and the real fix.
      const why = !where
        ? `Still working out which folder is responsible…`
        : scan.stalledPrivacy
          ? `macOS is waiting for privacy consent for this folder, and nothing will ever answer. Grant Full Disk Access to your terminal, then rescan.`
          : `macOS is not answering for that folder; the scan will not finish on its own.`;
      if (changed) {
        $('scanBar').innerHTML = `
          <span class="stall-msg"></span>
          <span class="spacer" style="flex:1"></span>
          ${scan.stalledPrivacy ? `<button class="btn small primary" id="fdaBtn">Open Privacy settings</button>` : ''}
          <button class="btn small" id="skipStuck"${where ? '' : ' disabled'}>Skip it and rescan</button>
          <button class="btn small" id="findBlockers">Find all blocked folders</button>
          <button class="btn ghost small" id="cancelStuck">Cancel scan</button>`;
        const fda = $('fdaBtn');
        if (fda) fda.onclick = () => {
          api('/api/privacy-settings', { method: 'POST' });
          toast('Add your terminal under Full Disk Access, then press Scan disk again.');
        };
        $('skipStuck').onclick = async () => {
          try {
            await api('/api/scan/skip', { method: 'POST', body: { path: where, root: scan.root, elevated: scan.elevated } });
            toast(`Skipping ${where} from now on.`);
            poll();
          } catch (err) { toast(err.message, 'err'); }
        };
        $('cancelStuck').onclick = () => api('/api/scan/cancel', { method: 'POST' });
        $('findBlockers').onclick = async (ev) => {
          const btn = ev.target;
          btn.disabled = true;
          btn.textContent = 'Checking every folder… (up to a few minutes)';
          try {
            const r = await api('/api/scan/find-blockers', { method: 'POST' });
            if (!r.found.length) {
              toast('No permanently blocked folders found in your home or Library.');
            } else {
              const list = r.found.slice(0, 80).map((f) => `<div>${esc(f.path)}</div>`).join('');
              const ok = await confirmDlg({
                title: `${r.found.length} folder(s) never respond`,
                html: `
                  ${r.recommendFullDiskAccess ? `<div class="warnbox">
                    macOS is gating <strong>${r.found.length}${r.truncated ? '+' : ''}</strong> folders behind privacy consent.
                    Skipping them all works, but they will be missing from every total — and on a Mac
                    that usually means several GB unaccounted for.
                    <strong>Granting Full Disk Access fixes all of them at once</strong> and is the
                    better option.</div>` : ''}
                  <p>These folders never answer, so no scanner can measure them:</p>
                  <div class="target-list">${list}</div>`,
                okLabel: `Skip all ${r.found.length} anyway`,
              });
              if (ok) {
                await api('/api/scan/apply-blockers', { method: 'POST' });
                toast(`Added ${r.found.length} folder(s) to the skip list. Restarting the scan.`, 'ok');
                await api('/api/scan/cancel', { method: 'POST' });
                setTimeout(() => startScan(scan.elevated), 2500);
              } else {
                api('/api/privacy-settings', { method: 'POST' });
                toast('Add your terminal under Full Disk Access, then press Scan disk again.');
              }
            }
          } catch (err) { toast(err.message, 'err'); }
          btn.disabled = false;
          btn.textContent = 'Find all blocked folders';
        };
      }
      const msg = $('scanBar').querySelector('.stall-msg');
      if (msg) {
        msg.innerHTML = where
          ? `⚠︎ No progress for ${secsStuck}s — stuck on <code>${esc(where)}</code>. ${esc(why)}`
          : `⚠︎ No progress for ${secsStuck}s. ${esc(why)}`;
      }
      const sb = $('skipStuck');
      if (sb) sb.disabled = !where;
    } else if (!scan.stalledMs) {
      if (changed) {
        $('scanBar').innerHTML = `<div class="spinner"></div><span id="scanText"></span>
          <button class="btn ghost small" id="cancelScan2">Cancel</button>`;
        $('cancelScan2').onclick = () => api('/api/scan/cancel', { method: 'POST' });
      }
      $('scanText').textContent =
        `Scanning ${scan.root} — ${scan.items.toLocaleString()} items, ${fmt(scan.bytes)} of index read, ${secs}s`;
    }
  }

  if (scan.status === 'ready') {
    const when = scan.scannedAt ? new Date(scan.scannedAt).toLocaleString() : '';
    let txt = `${fmt(scan.totalBytes)} across ${scan.totalItems.toLocaleString()} items · scanned ${when}`;
    if (scan.readErrors) txt += ` · ${scan.readErrors.toLocaleString()} unreadable`;
    $('scanInfo').innerHTML = esc(txt) +
      (scan.readErrors && !scan.elevated
        ? ` <button class="btn ghost small" id="elevBtn">Rescan as admin</button>` : '');
    const eb = $('elevBtn');
    if (eb) eb.onclick = () => startScan(true);
  } else if (scan.status === 'error') {
    $('scanInfo').textContent = `Scan failed: ${scan.error}`;
  } else if (scan.status === 'cancelled') {
    $('scanInfo').textContent = 'Scan cancelled.';
  } else if (scan.hasCachedScan) {
    $('scanInfo').innerHTML = `Not scanned yet · <button class="btn ghost small" id="cachedBtn">Load last scan</button>`;
    $('cachedBtn').onclick = loadCached;
  }
}

async function refreshState() {
  state.server = await api('/api/state');
  renderStatus();
  return state.server;
}

/* ----------------------------------------------------------------- scan */

async function startScan(elevated = false) {
  try {
    await api('/api/scan', { method: 'POST', body: { elevated } });
    poll();
  } catch (err) { toast(err.message, 'err'); }
}

async function loadCached() {
  try {
    $('scanInfo').textContent = 'Loading last scan…';
    await api('/api/scan/cached', { method: 'POST' });
    await refreshState();
    await openDir(state.server.scan.root);
    await onScanReady();
  } catch (err) { toast(err.message, 'err'); }
}

function poll() {
  clearInterval(state.pollTimer);
  state.pollTimer = setInterval(async () => {
    const s = await refreshState().catch(() => null);
    if (!s || s.scan.status !== 'scanning') {
      clearInterval(state.pollTimer);
      if (s?.scan.status === 'ready') {
        toast(`Scan finished — ${fmt(s.scan.totalBytes)} across ${s.scan.totalItems.toLocaleString()} items`, 'ok');
        await openDir(s.scan.root);
        await onScanReady();
      } else if (s?.scan.status === 'error') {
        toast(`Scan failed: ${s.scan.error}`, 'err');
      }
    }
  }, 600);
}

async function onScanReady() {
  const s = state.server;
  if (s.scan.readErrors > 200) {
    toast(`${s.scan.readErrors.toLocaleString()} folders could not be read, so their size is missing from the totals. Admin rights cover system and other users' folders; Full Disk Access covers Desktop, Documents, Downloads, Music and Pictures.`);
  }
  if (s.excludes?.length) {
    toast(`${s.excludes.length} folder(s) are on your skip list and were not counted.`);
  }
  if (state.tab === 'junk') loadJunk();
}

/* -------------------------------------------------------------- explore */

async function openDir(path) {
  try {
    const data = await api('/api/dir?path=' + encodeURIComponent(path));
    state.dir = data;
    state.searchMode = false;
    state.selected.clear();
    renderCrumbs(data.crumbs);
    renderRows(data.children, data.node.size, data.truncated);
    renderTreemap(data.node, data.children);
  } catch (err) { toast(err.message, 'err'); }
}

function renderCrumbs(crumbs) {
  const el = $('crumbs');
  el.innerHTML = '';
  crumbs.forEach((c, i) => {
    if (i) { const s = document.createElement('span'); s.className = 'crumb-sep'; s.textContent = '›'; el.append(s); }
    const b = document.createElement('button');
    b.className = 'crumb' + (i === crumbs.length - 1 ? ' current' : '');
    b.textContent = c.name === '/' ? 'Macintosh HD' : c.name;
    if (i !== crumbs.length - 1) b.onclick = () => openDir(c.path);
    el.append(b);
  });
}

function passesFilters(row) {
  const minSize = Number($('minSize').value);
  const olderDays = Number($('olderThan').value);
  if (row.size < minSize) return false;
  if (olderDays) {
    const newest = Math.max(row.mtime || 0, row.atime || 0);
    if (!newest || newest > Date.now() / 1000 - olderDays * 86400) return false;
  }
  return true;
}

function renderRows(children, parentSize, truncated = 0) {
  const el = $('rows');
  el.innerHTML = '';
  const visible = children.filter(passesFilters);

  if (!visible.length) {
    el.innerHTML = `<div class="empty">${children.length ? 'Nothing matches these filters.' : 'This folder is empty.'}</div>`;
  }

  const frag = document.createDocumentFragment();
  for (const c of visible) {
    const row = document.createElement('div');
    row.className = 'row' + (c.isDir ? ' dir' : '') + (state.selected.has(c.path) ? ' sel' : '');
    const pct = Math.round((parentSize ? c.size / parentSize : 0) * 100);
    row.innerHTML = `
      <span class="c-check"><input type="checkbox" ${state.selected.has(c.path) ? 'checked' : ''}></span>
      <span class="c-name"><span class="ico">${c.isDir ? '▸' : '·'}</span><span class="nm">${esc(c.name)}</span>
        ${c.unreadable ? '<span class="unreadable" title="Could not be read during the scan — its contents are not counted">⚠︎</span>' : ''}</span>
      <span class="c-bar"><i style="width:${pct}%"></i></span>
      <span class="c-size">${fmt(c.size)}</span>
      <span class="c-items">${c.isDir ? c.items.toLocaleString() : ''}</span>
      <span class="c-date">${fmtDate(c.mtime)}</span>
      <span class="c-date">${fmtDate(c.atime)}</span>
      <button class="del" title="Move to bin">Delete</button>`;

    row.querySelector('input').onchange = (e) => {
      if (e.target.checked) state.selected.add(c.path); else state.selected.delete(c.path);
      row.classList.toggle('sel', e.target.checked);
      renderSelectionBar();
    };
    if (c.isDir) row.querySelector('.c-name').onclick = () => openDir(c.path);
    row.querySelector('.del').onclick = (e) => { e.stopPropagation(); requestDelete([c.path]); };
    frag.append(row);
  }
  el.append(frag);

  const notes = [];
  if (truncated) notes.push(`${truncated.toLocaleString()} smaller items not shown.`);
  if (visible.length < children.length) notes.push(`${children.length - visible.length} hidden by filters.`);
  $('listNote').textContent = notes.join(' ');
  renderSelectionBar();
}

function renderSelectionBar() {
  const btn = $('deleteSelected');
  const n = state.selected.size;
  btn.classList.toggle('hidden', n === 0);
  btn.textContent = `Delete ${n} selected`;
}

const PALETTE = ['#4c78a8', '#72b7b2', '#54a24b', '#eeca3b', '#f58518', '#e45756', '#b279a2', '#9d755d', '#7f7f7f', '#6a9ec5'];

function renderTreemap(node, children) {
  const el = $('treemap');
  el.innerHTML = '';
  $('mapTitle').textContent = `${node.path} — ${fmt(node.size)}`;
  const w = el.clientWidth, h = el.clientHeight;
  if (w < 20 || h < 20) return;

  const top = children.filter((c) => c.size > 0).slice(0, 120);
  if (!top.length) { el.innerHTML = '<div class="empty">Nothing to show</div>'; return; }
  const shown = top.reduce((a, c) => a + c.size, 0);
  const rest = node.size - shown;
  const values = top.map((c, i) => ({ value: c.size, item: c, color: PALETTE[i % PALETTE.length] }));
  if (rest > shown * 0.02) values.push({ value: rest, item: null, color: 'var(--faint)' });

  for (const r of squarify(values, w, h)) {
    const d = document.createElement('div');
    d.className = 'tile' + (r.w < 42 || r.h < 26 ? ' tiny' : '');
    d.style.cssText = `left:${r.x}px;top:${r.y}px;width:${r.w}px;height:${r.h}px;background:${r.color}`;
    if (r.item) {
      d.innerHTML = `<div class="t-name">${esc(r.item.name)}</div><div class="t-size">${fmt(r.item.size)}</div>`;
      d.title = `${r.item.path}\n${fmt(r.item.size)}${r.item.isDir ? ` · ${r.item.items.toLocaleString()} items` : ''}`;
      d.onclick = () => { if (r.item.isDir) openDir(r.item.path); else requestDelete([r.item.path]); };
    } else {
      d.innerHTML = `<div class="t-name">everything else</div><div class="t-size">${fmt(rest)}</div>`;
      d.style.cursor = 'default';
    }
    el.append(d);
  }
}

/* ---------------------------------------------------------------- search */

let searchTimer;
async function runSearch() {
  const q = $('search').value.trim();
  const min = Number($('minSize').value);
  const olderDays = Number($('olderThan').value);
  if (!q && !min && !olderDays) { if (state.dir) openDir(state.dir.node.path); return; }
  try {
    const data = await api(`/api/search?q=${encodeURIComponent(q)}&min=${min}&olderDays=${olderDays}`);
    state.searchMode = true;
    state.selected.clear();
    $('crumbs').innerHTML = `<span class="crumb current">${data.total.toLocaleString()} match(es)${data.total > 300 ? ' — showing the 300 largest' : ''}</span>`;
    renderRows(data.results, data.results[0]?.size || 1, 0);
    $('treemap').innerHTML = '<div class="empty">Treemap follows the folder view</div>';
    $('mapTitle').textContent = 'Search results';
  } catch (err) { toast(err.message, 'err'); }
}

/* ---------------------------------------------------------------- delete */

async function requestDelete(paths) {
  if (!paths.length) return;
  try {
    const a = await api('/api/assess', { method: 'POST', body: { paths } });
    const blocked = a.verdicts.filter((v) => v.level === 'blocked');
    const allowed = a.verdicts.filter((v) => v.level !== 'blocked');

    if (!allowed.length) {
      await confirmDlg({
        title: 'Cannot delete',
        html: blocked.map((b) => `<div class="warnbox"><strong>${esc(b.path)}</strong><br>${esc(b.reason)}</div>`).join(''),
        okLabel: 'OK',
      });
      return;
    }

    const worst = allowed.some((v) => v.level === 'danger') ? 'danger'
      : allowed.some((v) => v.level === 'caution') ? 'caution' : 'ok';
    const reasons = [...new Set(allowed.flatMap((v) => v.confirm))];
    const total = allowed.reduce((s, v) => s + v.size, 0);

    if (worst !== 'ok' || allowed.length > 1) {
      const html = `
        <p>Moving <strong>${allowed.length}</strong> item(s) — <strong>${fmt(total)}</strong> — to the bin.
        Nothing is erased; you can undo this or restore from the bin.</p>
        ${blocked.length ? `<div class="warnbox">${blocked.length} item(s) will be skipped because they are protected.</div>` : ''}
        ${reasons.length ? `<ul>${reasons.map((r) => `<li>${esc(r)}</li>`).join('')}</ul>` : ''}
        <div class="target-list">${allowed.slice(0, 60).map((v) => `<div>${esc(v.path)} — ${fmt(v.size)}</div>`).join('')}</div>`;
      const ok = await confirmDlg({
        title: worst === 'danger' ? 'This is outside your home folder' : 'Move to bin',
        html, okLabel: `Move ${allowed.length} item(s) to bin`, typed: worst === 'danger',
      });
      if (!ok) return;
    }

    const r = await api('/api/delete', { method: 'POST', body: { paths: allowed.map((v) => v.path), force: true } });
    state.server = r.state;
    state.selected.clear();
    renderStatus();
    if (r.moved.length) toast(`Moved ${r.moved.length} item(s) to the bin — ${fmt(total)} will be freed on purge`, 'ok');
    for (const rj of r.rejected) toast(`${rj.path}: ${rj.reason}`, 'err');
    await reloadCurrent();
  } catch (err) { toast(err.message, 'err'); }
}

async function reloadCurrent() {
  if (state.searchMode) return runSearch();
  if (state.dir) return openDir(state.dir.node.path);
}

async function doUndo() {
  try {
    const r = await api('/api/undo', { method: 'POST' });
    state.server = r.state; renderStatus();
    if (r.ok) {
      toast(`Restored ${r.restored.length} item(s)`, 'ok');
      for (const x of r.restored) if (x.restoredTo !== x.path) toast(`${x.path} was occupied — restored as ${x.restoredTo}`);
    } else toast(r.message || 'Undo failed', 'err');
    for (const f of r.failed || []) toast(`${f.path}: ${f.reason}`, 'err');
    await reloadCurrent(); if (state.tab === 'bin') renderBin();
  } catch (err) { toast(err.message, 'err'); }
}

async function doRedo() {
  try {
    const r = await api('/api/redo', { method: 'POST' });
    state.server = r.state; renderStatus();
    if (r.ok) toast(`Re-deleted ${r.redone.length} item(s)`, 'ok');
    else toast(r.message || 'Redo failed', 'err');
    await reloadCurrent(); if (state.tab === 'bin') renderBin();
  } catch (err) { toast(err.message, 'err'); }
}

/* ------------------------------------------------------------------- bin */

function renderBin() {
  const q = state.server?.quarantine;
  const el = $('binList');
  if (!q || !q.entries.length) {
    el.innerHTML = '<div class="empty">The bin is empty. Deleted items land here first.</div>';
    state.binSelected.clear();
    renderStatus();
    return;
  }
  el.innerHTML = '';
  for (const e of q.entries) {
    const d = document.createElement('div');
    d.className = 'bin-item';
    d.innerHTML = `
      <div class="bin-row">
        <input type="checkbox" ${state.binSelected.has(e.id) ? 'checked' : ''}>
        <span class="ico">${e.isDir ? '▸' : '·'}</span>
        <div style="min-width:0">
          <div><strong>${esc(e.name)}</strong></div>
          <div class="path">${esc(e.path)}</div>
        </div>
        <span class="sz">${fmt(e.dsize)}</span>
        <span class="sz" style="color:var(--muted);font-size:12px">${new Date(e.deletedAt).toLocaleString()}</span>
        <button class="btn small restore">Restore</button>
      </div>`;
    d.querySelector('input').onchange = (ev) => {
      if (ev.target.checked) state.binSelected.add(e.id); else state.binSelected.delete(e.id);
      renderStatus();
    };
    d.querySelector('.restore').onclick = async () => {
      try {
        const r = await api('/api/restore', { method: 'POST', body: { ids: [e.id] } });
        state.server = r.state;
        state.binSelected.delete(e.id);
        renderBin(); renderStatus(); reloadCurrent();
        toast(r.ok ? `Restored ${e.name}` : (r.failed?.[0]?.reason || 'Restore failed'), r.ok ? 'ok' : 'err');
      } catch (err) { toast(err.message, 'err'); }
    };
    el.append(d);
  }
  renderStatus();
}

async function doPurge(ids) {
  const q = state.server.quarantine;
  const targets = ids ? q.entries.filter((e) => ids.includes(e.id)) : q.entries;
  const bytes = targets.reduce((a, e) => a + e.dsize, 0);
  const free = state.server.disk?.avail ?? 0;
  const ok = await confirmDlg({
    title: 'Permanently erase?',
    html: `
      <div class="warnbox"><strong>This cannot be undone.</strong> Undo and Restore stop working for these items.</div>
      <p>Erasing <strong>${targets.length}</strong> item(s) frees <strong>${fmt(bytes)}</strong>.</p>
      <p style="color:var(--muted)">Free space goes from <strong>${fmt(free)}</strong> to <strong>${fmt(free + bytes)}</strong>.</p>
      <div class="target-list">${targets.slice(0, 60).map((e) => `<div>${esc(e.path)} — ${fmt(e.dsize)}</div>`).join('')}</div>`,
    okLabel: `Erase ${targets.length} item(s)`, typed: true,
  });
  if (!ok) return;
  try {
    const r = await api('/api/purge', { method: 'POST', body: { ids: targets.map((e) => e.id) } });
    state.server = r.state;
    state.binSelected.clear();
    renderBin(); renderStatus();
    toast(`Erased ${r.purged} item(s) — ${fmt(r.freed)} freed`, 'ok');
  } catch (err) { toast(err.message, 'err'); }
}

/* ------------------------------------------------------------------ junk */

async function loadJunk() {
  const el = $('junkList');
  el.innerHTML = '<div class="empty">Scanning the tree for junk…</div>';
  try {
    const data = await api('/api/junk');
    $('junkTotal').textContent = data.total ? `${fmt(data.total)} found` : '';
    if (!data.categories.length) { el.innerHTML = '<div class="empty">No junk found above 1 MB. Nice.</div>'; return; }
    el.innerHTML = '';
    for (const cat of data.categories) {
      const d = document.createElement('div');
      d.className = 'junk-cat';
      d.innerHTML = `
        <div class="junk-head">
          <span class="junk-title">${esc(cat.label)}</span>
          <span class="risk ${cat.risk}">${cat.risk}</span>
          <span style="color:var(--muted);font-size:12px">${cat.count} location(s)</span>
          <span class="junk-size">${fmt(cat.size)}</span>
          <button class="btn small danger-outline">Move all to bin</button>
        </div>
        <div class="junk-why">${esc(cat.why)}</div>
        <div class="junk-items hidden">
          ${cat.items.map((i) => `<div class="junk-item"><span class="path">${esc(i.path)}</span><span class="sz">${fmt(i.size)}</span><span class="sz" style="color:var(--muted);font-size:12px">${fmtDate(i.mtime)}</span></div>`).join('')}
        </div>`;
      const items = d.querySelector('.junk-items');
      d.querySelector('.junk-head').onclick = (e) => {
        if (e.target.tagName === 'BUTTON') return;
        items.classList.toggle('hidden');
      };
      d.querySelector('button').onclick = (e) => {
        e.stopPropagation();
        requestDelete(cat.items.map((i) => i.path));
      };
      el.append(d);
    }
  } catch (err) {
    el.innerHTML = `<div class="empty">${esc(err.message)}</div>`;
  }
}

/* -------------------------------------------------------------- duplicates */

let dupeTimer;
async function startDupes() {
  try {
    await api('/api/dupes', { method: 'POST', body: { rootPath: $('dupeRoot').value, minSize: Number($('dupeMin').value) } });
    $('dupeCancel').classList.remove('hidden');
    $('dupeStart').disabled = true;
    clearInterval(dupeTimer);
    dupeTimer = setInterval(pollDupes, 500);
    pollDupes();
  } catch (err) { toast(err.message, 'err'); }
}

async function pollDupes() {
  const d = await api('/api/dupes').catch(() => null);
  if (!d) return;
  if (d.status === 'running') {
    $('dupeStatus').textContent =
      `${d.phase} — ${d.groupsDone}/${d.groupsTotal} size groups checked, ${fmt(d.bytesHashed)} hashed, ${d.groups} duplicate set(s) found`;
    return;
  }
  clearInterval(dupeTimer);
  $('dupeCancel').classList.add('hidden');
  $('dupeStart').disabled = false;
  if (d.status === 'error') { $('dupeStatus').textContent = d.error; return; }
  $('dupeStatus').textContent = d.results.length
    ? `${d.results.length} duplicate set(s) — up to ${fmt(d.wasted)} recoverable${d.phase === 'budget-reached' ? ' (stopped at the hashing budget)' : ''}`
    : 'No duplicates found.';
  renderDupes(d.results);
}

function renderDupes(groups) {
  const el = $('dupeList');
  el.innerHTML = '';
  if (!groups.length) { el.innerHTML = '<div class="empty">No duplicate files found.</div>'; return; }
  for (const g of groups) {
    const d = document.createElement('div');
    d.className = 'dupe-group';
    d.innerHTML = `
      <div class="dupe-head">
        <strong>${fmt(g.size)}</strong> each · ${g.files.length} copies ·
        <span style="color:var(--safe)">${fmt(g.wasted)} recoverable</span>
        <span class="spacer" style="flex:1"></span>
        <button class="btn small danger-outline">Keep the first, bin the rest</button>
      </div>
      ${g.files.map((f, i) => `<div class="dupe-file"><input type="checkbox" ${i === 0 ? '' : 'checked'}><span class="path">${esc(f.path)}</span><span class="sz" style="color:var(--muted);font-size:12px">${fmtDate(f.mtime)}</span></div>`).join('')}`;
    d.querySelector('button').onclick = () => {
      const boxes = [...d.querySelectorAll('.dupe-file input')];
      const paths = g.files.filter((_, i) => boxes[i].checked).map((f) => f.path);
      if (paths.length === g.files.length) { toast('Leave at least one copy unchecked.', 'err'); return; }
      requestDelete(paths);
    };
    el.append(d);
  }
}

/* ------------------------------------------------------------------ wiring */

function switchTab(name, updateHash = true) {
  state.tab = name;
  if (updateHash) history.replaceState(null, '', '#' + name);
  for (const t of document.querySelectorAll('.tab')) t.classList.toggle('active', t.dataset.tab === name);
  for (const v of document.querySelectorAll('.view')) v.classList.toggle('active', v.id === `view-${name}`);
  if (name === 'bin') renderBin();
  if (name === 'explore' && state.dir) renderTreemap(state.dir.node, state.dir.children);
  if (name === 'junk' && !$('junkList').children.length) loadJunk();
}

$('tabs').onclick = (e) => { if (e.target.dataset.tab) switchTab(e.target.dataset.tab); };
$('scanBtn').onclick = () => startScan(false);
$('undoBtn').onclick = doUndo;
$('redoBtn').onclick = doRedo;
$('deleteSelected').onclick = () => requestDelete([...state.selected]);
$('purgeFooter').onclick = () => { switchTab('bin'); doPurge(null); };
$('purgeAll').onclick = () => doPurge(null);
$('purgeSel').onclick = () => doPurge([...state.binSelected]);
$('restoreSel').onclick = async () => {
  try {
    const r = await api('/api/restore', { method: 'POST', body: { ids: [...state.binSelected] } });
    state.server = r.state; state.binSelected.clear();
    renderBin(); reloadCurrent();
    toast(r.ok ? 'Restored' : 'Restore failed', r.ok ? 'ok' : 'err');
  } catch (err) { toast(err.message, 'err'); }
};
$('junkRefresh').onclick = loadJunk;
$('dupeStart').onclick = startDupes;
$('dupeCancel').onclick = () => api('/api/dupes/cancel', { method: 'POST' });
$('search').oninput = () => { clearTimeout(searchTimer); searchTimer = setTimeout(runSearch, 250); };
$('minSize').onchange = $('olderThan').onchange = () => {
  if (state.searchMode || $('search').value.trim()) runSearch();
  else if (state.dir) renderRows(state.dir.children, state.dir.node.size, state.dir.truncated);
};
$('checkAll').onchange = (e) => {
  if (!state.dir) return;
  const rows = state.dir.children.filter(passesFilters);
  state.selected.clear();
  if (e.target.checked) for (const c of rows) state.selected.add(c.path);
  renderRows(state.dir.children, state.dir.node.size, state.dir.truncated);
};

document.addEventListener('keydown', (e) => {
  if (e.metaKey && e.key.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? doRedo() : doUndo(); }
  if (e.key === '/' && document.activeElement.tagName !== 'INPUT') { e.preventDefault(); $('search').focus(); }
  if (e.key === 'Backspace' && document.activeElement.tagName !== 'INPUT' && state.dir) {
    const crumbs = state.dir.crumbs;
    if (crumbs.length > 1) openDir(crumbs[crumbs.length - 2].path);
  }
});

let resizeTimer;
addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => { if (state.dir && state.tab === 'explore') renderTreemap(state.dir.node, state.dir.children); }, 120);
});

/* ------------------------------------------------------------------- boot */

addEventListener('hashchange', () => {
  const t = location.hash.slice(1);
  if (['explore', 'junk', 'dupes', 'bin'].includes(t) && t !== state.tab) switchTab(t, false);
});

(async () => {
  const s = await refreshState();
  $('dupeRoot').value = s.home;
  const initial = location.hash.slice(1);
  if (['junk', 'dupes', 'bin'].includes(initial)) switchTab(initial, false);
  if (s.scan.status === 'ready') { await openDir(s.scan.root); }
  else if (s.scan.status === 'scanning') poll();
})();
