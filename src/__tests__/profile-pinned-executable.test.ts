import { afterEach, expect, it, vi } from 'vitest';
import { chmodSync, mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { queryAgentEvents } from '../agent-bridge.js';
import type { Config } from '../config.js';
import type { ManagedExecution } from '../execution-scope.js';
const roots: string[] = [];
afterEach(() => { vi.unstubAllEnvs(); roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })); });
function config(): Config {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'profile-pinned-'))); roots.push(root);
  return { cards: { disable: false, eventTransport: 'off', reasoningSummary: 'off' }, baseDir: root, cwd: root, dataDir: root, maxResponseChars: 524288, dispatchTimeoutMs: 10000, botToken: 'synthetic', apiUrl: 'https://example.com', sdk: {}, rateLimit: { maxPerMinute: 10 }, context: { maxContextChars: 100, historyLimit: 10 } };
}
async function drain(c: Config) { for await (const event of queryAgentEvents('synthetic', c)) void event; }
it('rejects a pinned executable without an isolated root before SDK construction', async () => {
  vi.stubEnv('CODEX_OCTO_TEST_CODEX_PATH', '/never-executed');
  vi.stubEnv('CODEX_OCTO_TEST_PROFILE_ROOT', '');
  await expect(drain(config())).rejects.toThrow('Pinned test executable requires an isolated profile');
});
it('rejects a half-configured root instead of trusting a nonempty switch', async () => {
  const c = config();
  vi.stubEnv('CODEX_OCTO_TEST_CODEX_PATH', '/never-executed');
  vi.stubEnv('CODEX_OCTO_TEST_PROFILE_ROOT', c.cwd);
  vi.stubEnv('CODEX_OCTO_TEST_CONFIG_PATH', '');
  await expect(drain(c)).rejects.toThrow('Invalid test profile configuration');
});
it.skipIf(process.platform === 'win32')('pins an executable script while retaining real SDK/proxy managed stop proof', async () => {
  const c = config(); const root = c.cwd;
  mkdirSync(join(root, 'config'), { mode: 0o700 });
  const path = join(root, 'config/config.json');
  writeFileSync(path, '{"apiUrl":"https://example.com","bots":[]}', { mode: 0o600 });
  const fixture = fileURLToPath(new URL('./fixtures/owned-cli.mjs', import.meta.url)); chmodSync(fixture, 0o755);
  vi.stubEnv('CODEX_OCTO_TEST_CODEX_PATH', fixture);
  vi.stubEnv('CODEX_OCTO_TEST_PROFILE_ROOT', root);
  vi.stubEnv('CODEX_OCTO_TEST_CONFIG_PATH', path);
  c.sdk.env = { OWNED_UNICODE: 'pinned managed fixture' };
  const scopes: ManagedExecution[] = []; const messages: string[] = [];
  try {
    for await (const ev of queryAgentEvents('synthetic', c, undefined, undefined, { onManagedExecution: scope => scopes.push(scope) })) {
      if (ev.kind === 'message') messages.push(ev.text);
    }
    expect(messages).toEqual(['pinned managed fixture']);
    expect(scopes).toHaveLength(1);
    expect(await scopes[0].waitForStopped(4000)).toBe(true);
  } finally { scopes.forEach(scope => scope.dispose()); }
}, 10000);
