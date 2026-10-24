/**
 * Launch contract of the experimental app-server runtime (T-ARGV, T-ENV and
 * the pre-spawn fence).
 *
 * - argv is fixed: global `-c`/`--disable` flags, then `app-server --listen
 *   stdio://`. `--remote-control` is never passed.
 * - The child env is built from an allowlist, never a copy of `process.env`.
 *   Auth markers and gateway control fields are stripped; `CODEX_HOME` and
 *   the remote-control-disabled marker (exactly `"1"`) are set last.
 * - The fence runs the same binary with the same flags and env as
 *   `features list` and refuses unless every required feature reports
 *   `false`. An unknown feature key exits non-zero, so a Codex bump that
 *   renames a key also refuses. Host-administrative Codex layers must be
 *   absent because a managed `cli_auth_credentials_store` overrides the
 *   ephemeral store set here.
 */
import { execFile } from 'node:child_process';
import { accessSync, constants, readFileSync, realpathSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, isAbsolute, join } from 'node:path';
import type { ThreadOptions } from '@openai/codex-sdk';
import { AgentFailure } from '../agent-failure.js';
import { REQUIRED_DISABLED_CODEX_FEATURES, hostAdministrativeLayersAbsent } from '../cards/tool-host.js';

/** The only Codex release this runtime is verified against. */
export const APP_SERVER_CODEX_VERSION = '0.163.0';

/**
 * Features forced off on every app-server child. The PR71 card list (plugin,
 * connector, hook, skill-installed MCP and code-mode host paths) plus
 * sub-agents (`multi_agent`, whose children could carry dynamic tools) and the
 * app-server daemon auto-start. With `plugins` on, 0.163.0 starts a
 * marketplace `git fetch` at startup whose processes outlive the child.
 */
export const APP_SERVER_REQUIRED_DISABLED_FEATURES: readonly string[] = Object.freeze([
  ...REQUIRED_DISABLED_CODEX_FEATURES, 'multi_agent', 'daemon_auto_start',
]);

/** Remote control is forced to `DisabledEphemeral`; honoured only when exactly `"1"`. */
export const REMOTE_CONTROL_DISABLED_ENV = 'CODEX_INTERNAL_APP_SERVER_REMOTE_CONTROL_DISABLED';

/** Inherited variables a Codex child may need (paths, locale, proxies, CA roots). */
const ENV_ALLOWLIST: ReadonlySet<string> = new Set([
  'PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'TMPDIR', 'TZ', 'TERM', 'LANG', 'LC_ALL', 'LC_CTYPE', 'LC_MESSAGES',
  'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'no_proxy', 'all_proxy',
  'SSL_CERT_FILE', 'SSL_CERT_DIR',
]);

/** Never forwarded, including from the operator's `sdk.env`. */
export const APP_SERVER_STRIPPED_ENV: readonly string[] = Object.freeze([
  'CODEX_ACCESS_TOKEN', 'CODEX_API_KEY', 'OPENAI_FEDERATION_RULE_ID', 'OPENAI_IDENTITY_TOKEN_FILE',
  'OPENAI_WORKLOAD_IDENTITY_CONTEXT', 'CODEX_CHANNEL_EXECUTION_DIR', 'CODEX_CHANNEL_EXECUTION_TOKEN',
]);

function stripped(key: string): boolean {
  return APP_SERVER_STRIPPED_ENV.includes(key) || key.startsWith('CODEX_INTERNAL_') || key === 'CODEX_HOME';
}

/** Child env: allowlisted inherited keys, then `sdk.env`, then the fixed keys. Pure. */
export function buildAppServerEnv(
  sdk: { readonly env?: Readonly<Record<string, string>>; readonly codexHome: string },
  baseEnv: Readonly<Record<string, string | undefined>>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(baseEnv)) {
    if (typeof v === 'string' && ENV_ALLOWLIST.has(k)) out[k] = v;
  }
  for (const [k, v] of Object.entries(sdk.env ?? {})) {
    if (typeof v === 'string' && !stripped(k)) out[k] = v;
  }
  out.CODEX_HOME = sdk.codexHome;
  out[REMOTE_CONTROL_DISABLED_ENV] = '1';
  return out;
}

/** TOML basic string; JSON string escapes are a subset of TOML's. */
function toml(value: string): string {
  return JSON.stringify(value);
}

/** Global flags shared by the child and the fence. Pure. */
export function buildAppServerFlags(input: {
  readonly baseUrl?: string;
  readonly threadOpts: Pick<ThreadOptions, 'modelReasoningEffort' | 'networkAccessEnabled' | 'webSearchMode' | 'approvalPolicy' | 'additionalDirectories'>;
}): string[] {
  const t = input.threadOpts;
  const config = [
    'cli_auth_credentials_store="ephemeral"',
    'forced_login_method="api"',
    ...(input.baseUrl ? [`openai_base_url=${toml(input.baseUrl)}`] : []),
    ...(t.modelReasoningEffort ? [`model_reasoning_effort=${toml(t.modelReasoningEffort)}`] : []),
    ...(t.networkAccessEnabled !== undefined ? [`sandbox_workspace_write.network_access=${t.networkAccessEnabled}`] : []),
    ...(t.webSearchMode ? [`web_search=${toml(t.webSearchMode)}`] : []),
    ...(t.approvalPolicy ? [`approval_policy=${toml(t.approvalPolicy)}`] : []),
    ...(t.additionalDirectories?.length ? [`sandbox_workspace_write.writable_roots=[${t.additionalDirectories.map(toml).join(',')}]`] : []),
  ];
  return [
    ...config.flatMap((c) => ['-c', c]),
    ...APP_SERVER_REQUIRED_DISABLED_FEATURES.flatMap((f) => ['--disable', f]),
  ];
}

