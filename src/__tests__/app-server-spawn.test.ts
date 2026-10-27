/**
 * App-server launch contract: T-ARGV, T-ENV, the pinned binary (G-A0) and the
 * fail-closed pre-spawn fence.
 */
import { describe, it, expect } from 'vitest';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  APP_SERVER_REQUIRED_DISABLED_FEATURES, APP_SERVER_STRIPPED_ENV, REMOTE_CONTROL_DISABLED_ENV,
  buildAppServerArgs, buildAppServerEnv, buildAppServerFlags, prepareAppServerLaunch,
  requiredFeaturesForcedOff, resolvePinnedCodexBinary, type FeatureProbe,
} from '../app-server/spawn.js';
import { AgentFailure } from '../agent-failure.js';
import { REQUIRED_DISABLED_CODEX_FEATURES } from '../cards/tool-host.js';

const listing = (overrides: Record<string, string> = {}): string => [
  ...APP_SERVER_REQUIRED_DISABLED_FEATURES.map((f) => `${f}  stable  ${overrides[f] ?? 'false'}`),
  'shell_tool  stable  true',
].join('\n') + '\n';

const okProbe: FeatureProbe = async () => listing();
const threadOpts = { sandboxMode: 'read-only', approvalPolicy: 'never', modelReasoningEffort: 'medium', networkAccessEnabled: false, webSearchMode: 'disabled' } as const;

describe('T-ARGV', () => {
  const flags = buildAppServerFlags({ baseUrl: 'https://gw.example/v1', threadOpts });
  const args = buildAppServerArgs(flags);

  it('ends with the stdio app-server subcommand and never enables remote control', () => {
    expect(args.slice(-3)).toEqual(['app-server', '--listen', 'stdio://']);
    expect(args.some((a) => /remote.control/i.test(a) && a.startsWith('--'))).toBe(false);
  });

  it('forces the ephemeral credential store and API-key login', () => {
    expect(flags).toContain('cli_auth_credentials_store="ephemeral"');
    expect(flags).toContain('forced_login_method="api"');
  });

  it('disables every required feature, including the PR71 card list', () => {
    for (const f of [...REQUIRED_DISABLED_CODEX_FEATURES, 'multi_agent', 'daemon_auto_start']) {
      const i = flags.indexOf(f);
      expect(i).toBeGreaterThan(0);
      expect(flags[i - 1]).toBe('--disable');
    }
  });

  it('quotes values as TOML strings', () => {
    expect(flags).toContain('openai_base_url="https://gw.example/v1"');
    expect(buildAppServerFlags({ threadOpts: { additionalDirectories: ['/a "b"'] } }))
      .toContain('sandbox_workspace_write.writable_roots=["/a \\"b\\""]');
  });
});

describe('T-ENV', () => {
  const base = {
    PATH: '/usr/bin', HOME: '/home/x', HTTPS_PROXY: 'http://p', RANDOM_SECRET: 'nope',
    CODEX_ACCESS_TOKEN: 't', CODEX_API_KEY: 'k', OPENAI_IDENTITY_TOKEN_FILE: '/f',
    CODEX_CHANNEL_EXECUTION_TOKEN: 'c', CODEX_HOME: '/wrong', [REMOTE_CONTROL_DISABLED_ENV]: '0',
  };

  it('copies only allowlisted inherited keys', () => {
    const env = buildAppServerEnv({ codexHome: '/bot/home' }, base);
    expect(env.PATH).toBe('/usr/bin');
    expect(env.HTTPS_PROXY).toBe('http://p');
    expect(env.RANDOM_SECRET).toBeUndefined();
  });

  it('strips auth markers and control fields, even from sdk.env', () => {
    const sdkEnv = Object.fromEntries(APP_SERVER_STRIPPED_ENV.map((k) => [k, 'x']));
    const env = buildAppServerEnv({ codexHome: '/bot/home', env: { ...sdkEnv, CODEX_INTERNAL_X: 'y', PROVIDER_KEY: 'ok' } }, base);
    for (const k of APP_SERVER_STRIPPED_ENV) expect(env[k]).toBeUndefined();
    expect(env.CODEX_INTERNAL_X).toBeUndefined();
    expect(env.PROVIDER_KEY).toBe('ok');
  });

  it('sets CODEX_HOME and the remote-control marker to exactly "1", overriding inherited values', () => {
    const env = buildAppServerEnv({ codexHome: '/bot/home', env: { CODEX_HOME: '/evil', [REMOTE_CONTROL_DISABLED_ENV]: '0' } }, base);
    expect(env.CODEX_HOME).toBe('/bot/home');
    expect(env[REMOTE_CONTROL_DISABLED_ENV]).toBe('1');
  });
});

