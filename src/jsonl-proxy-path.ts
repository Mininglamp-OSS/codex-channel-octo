import { accessSync, constants, statSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';

let warned = false;
const launchers = new Map<string, string>();
process.once('exit', () => {
  for (const launcher of launchers.values()) rmSync(dirname(launcher), { recursive: true, force: true });
});
const shellQuote = (value: string) => `'${value.replace(/'/g, "'\\''")}'`;

export function resolveJsonlProxyPath(path: string, platform = process.platform): string | undefined {
  if (platform === 'win32') return undefined;
  try {
    if (!statSync(path).isFile()) throw new Error('Not a proxy file');
    accessSync(path, constants.X_OK);
    warned = false;
    const cached = launchers.get(path);
    if (cached) {
      try { accessSync(cached, constants.X_OK); return cached; }
      catch { launchers.delete(path); }
    }
    const launcher = join(mkdtempSync(join(tmpdir(), 'codex-jsonl-launcher-')), 'launcher.sh');
    writeFileSync(launcher, `#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(path)} "$@"\n`, { mode: 0o700 });
    launchers.set(path, launcher);
    return launcher;
  } catch {
    if (!warned) {
      warned = true;
      console.warn('[codex-channel-octo] JSONL proxy missing or not executable; run npm run build; falling back to direct SDK launch (Unicode workaround unavailable).');
    }
    return undefined;
  }
}
