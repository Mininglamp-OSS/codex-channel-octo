import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveJsonlProxyPath } from '../jsonl-proxy-path.js';

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'proxy-path-')); });
afterEach(() => { vi.restoreAllMocks(); rmSync(root, { recursive: true, force: true }); });

describe('proxy availability fallback', () => {
  it('returns no override for missing or non-file artifacts with actionable safe diagnostics', () => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(resolveJsonlProxyPath(join(root, 'missing'), 'linux')).toBeUndefined();
    expect(JSON.stringify(warning.mock.calls)).toContain('npm run build');
    const directory = join(root, 'directory');
    mkdirSync(directory);
    expect(resolveJsonlProxyPath(directory, 'linux')).toBeUndefined();
    expect(JSON.stringify(warning.mock.calls)).not.toContain(root);
  });
  it.skipIf(process.platform === 'win32')('selects executable artifacts and rejects ones without execute permissions', () => {
    const file = join(root, 'proxy.mjs');
    writeFileSync(file, '', { mode: 0o755 });
    expect(resolveJsonlProxyPath(file, 'linux')).toMatch(/launcher\.sh$/);
    chmodSync(file, 0o644);
    expect(resolveJsonlProxyPath(file, 'linux')).toBeUndefined();
  });
  it('keeps Windows on the direct SDK path', () => {
    const file = join(root, 'executable.mjs');
    writeFileSync(file, '', { mode: 0o755 });
    expect(resolveJsonlProxyPath(file, 'win32')).toBeUndefined();
  });
  it.skipIf(process.platform === 'win32')('warns again when an available artifact disappears after recovery', () => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const file = join(root, 'recovered.mjs');
    writeFileSync(file, '', { mode: 0o755 });
    resolveJsonlProxyPath(file, 'linux');
    rmSync(file);
    resolveJsonlProxyPath(file, 'linux');
    expect(warning).toHaveBeenCalledTimes(1);
    writeFileSync(file, '', { mode: 0o755 });
    resolveJsonlProxyPath(file, 'linux');
    rmSync(file);
    resolveJsonlProxyPath(file, 'linux');
    expect(warning).toHaveBeenCalledTimes(2);
  });
});