describe('pre-spawn fence', () => {
  it('accepts only when every required feature reports false', async () => {
    expect(await requiredFeaturesForcedOff('/bin/codex', [], {}, okProbe)).toBe(true);
    for (const f of APP_SERVER_REQUIRED_DISABLED_FEATURES) {
      expect(await requiredFeaturesForcedOff('/bin/codex', [], {}, async () => listing({ [f]: 'true' }))).toBe(false);
    }
  });

  it('refuses a listing that omits a required feature, and a failing probe', async () => {
    expect(await requiredFeaturesForcedOff('/bin/codex', [], {}, async () => 'plugins stable false\n')).toBe(false);
    expect(await requiredFeaturesForcedOff('/bin/codex', [], {}, async () => { throw new Error('Unknown feature flag'); })).toBe(false);
  });

  it('probes with the same flags and env the child gets', async () => {
    const seen: Array<{ args: readonly string[]; env: Record<string, string> }> = [];
    const launch = await prepareAppServerLaunch({
      codexHome: '/bot/home', threadOpts, executable: '/bin/codex', hostLayersAbsent: () => true, baseEnv: { PATH: '/usr/bin' },
      probe: async (_e, args, env) => { seen.push({ args, env }); return listing(); },
    });
    expect(seen[0].args.slice(-2)).toEqual(['features', 'list']);
    expect(seen[0].args.slice(0, -2)).toEqual(launch.args.slice(0, -3));
    expect(seen[0].env).toEqual(launch.env);
  });

  it.each([
    ['a relative CODEX_HOME', { codexHome: 'rel' }],
    ['no CODEX_HOME', { codexHome: undefined }],
    ['host-administrative layers', { hostLayersAbsent: () => false }],
    ['a feature left on', { probe: async () => listing({ plugins: 'true' }) }],
  ])('refuses before spawn on %s', async (_name, override) => {
    const err = await prepareAppServerLaunch({
      codexHome: '/bot/home', threadOpts, executable: '/bin/codex', hostLayersAbsent: () => true, probe: okProbe, ...override,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AgentFailure);
    expect((err as AgentFailure).snapshot.stage).toBe('prepare');
  });
});

describe('G-A0 pinned binary', () => {
  it('resolves the packaged 0.163.0 native binary on a supported platform', () => {
    const bin = resolvePinnedCodexBinary();
    if (process.platform === 'darwin' || process.platform === 'linux') {
      expect(bin).not.toBeNull();
      expect(bin).toMatch(/codex$/);
    }
  });

  it('refuses an unsupported platform', () => {
    expect(resolvePinnedCodexBinary('win32', 'x64')).toBeNull();
  });
});

describe('real binary fence (packaged 0.163.0)', () => {
  const bin = resolvePinnedCodexBinary();
  it.runIf(bin !== null)('reports every required feature forced off, and an unknown key fails closed', async () => {
    const home = mkdtempSync(join(tmpdir(), 'cco-fence-'));
    try {
      const env = buildAppServerEnv({ codexHome: home }, { PATH: process.env.PATH });
      const flags = buildAppServerFlags({ threadOpts });
      expect(await requiredFeaturesForcedOff(bin!, flags, env)).toBe(true);
      expect(await requiredFeaturesForcedOff(bin!, ['--disable', 'no_such_feature_x', ...flags], env)).toBe(false);
      // Without the --disable list the default build leaves plugins on.
      expect(await requiredFeaturesForcedOff(bin!, [], env)).toBe(false);
      expect(existsSync(join(home, 'auth.json'))).toBe(false);
    } finally { rmSync(home, { recursive: true, force: true }); }
  });
});
