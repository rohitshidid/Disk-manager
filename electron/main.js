/**
 * Desktop shell for Disk Manager.
 *
 * The app is a local HTTP server plus a page. Packaging it as an Electron
 * bundle changes three things that matter, none of them cosmetic:
 *
 *   1. Full Disk Access attaches to *this* bundle. Run from a terminal, the
 *      consent belongs to whichever terminal app launched it, which is the
 *      single most confusing thing about the CLI version -- you grant access
 *      to "Antigravity IDE" to let a disk tool read your Desktop.
 *   2. Node and ncdu ship inside, so nothing has to be installed first.
 *   3. Quitting the window stops the server, so nothing is left listening.
 *
 * The server runs as a child process rather than inside the main process: it
 * holds a multi-hundred-megabyte tree and spawns privileged helpers, and a
 * crash in there should cost a restart, not the window.
 */
import { app, BrowserWindow, Menu, shell, dialog } from 'electron';
import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

/** ncdu lives in Contents/Resources/bin once packaged, and in the repo's own
 *  vendor/ directory when this is run from a checkout. */
function bundledNcdu() {
  const candidates = app.isPackaged
    ? [path.join(process.resourcesPath, 'bin', 'ncdu')]
    : [path.join(ROOT, 'vendor', 'bin', 'ncdu')];
  return candidates.find((p) => fs.existsSync(p)) || '';
}

let win = null;
let child = null;
let serverUrl = null;
let stderrTail = '';

function startServer() {
  return new Promise((resolve, reject) => {
    const entry = path.join(ROOT, 'server', 'index.js');
    child = spawn(process.execPath, [entry], {
      cwd: ROOT,
      env: {
        ...process.env,
        // Run this Electron binary as a plain Node process.
        ELECTRON_RUN_AS_NODE: '1',
        NODE_OPTIONS: '--max-old-space-size=4096',
        DM_ANNOUNCE: '1',
        DM_NCDU: bundledNcdu(),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let out = '';
    const timer = setTimeout(() => reject(new Error('The Disk Manager server did not start within 20 seconds.')), 20_000);

    child.stdout.on('data', (d) => {
      out += d.toString();
      const m = out.match(/DM_READY (http:\/\/127\.0\.0\.1:\d+\/)/);
      if (m) { clearTimeout(timer); serverUrl = m[1]; resolve(m[1]); }
    });
    child.stderr.on('data', (d) => {
      stderrTail = (stderrTail + d.toString()).slice(-4000);
      process.stderr.write(d);
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      child = null;
      if (serverUrl) return;   // already up; an exit now is handled below
      reject(new Error(`The server exited with code ${code}.\n\n${stderrTail}`));
    });
    child.on('error', (err) => { clearTimeout(timer); reject(err); });
  });
}

function createWindow(url) {
  win = new BrowserWindow({
    width: 1340,
    height: 860,
    minWidth: 940,
    minHeight: 620,
    title: 'Disk Manager',
    backgroundColor: '#12141a',
    titleBarStyle: 'hiddenInset',
    webPreferences: {
      // The page is our own, served from 127.0.0.1 behind a per-run token, and
      // it needs no Node access of its own: everything privileged happens in
      // the server process, over HTTP.
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  });
  // The page needs to know it is in the shell rather than a browser tab: the
  // window has no title bar of its own, so the header has to leave room for
  // the traffic lights drawn over it.
  win.loadURL(url + '?shell=desktop');
  // Anything that is not our own page opens in the user's browser rather than
  // in a chromeless Electron window with no address bar.
  win.webContents.setWindowOpenHandler(({ url: target }) => {
    if (!target.startsWith('http://127.0.0.1:')) shell.openExternal(target);
    return { action: 'deny' };
  });
  win.on('closed', () => { win = null; });
}

function buildMenu() {
  const template = [
    { role: 'appMenu' },
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        { role: 'reload' }, { role: 'forceReload' }, { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' },
        { type: 'separator' }, { role: 'togglefullscreen' },
      ],
    },
    { role: 'windowMenu' },
    {
      role: 'help',
      submenu: [
        {
          label: 'Open Full Disk Access settings…',
          click: () => shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles'),
        },
        {
          label: 'Project on GitHub',
          click: () => shell.openExternal('https://github.com/rohitshidid/Disk-manager'),
        },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// One server, one window. A second launch focuses what is already running
// rather than starting a second scan against the same quarantine manifest.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) { if (win.isMinimized()) win.restore(); win.focus(); }
  });

  app.whenReady().then(async () => {
    buildMenu();
    try {
      const url = await startServer();
      createWindow(url);
    } catch (err) {
      dialog.showErrorBox('Disk Manager could not start', err.message);
      app.quit();
    }
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0 && serverUrl) createWindow(serverUrl);
    });
  });

  app.on('window-all-closed', () => { app.quit(); });

  // The server holds the quarantine manifest open; give it a chance to finish
  // a write before the process group goes away.
  app.on('before-quit', () => {
    if (child) { try { child.kill('SIGTERM'); } catch {} }
  });
}
