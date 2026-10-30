/**
 * Config validation for output selection: `maxResponseChars` (B7a–B7c) and
 * `sdk.outputSelection`, at boot and through the hot-reload watcher.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, resolveBotConfigs } from '../config.js';
import { watchConfig, type Reconcilable } from '../config-watcher.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'cco-outsel-config-'));
});
afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function writeGlobal(obj: Record<string, unknown>): string {
  const path = join(tmpDir, 'config.json');
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(obj));
  renameSync(tmp, path);
  return path;
}
function writeBot(id: string, obj: Record<string, unknown>): void {
  mkdirSync(join(tmpDir, id), { recursive: true });
  writeFileSync(join(tmpDir, id, 'config.json'), JSON.stringify(obj));
}
function boot(global: Record<string, unknown>) {
  const path = writeGlobal({ apiUrl: 'https://octo.example', bots: [{ id: 'a' }], ...global });
  writeBot('a', { botToken: 'tok-a' });
  return resolveBotConfigs(loadConfig(path));
}

describe('maxResponseChars validation', () => {
  it.each([0, -1, 1.5, '100'])('B7a: boot rejects %s with a named error', (v) => {
    expect(() => boot({ maxResponseChars: v })).toThrow(
      `Bot "a": maxResponseChars must be a positive integer (got ${String(v)})`,
    );
  });

  it.each([1, 10, 44, 45, 1023, 524_288])('B7b: boot accepts the positive integer %i', (v) => {
    const [bot] = boot({ maxResponseChars: v });
    expect(bot.maxResponseChars).toBe(v);
  });

  it('default stays 524288', () => {
    const [bot] = boot({});
    expect(bot.maxResponseChars).toBe(524_288);
  });

  it('B7c: hot reload keeps a previously valid small value; an invalid one is logged and ignored', async () => {
    writeBot('a', { botToken: 'tok-a' });
    writeBot('b', { botToken: 'tok-b' });
    const path = writeGlobal({ apiUrl: 'https://octo.example', maxResponseChars: 10, bots: [{ id: 'a' }] });
    const running = new Set<string>(['a']);
    const added: string[] = [];
    const removed: string[] = [];
    const mgr: Reconcilable = {
      runningKeys: () => [...running],
      addBot: async (id) => { added.push(id); running.add(id); },
      removeBot: async (id) => { removed.push(id); running.delete(id); },
    };
    const logs: string[] = [];
    const h = watchConfig({
      configPath: path,
      manager: mgr,
      loadDesired: () => resolveBotConfigs(loadConfig(path)).map((c) => c.botId!),
      debounceMs: 10,
      log: (msg) => logs.push(msg),
    });
    try {
      // Small value + a new bot: loads, reconciles, no "config invalid".
      writeGlobal({ apiUrl: 'https://octo.example', maxResponseChars: 10, bots: [{ id: 'a' }, { id: 'b' }] });
      await h.applyNow();
      expect(logs.some((l) => l.includes('config invalid'))).toBe(false);
      expect(added).toEqual(['b']);

      // Introducing 0 is rejected; running bots are untouched.
      writeGlobal({ apiUrl: 'https://octo.example', maxResponseChars: 0, bots: [{ id: 'a' }] });
      await h.applyNow();
      expect(logs.some((l) => l.includes('[hot-reload] config invalid, keeping current bots') && l.includes('maxResponseChars'))).toBe(true);
      expect(removed).toEqual([]);
      expect([...running].sort()).toEqual(['a', 'b']);
    } finally {
      h.close();
    }
  });
});

describe('sdk.outputSelection validation', () => {
  it.each([{ enabled: 'true' }, { maxBytes: 0 }, { maxBytes: 1.5 }, { maxBytes: 52428801 }, null])('rejects invalid native image options %j', nativeImages => {
    expect(() => boot({ sdk: { nativeImages } })).toThrow('sdk.nativeImages');
  });
  it('keeps native images opt-in and inherits configured size limits', () => {
    expect(boot({})[0].sdk.nativeImages?.enabled).not.toBe(true);
    expect(boot({ sdk: { nativeImages: { enabled: true, maxBytes: 1048576 } } })[0].sdk.nativeImages).toEqual({ enabled: true, maxBytes: 1048576 });
  });
  it.each(['final', 'phase', 'heuristic', 'legacy'])('accepts %s', (mode) => {
    const [bot] = boot({ sdk: { outputSelection: mode } });
    expect(bot.sdk.outputSelection).toBe(mode);
  });

  it('defaults to unset (final at runtime)', () => {
    const [bot] = boot({});
    expect(bot.sdk.outputSelection).toBeUndefined();
  });

  it.each(['last', 'all', 'Phase'])('rejects %s at boot', (mode) => {
    expect(() => boot({ sdk: { outputSelection: mode } })).toThrow(
      `Bot "a": invalid sdk.outputSelection '${mode}' (allowed: final, phase, heuristic, legacy)`,
    );
  });
});