/** Full child argv. Never contains `--remote-control`. */
export function buildAppServerArgs(flags: readonly string[]): string[] {
  return [...flags, 'app-server', '--listen', 'stdio://'];
}

const PLATFORM_PACKAGES: Readonly<Record<string, readonly [string, string]>> = Object.freeze({
  'darwin-arm64': ['@openai/codex-darwin-arm64', 'aarch64-apple-darwin'],
  'darwin-x64': ['@openai/codex-darwin-x64', 'x86_64-apple-darwin'],
  'linux-arm64': ['@openai/codex-linux-arm64', 'aarch64-unknown-linux-musl'],
  'linux-x64': ['@openai/codex-linux-x64', 'x86_64-unknown-linux-musl'],
});

/**
 * The packaged native binary of exactly {@link APP_SERVER_CODEX_VERSION}
 * (G-A0), resolved from the installed `@openai/codex` package. Null on
 * any doubt: wrong version, unsupported platform, missing or non-executable.
 */
export function resolvePinnedCodexBinary(platform: string = process.platform, arch: string = process.arch): string | null {
  try {
    const target = PLATFORM_PACKAGES[`${platform}-${arch}`];
    if (target === undefined) return null;
    const cliPkgPath = createRequire(import.meta.url).resolve('@openai/codex/package.json');
    if ((JSON.parse(readFileSync(cliPkgPath, 'utf8')) as { version?: unknown }).version !== APP_SERVER_CODEX_VERSION) return null;
    const cliRequire = createRequire(cliPkgPath);
    const platformPkgPath = cliRequire.resolve(`${target[0]}/package.json`);
    const platformVersion = (JSON.parse(readFileSync(platformPkgPath, 'utf8')) as { version?: unknown }).version;
    if (typeof platformVersion !== 'string' || !platformVersion.startsWith(`${APP_SERVER_CODEX_VERSION}-`)) return null;
    const binary = realpathSync(join(dirname(platformPkgPath), 'vendor', target[1], 'bin', 'codex'));
    if (!statSync(binary).isFile()) return null;
    accessSync(binary, constants.X_OK);
    return binary;
  } catch {
    return null;
  }
}

export type FeatureProbe = (executable: string, args: readonly string[], env: Record<string, string>) => Promise<string>;

const FEATURE_PROBE_TIMEOUT_MS = 5_000;

const defaultFeatureProbe: FeatureProbe = (executable, args, env) => new Promise((resolve, reject) => {
  execFile(executable, [...args], { env, timeout: FEATURE_PROBE_TIMEOUT_MS, maxBuffer: 1024 * 1024, encoding: 'utf8' },
    (error, stdout) => { if (error) reject(error); else resolve(stdout); });
});

/** True only when every required feature is listed and reports `false` under `flags`. */
export async function requiredFeaturesForcedOff(
  executable: string, flags: readonly string[], env: Record<string, string>, probe: FeatureProbe = defaultFeatureProbe,
): Promise<boolean> {
  let listing: string;
  try { listing = await probe(executable, [...flags, 'features', 'list'], env); } catch { return false; }
  const state = new Map<string, string>();
  for (const line of listing.split('\n')) {
    const cols = line.trim().split(/\s+/);
    if (cols.length >= 2) state.set(cols[0], cols[cols.length - 1]);
  }
  return APP_SERVER_REQUIRED_DISABLED_FEATURES.every((f) => state.get(f) === 'false');
}

export interface AppServerLaunch {
  readonly executable: string;
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>>;
}

export interface PrepareLaunchInput {
  readonly codexHome: string | undefined;
  readonly sdkEnv?: Readonly<Record<string, string>>;
  readonly baseUrl?: string;
  readonly threadOpts: ThreadOptions;
  readonly baseEnv?: Readonly<Record<string, string | undefined>>;
  /** Test seams; production uses the pinned binary, the real probe and the host check. */
  readonly executable?: string;
  readonly probe?: FeatureProbe;
  readonly hostLayersAbsent?: () => boolean;
}

function refuse(): AgentFailure {
  return new AgentFailure({ stage: 'prepare', category: 'invalid_config', source: 'local', evidence: 'structured' });
}

/**
 * Resolve and fence one child launch. Every refusal happens before spawn and
 * is a `prepare`-stage failure, which recovery never retries.
 */
export async function prepareAppServerLaunch(input: PrepareLaunchInput): Promise<AppServerLaunch> {
  const codexHome = input.codexHome;
  if (typeof codexHome !== 'string' || !isAbsolute(codexHome)) throw refuse();
  if (!(input.hostLayersAbsent ?? hostAdministrativeLayersAbsent)()) throw refuse();
  const executable = input.executable ?? resolvePinnedCodexBinary();
  if (executable === null) throw refuse();
  const env = buildAppServerEnv({ env: input.sdkEnv, codexHome }, input.baseEnv ?? process.env);
  const flags = buildAppServerFlags({ baseUrl: input.baseUrl, threadOpts: input.threadOpts });
  if (!(await requiredFeaturesForcedOff(executable, flags, env, input.probe))) throw refuse();
  return Object.freeze({ executable, args: Object.freeze(buildAppServerArgs(flags)), env: Object.freeze(env) });
}
