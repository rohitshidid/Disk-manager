import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { uid } from './util.js';

/** Escape a JS string for embedding in an AppleScript string literal. */
function asQuote(s) {
  return '"' + String(s).replaceAll('\\', '\\\\').replaceAll('"', '\\"') + '"';
}

export class UserCancelled extends Error {
  constructor() { super('Administrator prompt was cancelled.'); this.name = 'UserCancelled'; }
}

/**
 * Run a /bin/sh script as root via the native macOS authorization dialog.
 *
 * The script body goes to a private temp file rather than being interpolated
 * into the AppleScript, so filenames with quotes, spaces or newlines can't
 * break out of the command. Every call shows one password prompt, so callers
 * batch all their work into a single script.
 */
export async function runElevated(scriptBody, { prompt = 'Disk Manager needs administrator access.' } = {}) {
  const file = path.join(os.tmpdir(), `diskmanager-${uid()}.sh`);
  await fs.writeFile(file, '#!/bin/sh\nset -e\n' + scriptBody + '\n', { mode: 0o700 });
  try {
    const stmt = `do shell script "/bin/sh " & quoted form of ${asQuote(file)}`
      + ` with prompt ${asQuote(prompt)} with administrator privileges`;
    return await new Promise((resolve, reject) => {
      execFile('osascript', ['-e', stmt], { maxBuffer: 1 << 26 }, (err, stdout, stderr) => {
        if (err) {
          const msg = String(stderr || err.message);
          if (/User cancell?ed|-128/.test(msg)) return reject(new UserCancelled());
          return reject(new Error(msg.trim() || 'Elevated command failed.'));
        }
        resolve(String(stdout));
      });
    });
  } finally {
    await fs.rm(file, { force: true }).catch(() => {});
  }
}
