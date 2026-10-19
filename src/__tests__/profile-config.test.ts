import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_CONFIG_PATH, loadConfig } from '../config.js';

const roots: string[] = [];
afterEach(() => { vi.unstubAllEnvs(); roots.splice(0).forEach(p => rmSync(p, { recursive: true })); });
it('loads an explicitly enabled isolated profile instead of the shared config', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'env02-'))); roots.push(root);
  mkdirSync(join(root, 'config'), { mode: 0o700 });
  const path = join(root, 'config/config.json');
  writeFileSync(path, JSON.stringify({ apiUrl: 'https://example.com', bots: [] }), { mode: 0o600 });
  vi.stubEnv('CODEX_OCTO_TEST_PROFILE_ROOT', root);
  vi.stubEnv('CODEX_OCTO_TEST_CONFIG_PATH', path);
  expect(loadConfig().baseDir).toBe(join(root, 'config'));
});
it('refuses a path override without the test profile switch', () => {
  vi.stubEnv('CODEX_OCTO_TEST_PROFILE_ROOT', '');
  vi.stubEnv('CODEX_OCTO_TEST_CONFIG_PATH', '/tmp/unsafe-config.json');
  expect(() => loadConfig()).toThrow(/profile/i);
});
it('preserves the exported default path', () => {
  expect(DEFAULT_CONFIG_PATH).toMatch(/\.codex-channel-octo\/config.json$/);
});

it.each(['same', 'inside', 'ancestor'])('rejects the %s shared-home overlap before reading paths', relation => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'env02-overlap-'))); roots.push(base);
  const shared = join(base, '.codex-channel-octo');
  const root = relation === 'same' ? shared : relation === 'inside' ? join(shared, 'test-a') : base;
  vi.stubEnv('CODEX_OCTO_TEST_SHARED_HOME', base);
  vi.stubEnv('CODEX_OCTO_TEST_PROFILE_ROOT', root);
  vi.stubEnv('CODEX_OCTO_TEST_CONFIG_PATH', join(root, 'config/config.json'));
  expect(() => loadConfig()).toThrow('overlaps shared configuration');
});
