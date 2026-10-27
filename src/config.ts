import { validateRecovery, type RecoveryConfig } from './agent-recovery.js';
import { preserveConfigSuppression } from './inbound-route-facts.js';
/**
 * Configuration loading.
 *
 * Two-layer, bot-first model:
 *  - GLOBAL `~/.codex-channel-octo/config.json` — shared defaults + a `bots` list.
 *    Never holds a botToken.
 *  - PER-BOT `~/.codex-channel-octo/<id>/config.json` — that bot's botToken + any
 *    overrides. Each bot is a self-contained subtree:
 *      <baseDir>/<id>/{config.json, SOUL.md, data/, workspace/, memory/}
 *  - `baseDir` is the directory containing the global config.json. Per-bot dirs
 *    are DERIVED from `<baseDir>/<id>/…` (not separately configurable) so a bot
 *    can never point its data outside its own subtree.
 *
 * env overrides still apply to the shared/global layer.
 */

import { readFileSync, existsSync, statSync, realpathSync, lstatSync } from 'node:fs';
import { resolve as resolvePath, sep, dirname, join as pathJoin, isAbsolute } from 'node:path';
import { homedir } from 'node:os';
import { isAllowedApiUrl } from './url-policy.js';

/**
 * Default global config path: `~/.codex-channel-octo/config.json`. This is the
 * fixed production location. Explicit library paths and the opt-in test-profile
 * seam also set `baseDir` to the selected file's directory.
 */
export const DEFAULT_CONFIG_PATH = pathJoin(homedir(), '.codex-channel-octo', 'config.json');

/** Opt-in seam used only by the governed test-profile launcher. */
export function runtimeConfigPath(): string {
  const root = process.env.CODEX_OCTO_TEST_PROFILE_ROOT;
  const path = process.env.CODEX_OCTO_TEST_CONFIG_PATH;
  if (!root && !path) return DEFAULT_CONFIG_PATH;
  if (!root || !path || !isAbsolute(root) || root.split(sep).includes('..') ||
      path !== pathJoin(root, 'config', 'config.json')) {
    throw new Error('Invalid test profile configuration: set both CODEX_OCTO_TEST_PROFILE_ROOT and CODEX_OCTO_TEST_CONFIG_PATH to the isolated config/config.json path');
  }
  if (typeof process.getuid !== 'function') throw new Error('Test profiles require a POSIX platform');
  const shared = pathJoin(process.env.CODEX_OCTO_TEST_SHARED_HOME ?? homedir(), '.codex-channel-octo');
  if (root === shared || isPathInside(root, shared) || isPathInside(shared, root)) {
    throw new Error('Test profile overlaps shared configuration');
  }
  for (let cursor = path; ; cursor = dirname(cursor)) {
    const st = lstatSync(cursor);
    if (st.isSymbolicLink()) throw new Error('Test profile symlink refused');
    if (cursor === path && (!st.isFile() || st.nlink !== 1 || st.uid !== process.getuid?.() || (st.mode & 0o777) !== 0o600)) {
      throw new Error('Test profile config must be a 0600 regular file');
    }
    if (cursor !== path && (cursor === root || isPathInside(cursor, root))) {
      if (!st.isDirectory() || st.uid !== process.getuid?.() || (st.mode & 0o777) !== 0o700) throw new Error('Test profile directories must be private 0700');
    }
    if (dirname(cursor) === cursor) break;
  }
  return path;
}

/** Local preferences only: none of these fields grants server or routing authority. */
export interface CardConfig {
  /** Local kill switch only; false grants nothing. Default false. */
  disable: boolean;
  /** Requires independent topology/authorization proof before intake. Default off. */
  eventTransport: 'off' | 'short' | 'long';
  /** Requires independent source/privacy/authorization proof. Default off. */
  reasoningSummary: 'off' | 'on' | 'stream';
}

export interface Config {
  /**
   * Independent, frozen per-Bot startup snapshot. Same-ID watcher reconciliation
   * does not restart a Bot; edits require restart or explicit remove/re-add.
   */
  readonly cards: Readonly<CardConfig>;
  botToken: string;
  apiUrl: string;
  /**
   * Base directory containing the global config.json. Every bot's subtree lives
   * at `<baseDir>/<botId>/…`. Defaults to `~/.codex-channel-octo` (the dir of
   * DEFAULT_CONFIG_PATH); when an explicit config path is passed, it is that
   * file's directory.
   */
  baseDir: string;
  /**
   * DERIVED (not user-configurable): per-session cwd sandbox base for THIS bot,
   * `<baseDir>/<botId>/workspace`. Each (DM peer | group channel) gets its own
   * hashed subdir under it via `cwd-resolver.resolveSessionCwd()`. Populated by
   * `resolveBotConfigs()`.
   */
  cwdBase?: string;
  /**
   * @deprecated Alias of `cwdBase`, kept in sync so hand-built Config objects
   * (tests, legacy consumers reading `config.cwd`) still compile.
   */
  cwd: string;
  /**
   * DERIVED (not user-configurable): SQLite/data dir for THIS bot,
   * `<baseDir>/<botId>/data`. Populated by `resolveBotConfigs()`.
   */
  dataDir: string;
  /**
   * DERIVED (not user-configurable): SDK auto-memory base for THIS bot,
   * `<baseDir>/<botId>/memory`. Each session gets a hashed subdir under it (same
   * partitioning as the cwd sandbox: group=shared per channel, DM=private per
   * peer). Separate from the cwd sandbox so the 7-day cwd TTL never reclaims
   * memory. Populated by `resolveBotConfigs()`.
   */
  memoryBase?: string;
  /**
   * v1.0: directory of per-group instruction files (`<groupId>.md`). When set,
   * a matching file's contents are injected into the system prompt as trusted
   * custom instructions for that group. Operator-controlled — must NOT be the
   * per-session cwd sandbox (which the agent can write). Unset = feature off.
   */
  groupConfigDir?: string;
  privateMemory?: { enabled?: boolean; maxBytes?: number };
  sdk: {
    /** Codex model id (e.g. gpt-5.5). Omitted → codex default. */
    model?: string;
    /**
     * Codex approval policy: 'never' | 'on-request' | 'on-failure' | 'untrusted'.
     * Default 'never' (headless — no human to answer prompts). NOTE: under
     * headless operation approval cannot be satisfied interactively, so the real
     * permission boundary is `sandboxMode`, NOT this.
     */
    approvalPolicy?: string;
    /**
     * Codex sandbox: 'read-only' | 'workspace-write' | 'danger-full-access'.
     * Default 'read-only'. IM input is untrusted, so the bot must not let an
     * arbitrary user drive Codex into writing local files by default. To allow
     * the bot to edit code, the operator must BOTH set `allowWorkspaceWrite:true`
     * AND `sandboxMode:'workspace-write'` (double switch, guards against misconfig).
     * 'danger-full-access' explicitly disables Codex sandboxing. Use it only
     * when an external boundary, such as a dedicated container, isolates the bot.
     */
    sandboxMode?: string;
    /**
     * Gate for workspace-write: even if `sandboxMode:'workspace-write'` is set,
     * it only takes effect when this is true; otherwise it is downgraded to
     * read-only. Default false. The prompt security prefix is a SOFT constraint
     * (a model can be talked around it); the sandbox is the hard boundary.
     */
    allowWorkspaceWrite?: boolean;
    /**
     * Codex reasoning effort: 'minimal' | 'low' | 'medium' | 'high' | 'xhigh'.
     * Default 'medium'. NOTE 'minimal' conflicts with web search — when
     * webSearchEnabled is true, do not pair it with 'minimal'.
     */
    modelReasoningEffort?: string;
    /** Allow sandboxed network access. Default false; ineffective in danger-full-access. */
    networkAccessEnabled?: boolean;
    /** Enable web search tool. Default false. */
    webSearchEnabled?: boolean;
    /** Web search mode: 'disabled' | 'cached' | 'live'. Default 'disabled'. */
    webSearchMode?: string;
    /**
     * Per-bot CODEX_HOME (codex's auth/config/sessions/memory root). Default
     * `<baseDir>/<botId>/codex-home` so each bot is isolated and IM content does
     * NOT land in the operator's personal `~/.codex`. To deliberately share the
     * personal codex (so IM threads can be resumed from your own terminal), set
     * this to the personal `~/.codex` — opt-in only. Populated by
     * resolveBotConfigs() when unset.
     */
    codexHome?: string;
    /** Operator-provided global system instructions (prepended to the prompt). */
    systemPrompt?: string;
    /**
     * When true, the bot sends brief, REDACTED progress messages (command run,
     * file changed, tool called) as Codex works through a turn — so users see
     * activity during long turns. Default false. Env:
     * `CODEX_OCTO_SDK_TOOL_PROGRESS=true`. Progress is field-whitelisted (no
     * stdout/stderr, no diff, no full args) — see agent-bridge.
     */
    toolProgress?: boolean;
    /** Bounded pre-execution recovery. Default disabled. */
    recovery?: RecoveryConfig;
    /** Opt-in local failure metadata/fingerprints; never raw SDK or tool text. */
    privateDiagnostics?: boolean;
    /** Additional allowlisted SDK metadata; requires privateDiagnostics too. Default off. */
    privateDiagnosticsDetails?: boolean;
    /**
     * How the user-facing reply is selected from a turn's agent messages:
     * - `final` (default): all explicitly labeled final parts, otherwise the last
     *   useful non-commentary item regardless of earlier message lengths.
     *   Ordering fallback, not a final signal.
     * - `phase` (compatibility): known final answers when the runtime labels them,
     *   otherwise every message not known to be commentary, joined with a
     *   blank line. SDK/CLI 0.142.3 labels nothing, so commentary is still
     *   delivered.
     * - `heuristic` (opt-in): additionally keeps only the messages after the
     *   turn's last work item (tool call / command / file change), unless that
     *   would drop a long earlier message. Ordering-based, not a final signal.
     * - `legacy` (rollback): the pre-selection behavior (all messages of the
     *   final run, concatenated without a separator).
     * Delivery and stored history always use the same selected text. Applied
     * at bot start: an edit takes effect after a process restart (or after
     * re-adding the bot under a new id).
     */
    outputSelection?: string;
    /**
     * Codex runtime for managed turns:
     * - `exec` (default): the SDK `codex exec` path, unchanged.
     * - `app-server` (experimental): a gateway-owned `codex app-server` stdio
     *   child per attempt, pinned to the packaged 0.163.0 binary. Only managed
     *   turns use it; card injection and production card ops stay off.
     */
    runtime?: string;
    /**
     * Override the Codex upstream base URL (e.g. self-hosted provider gateway).
     * Forwarded to `new Codex({ baseUrl })`.
     */
    codexBaseUrl?: string;
    /**
     * API key for the Codex upstream provider. Forwarded to `new Codex({ apiKey })`.
     * Written by the `configure` subcommand; persisted in the global config.
     */
    codexApiKey?: string;
    /**
     * Extra environment variables injected verbatim into the Codex subprocess (on
     * top of inherited process.env + CODEX_HOME). Generic and declarative. Use it
     * to give a bot's provider routing or its tools the env they need. Per-bot.
     */
    env?: Record<string, string>;
    /**
     * Extra directories added to the Codex sandbox's writable roots (SDK
     * ThreadOptions.additionalDirectories). Only meaningful under
     * sandboxMode:'workspace-write' + allowWorkspaceWrite:true; ignored under
     * read-only. Each entry MUST be an absolute path — relative or '~' entries
     * expand differently per runtime and would silently point at the wrong place
     * or escape the intended boundary. Validated in loadConfig. Default: none.
     * Use to grant the bot write access to a shared dir outside its cwd (e.g. a
     * cross-agent work bus).
     */
    additionalDirectories?: string[];
  };
  rateLimit: {
    maxPerMinute: number;
  };
  context: {
    maxContextChars: number;
    historyLimit: number;
  };
  /**
   * Maximum response length in chars (Q32). An over-limit reply is cut so that
   * the delivered text, including the `[response truncated]` notice, never
   * exceeds this value; limits of 1–44 truncate without the notice. Must be a
   * positive integer (non-integer and non-positive values are rejected).
   * Applied at bot start: an edit takes effect after a process restart (or
   * after re-adding the bot under a new id).
   */
  maxResponseChars: number;
  /**
   * Per-message dispatch timeout in ms (#141). Bounds the full handler
   * pipeline (agent query + stream) under the per-session lock. If a turn
   * exceeds this, cancellation revokes its output/store authority immediately.
   * Queued new requests can start after handler settlement and managed teardown
   * proof; missing proof retains maintenance protection. Read from the global
   * configuration (not a per-bot override). Default 5 minutes; <=0 disables it.
   */
  dispatchTimeoutMs: number;
  botBlocklist?: string[];
  /**
   * G14: Bots in this list are allowed to DM the bot even if their uid matches
   * the `_bot` heuristic. Use this to whitelist trusted bots.
   */
  allowedBotUids?: string[];
  /** Explicit exact-channel no-@ overrides; server group preferences are also consulted. */
  mentionFreeGroups?: string[];
  /**
   * v0.3 multi-bot: optional per-bot overrides. When present and non-empty, the
   * process runs ONE independent bot per entry, each with its own gateway,
   * router, store, and (by default) data directory — so bots never share history
   * or working dirs. Each entry inherits every top-level field and overrides the
   * listed ones; `botToken` is required per entry. When absent, the process runs
   * a single bot from the top-level fields exactly as before.
   *
   * Resolved into concrete per-bot Config objects by `resolveBotConfigs()`.
   */
  bots?: BotOverride[];
  /**
   * v0.3 multi-bot: stable identifier for THIS bot, used to namespace its data
   * directory and logs when running multiple bots. Defaults to `default` for the
   * single-bot case. Populated by `resolveBotConfigs()`.
   */
  botId?: string;
  /**
   * #86: media CDN host (no scheme), prefetched at startup from the upload-
   * credentials STS response (`cdnBaseUrl`). Octo serves media from a separate
   * CDN host than `apiUrl`; inbound media URLs on this host are allowed by
   * buildMediaUrl. Runtime-populated (not from the config file); undefined until
   * the prefetch succeeds, in which case only same-apiUrl-host media is allowed.
   */
  mediaCdnHost?: string;
}

/**
 * One bot's entry. In the two-layer model the global config's `bots` array
 * lists which bots to run (by `id`); each bot's real settings — including its
 * required `botToken` — live in `<baseDir>/<id>/config.json`, which is merged
 * OVER both the global shared fields and any inline fields here (per-dir wins).
 *
 * Per-bot directories are NOT configurable here: they are always derived as
 * `<baseDir>/<id>/{data,workspace,memory}` so a bot cannot escape its subtree.
 */
export interface BotOverride {
  /** Only explicitly supplied fields override global card preferences. */
  cards?: Partial<CardConfig>;
  /**
   * Stable id — also the bot's subtree name under `baseDir`. Required in the
   * two-layer model (it selects `<baseDir>/<id>/config.json`). Must be a
   * conservative slug: letters, digits, dot, underscore, hyphen — no path
   * separators (it becomes a path segment).
   */
  id?: string;
  /**
   * Optional here — normally provided by the per-bot `<id>/config.json`. If set
   * inline it is used unless the per-bot file overrides it.
   */
  botToken?: string;
  apiUrl?: string;
  model?: string;
  systemPrompt?: string;
  privateMemory?: Config['privateMemory'];
  botBlocklist?: string[];
  allowedBotUids?: string[];
  mentionFreeGroups?: string[];
}

type PartialConfig = {
  privateMemory?: Config['privateMemory'];
  cards?: Partial<CardConfig>;
  botToken?: string;
  apiUrl?: string;
  groupConfigDir?: string;
  sdk?: Partial<Config['sdk']>;
  rateLimit?: Partial<Config['rateLimit']>;
  context?: Partial<Config['context']>;
  maxResponseChars?: number;
  dispatchTimeoutMs?: number;
  botBlocklist?: string[];
  allowedBotUids?: string[];
  mentionFreeGroups?: string[];
  bots?: BotOverride[];
};

function defaults(): Config {
  return {
    cards: resolveCards(),
    botToken: '',
    apiUrl: '',
    // baseDir is set by loadConfig() from the config path's directory; the
    // per-bot dirs below are DERIVED in resolveBotConfigs() as
    // <baseDir>/<botId>/{workspace,data,memory}. Left empty here.
    baseDir: '',
    cwdBase: '',
    cwd: '',
    dataDir: '',
    memoryBase: '',
    sdk: {
      // IM input is untrusted → default to the safe sandbox. Operators opt into
      // write access deliberately (allowWorkspaceWrite + sandboxMode).
      sandboxMode: 'read-only',
      allowWorkspaceWrite: false,
      approvalPolicy: 'never',
      modelReasoningEffort: 'medium',
      networkAccessEnabled: false,
      webSearchEnabled: false,
      webSearchMode: 'disabled',
    },
    rateLimit: {
      maxPerMinute: 5,
    },
    context: {
      maxContextChars: 6000,
      historyLimit: 40,
    },
    maxResponseChars: 524_288, // 512 KB (Q32)
    dispatchTimeoutMs: 300_000, // 5 min (#141)
  };
}

function readConfigFile(configFilePath: string): PartialConfig {
  if (!existsSync(configFilePath)) {
    return {};
  }

  // Q12: Warn if config file is readable by group/others (contains botToken).
  try {
    const stat = statSync(configFilePath);
    const mode = stat.mode & 0o777;
    if (mode & 0o077) {
      console.warn(
        `[codex-channel-octo] WARNING: ${configFilePath} has mode ${mode.toString(8)} — ` +
        `secrets may be exposed to other users. Fix with: chmod 600 ${configFilePath}`,
      );
    }
  } catch {
    // Best-effort check — don't block startup if stat fails.
  }

  const raw = readFileSync(configFilePath, 'utf-8');
  let parsed: Record<string, unknown> & PartialConfig;
  try {
    parsed = JSON.parse(raw) as Record<string, unknown> & PartialConfig;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to parse config file ${configFilePath}: ${msg}`);
  }
  // Strip top-level keys starting with "_" (e.g. _comment).
  const cleaned: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(parsed)) {
    if (!k.startsWith('_')) cleaned[k] = v;
  }
  // Validate each source layer BEFORE merging: a valid higher-priority value
  // must never hide an invalid global/inline/per-file card setting.
  checkCardSource(cleaned);
  if (Array.isArray(cleaned.bots)) {
    for (const bot of cleaned.bots) {
      if (bot !== null && typeof bot === 'object') checkCardSource(bot);
    }
  }
  return preserveConfigSuppression(cleaned, parsed) as PartialConfig;
}

function assertPrivateMemory(value: Config['privateMemory']): void {
  if (value === undefined) return;
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || (value.enabled !== undefined && typeof value.enabled !== 'boolean')
    || (value.maxBytes !== undefined && (!Number.isInteger(value.maxBytes) || value.maxBytes < 1 || value.maxBytes > 65_536))) {
    throw new Error('Invalid privateMemory: enabled must be boolean and maxBytes an integer from 1 to 65536');
  }
}

const DEPRECATED_CARD_KEYS = [
  'cardProgress', 'reasoningCardTemplateMode', 'cardDisplay', 'cardInteraction',
  'OCTO_CARD_MESSAGE_ENABLED', 'OCTO_CARD_MERGE_FINAL',
] as const;
// Six fixed keys bound both memory and warnings for the entire process lifetime,
// including repeated config reads by the existing watcher. Never retain values.
const warnedCardKeys = new Set<string>();

function warnIgnoredCardKeys(source: object): void {
  for (const key of DEPRECATED_CARD_KEYS) {
    if (Object.hasOwn(source, key) && !warnedCardKeys.has(key)) {
      warnedCardKeys.add(key);
      console.warn(`[codex-channel-octo] WARNING: ignored deprecated card setting ${key}`);
    }
  }
}

function checkCardSource(source: object): void {
  if (Object.hasOwn(source, 'cards')) assertCards((source as { cards: unknown }).cards);
  warnIgnoredCardKeys(source);
}

/** Fixed diagnostics deliberately omit source paths, Bot ids, keys and values. */
function assertCards(value: unknown): asserts value is Partial<CardConfig> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Invalid cards configuration: expected object');
  }
  for (const key of Object.keys(value)) {
    if (key !== 'disable' && key !== 'eventTransport' && key !== 'reasoningSummary') {
      throw new Error('Invalid cards configuration: unknown field');
    }
  }
  const cards = value as Record<string, unknown>;
  if (Object.hasOwn(cards, 'disable') && typeof cards.disable !== 'boolean') {
    throw new Error('Invalid cards configuration: disable must be boolean');
  }
  if (Object.hasOwn(cards, 'eventTransport') &&
      cards.eventTransport !== 'off' && cards.eventTransport !== 'short' && cards.eventTransport !== 'long') {
    throw new Error('Invalid cards configuration: eventTransport must be off, short or long');
  }
  if (Object.hasOwn(cards, 'reasoningSummary') &&
      cards.reasoningSummary !== 'off' && cards.reasoningSummary !== 'on' && cards.reasoningSummary !== 'stream') {
    throw new Error('Invalid cards configuration: reasoningSummary must be off, on or stream');
  }
}

/** Resolve explicit fields in precedence order; always copy/freeze a fresh snapshot. */
function resolveCards(...layers: (Partial<CardConfig> | undefined)[]): Readonly<CardConfig> {
  const merged: Partial<CardConfig> = {};
  for (const layer of layers) {
    if (layer === undefined) continue;
    assertCards(layer);
    Object.assign(merged, layer);
  }
  return Object.freeze({
    disable: merged.disable ?? false,
    eventTransport: merged.eventTransport ?? 'off',
    reasoningSummary: merged.reasoningSummary ?? 'off',
  });
}

function mergeConfig(base: Config, override: PartialConfig): Config {
  assertPrivateMemory(override.privateMemory);
  return preserveConfigSuppression({
    cards: resolveCards(base.cards, override.cards),
    botToken: override.botToken ?? base.botToken,
    apiUrl: override.apiUrl ?? base.apiUrl,
    // baseDir + derived dirs are filled by loadConfig()/resolveBotConfigs(),
    // not by config-file merge.
    baseDir: base.baseDir,
    cwdBase: base.cwdBase,
    cwd: base.cwd,
    dataDir: base.dataDir,
    memoryBase: base.memoryBase,
    groupConfigDir: override.groupConfigDir ?? base.groupConfigDir,
    privateMemory: { enabled: false, maxBytes: 16_384, ...base.privateMemory, ...override.privateMemory },
    sdk: {
      ...base.sdk,
      ...(override.sdk ?? {}),
    },
    rateLimit: {
      ...base.rateLimit,
      ...(override.rateLimit ?? {}),
    },
    context: {
      ...base.context,
      ...(override.context ?? {}),
    },
    maxResponseChars: override.maxResponseChars ?? base.maxResponseChars,
    dispatchTimeoutMs: override.dispatchTimeoutMs ?? base.dispatchTimeoutMs,
    botBlocklist: override.botBlocklist ?? base.botBlocklist,
    allowedBotUids: override.allowedBotUids ?? base.allowedBotUids,
    mentionFreeGroups: override.mentionFreeGroups ?? base.mentionFreeGroups,
    bots: override.bots ?? base.bots,
  }, base, override);
}

/**
 * SSRF protection for apiUrl: implemented in url-policy.ts (isAllowedApiUrl).
 * S6 fix: now rejects https://127.0.0.1 too — https doesn't make a private
 * address safe (could be a self-signed mitmproxy).
 */

export function loadConfig(configPath?: string): Config {
  // Ignored environment flags warn once but never participate in resolution.
  warnIgnoredCardKeys(process.env);
  const path = configPath ?? runtimeConfigPath();
  // Migration aid: if the fixed global config is missing but a legacy
  // ./config.json exists in the cwd, point the operator at the move rather than
  // failing later with a cryptic "Missing required config: apiUrl".
  if (configPath === undefined && !existsSync(path) && existsSync('./config.json')) {
    throw new Error(
      `No config at ${path}, but ./config.json exists. The config location moved: ` +
      `codex-channel-octo now loads ~/.codex-channel-octo/config.json (shared, no token) plus ` +
      `~/.codex-channel-octo/<botId>/config.json (per-bot token). Move your settings there ` +
      `(see config.example.json / config.bot.example.json).`,
    );
  }
  const fileCfg = readConfigFile(path);
  // Config comes ONLY from config.json (global + per-bot layers) — there is no
  // environment-variable override path. The Codex upstream routing
  // (sdk.codexBaseUrl / sdk.codexApiKey) is set in config.json and forwarded to
  // the Codex subprocess by agent-bridge.
  const final = mergeConfig(defaults(), fileCfg);

  // baseDir = the directory containing the global config.json. Every bot's
  // subtree lives at <baseDir>/<botId>/…. resolveBotConfigs() derives the
  // per-bot dirs from this.
  final.baseDir = dirname(resolvePath(path));

  // apiUrl is shared and required at the global layer (a per-bot config.json may
  // still override it, re-checked per bot in resolveBotConfigs). botToken is NOT
  // validated here — it lives in each bot's <id>/config.json.
  if (!final.apiUrl) {
    throw new Error('Missing required config: apiUrl (set CODEX_OCTO_API_URL or config.json)');
  }
  if (!isAllowedApiUrl(final.apiUrl)) {
    throw new Error(
      `Unsafe apiUrl: ${final.apiUrl} — must be https:// or http://localhost/http://127.0.0.1 (SSRF protection)`,
    );
  }
  // The Codex upstream endpoint receives the API key and all prompt / response
  // content, so it gets the same SSRF policy as apiUrl.
  if (final.sdk.codexBaseUrl && !isAllowedApiUrl(final.sdk.codexBaseUrl)) {
    throw new Error(
      `Unsafe sdk.codexBaseUrl: ${final.sdk.codexBaseUrl} — must be https:// ` +
      `or http://localhost/http://127.0.0.1 (SSRF protection)`,
    );
  }
  // additionalDirectories extend the writable sandbox — validate the global
  // layer here. Per-bot overrides are re-validated in resolveBotConfigs().
  assertAdditionalDirectories('config', final.sdk.additionalDirectories, [
    { label: 'the config/SOUL/data tree (baseDir)', path: final.baseDir },
    { label: 'groupConfigDir (trusted group instructions)', path: final.groupConfigDir },
  ]);

  return final;
}

/**
 * Enforce that `groupConfigDir` (whose files are injected UNSANITIZED into the
 * system prompt) is not the same as, nor nested under, the agent-writable
 * `cwdBase`. Otherwise a user-driven agent could write its own future
 * system-prompt instructions.
 *
 * Uses realpathSync.native for paths that exist (so symlinks can't dodge the
 * boundary) and falls back to lexical resolve() for not-yet-created dirs.
 */
function assertGroupConfigDirOutsideCwd(cfg: Config): void {
  if (!cfg.groupConfigDir) return;
  const cwdBase = cfg.cwdBase ?? cfg.cwd;
  const cwdBaseResolved = canonicalize(cwdBase);
  const groupDirResolved = canonicalize(cfg.groupConfigDir);
  if (groupDirResolved === cwdBaseResolved || isPathInside(groupDirResolved, cwdBaseResolved)) {
    throw new Error(
      `Unsafe groupConfigDir: ${cfg.groupConfigDir} is the same as or nested under ` +
      `cwdBase (${cwdBase}). It must be operator-controlled and outside the ` +
      `agent-writable sandbox, since its files are injected into the system prompt.`,
    );
  }
}

/** Resolve to a real path when it exists (defeats symlink dodges), else lexical. */

function canonicalize(p: string): string {
  try {
    return realpathSync.native(p);
  } catch {
    return resolvePath(p);
  }
}

/** True when `child` is strictly inside `parent` (both already resolved). */
function isPathInside(child: string, parent: string): boolean {
  const parentWithSep = parent.endsWith(sep) ? parent : parent + sep;
  return child.startsWith(parentWithSep);
}

/**
 * v0.3 multi-bot: expand a loaded Config into one concrete Config per bot.
 *
 * - Single-bot (no `bots`): returns `[config]` with `botId` defaulted to
 *   `default`, unchanged otherwise — fully backward compatible.
 * - Multi-bot: returns one Config per `bots[]` entry. Each inherits the base
 *   config and applies its overrides. To guarantee bots never share history,
 *   cwd, or lock files, each bot's `dataDir` and `cwdBase` are namespaced by its
 *   id UNLESS the entry sets them explicitly.
 *
 * Throws on missing/duplicate bot tokens or duplicate ids (fail fast at boot).
 */
/**
 * Expand a loaded GLOBAL config into one concrete Config per bot.
 *
 * Two-layer, bot-first model:
 * - Single-bot (no `bots`): one bot with id `default`. Its token/overrides come
 *   from the global config and/or `<baseDir>/default/config.json`.
 * - Multi-bot: one Config per `bots[]` entry (selected by `id`). For each, the
 *   effective config is: global shared fields ⊕ inline `bots[]` fields ⊕
 *   `<baseDir>/<id>/config.json` (per-dir file wins).
 *
 * Every bot's directories are DERIVED (never configurable):
 *   data      = <baseDir>/<id>/data
 *   workspace = <baseDir>/<id>/workspace   (cwdBase)
 *   memory    = <baseDir>/<id>/memory
 * and its personality from `<baseDir>/<id>/SOUL.md` (overrides systemPrompt).
 *
 * Throws on missing/duplicate tokens, duplicate ids, invalid id slugs, or unsafe
 * apiUrl (fail fast at boot).
 */
export function resolveBotConfigs(config: Config): Config[] {
  checkCardSource(config);
  // Zero-bot idle: no bots[] list and no global botToken — and no token in the
  // default per-bot file either. Return [] so the gateway can run idle (online,
  // no bots) until the first bot is provisioned, instead of throwing. A legacy
  // single bot may keep its token only in <baseDir>/default/config.json (read by
  // the synthesized "default" entry below), so check that before idling.
  const hasInlineBots = !!(config.bots && config.bots.length > 0);
  if (!hasInlineBots && !config.botToken) {
    const defaultPerBot = readConfigFile(pathJoin(config.baseDir, 'default', 'config.json'));
    if (!defaultPerBot.botToken) {
      return [];
    }
  }
  // Single-bot: synthesize one entry with id "default".
  const entries: BotOverride[] =
    config.bots && config.bots.length > 0
      ? config.bots
      : [{ id: 'default', botToken: config.botToken || undefined }];

  const seenIds = new Set<string>();
  const seenTokens = new Set<string>();
  const resolvedBots = entries.map((bot, i) => {
    checkCardSource(bot);
    const id = bot.id ?? `bot${i}`;
    // The id becomes a path segment for the bot's subtree, so restrict it to a
    // conservative slug — otherwise ids like "../ops" or "a/b" could escape or
    // alias the intended directory, defeating isolation.
    if (!/^[a-zA-Z0-9._-]+$/.test(id) || id === '.' || id === '..') {
      throw new Error(
        `Bot "${id}": invalid id — use only letters, digits, dot, underscore, hyphen (no path separators)`,
      );
    }
    if (seenIds.has(id)) {
      throw new Error(`Duplicate bot id "${id}" — ids must be unique`);
    }
    seenIds.add(id);

    // Derive the bot's self-contained subtree under baseDir.
    const botRoot = pathJoin(config.baseDir, id);
    const botDataDir = pathJoin(botRoot, 'data');
    const botCwdBase = pathJoin(botRoot, 'workspace');
    const botMemoryBase = pathJoin(botRoot, 'memory');
    // Per-bot CODEX_HOME so each bot's codex auth/config/sessions/memory are
    // isolated and IM content never lands in the operator's personal ~/.codex.
    // Operator can opt into sharing by setting sdk.codexHome to ~/.codex.
    const botCodexHome = pathJoin(botRoot, 'codex-home');

    // Per-bot config.json (in the bot's own subtree) is the highest-priority
    // layer: global shared ⊕ inline bots[] entry ⊕ <baseDir>/<id>/config.json.
    const perBotFile = readConfigFile(pathJoin(botRoot, 'config.json'));
    const botToken = perBotFile.botToken ?? bot.botToken ?? '';
    if (!botToken) {
      throw new Error(
        `Bot "${id}": missing botToken — set it in ${pathJoin(botRoot, 'config.json')}`,
      );
    }
    if (seenTokens.has(botToken)) {
      throw new Error(`Duplicate botToken across bots — each bot needs a distinct token`);
    }
    seenTokens.add(botToken);

    // openclaw-style SOUL.md in the bot's subtree overrides systemPrompt (which
    // may come from the per-bot file, the inline entry, or the shared config).
    const botSoul = loadSoul(botRoot);
    const sharedSystemPrompt = config.sdk.systemPrompt;
    const botSystemPrompt =
      botSoul ?? perBotFile.sdk?.systemPrompt ?? bot.systemPrompt ?? sharedSystemPrompt;

    const apiUrl = perBotFile.apiUrl ?? bot.apiUrl ?? config.apiUrl;
    const model = perBotFile.sdk?.model ?? bot.model ?? config.sdk.model;
    assertPrivateMemory(bot.privateMemory);
    assertPrivateMemory(perBotFile.privateMemory);

    const resolved: Config = {
      ...config,
      cards: resolveCards(config.cards, bot.cards, perBotFile.cards),
      bots: undefined, // a per-bot config is single-bot
      botId: id,
      botToken,
      apiUrl,
      baseDir: config.baseDir,
      dataDir: botDataDir,
      cwdBase: botCwdBase,
      cwd: botCwdBase,
      memoryBase: botMemoryBase,
      botBlocklist: perBotFile.botBlocklist ?? bot.botBlocklist ?? config.botBlocklist,
      allowedBotUids: perBotFile.allowedBotUids ?? bot.allowedBotUids ?? config.allowedBotUids,
      mentionFreeGroups:
        perBotFile.mentionFreeGroups ?? bot.mentionFreeGroups ?? config.mentionFreeGroups,
      groupConfigDir: perBotFile.groupConfigDir ?? config.groupConfigDir,
      privateMemory: { enabled: false, maxBytes: 16_384, ...config.privateMemory,
        ...bot.privateMemory, ...perBotFile.privateMemory },
      sdk: {
        ...config.sdk,
        ...(perBotFile.sdk ?? {}),
        ...(model !== undefined ? { model } : {}),
        ...(botSystemPrompt !== undefined ? { systemPrompt: botSystemPrompt } : {}),
        // CODEX_HOME defaults to the bot's own subtree; an explicit per-bot
        // sdk.codexHome (e.g. ~/.codex for opt-in sharing) wins. Expand a leading
        // ~ — env values are NOT shell-expanded, so a literal "~/.codex" would
        // create a bogus dir named "~" instead of sharing the personal home.
        codexHome: expandHome(perBotFile.sdk?.codexHome ?? config.sdk.codexHome) ?? botCodexHome,
      },
    };
    if (!isAllowedApiUrl(resolved.apiUrl)) {
      throw new Error(`Bot "${id}": unsafe apiUrl ${resolved.apiUrl} (SSRF protection)`);
    }
    // per-bot sdk can override codexBaseUrl/sandboxMode — re-validate here so a
    // bad per-bot value fails at boot, not silently (loadConfig only saw the
    // global layer).
    if (resolved.sdk.codexBaseUrl && !isAllowedApiUrl(resolved.sdk.codexBaseUrl)) {
      throw new Error(`Bot "${id}": unsafe sdk.codexBaseUrl ${resolved.sdk.codexBaseUrl} (SSRF protection)`);
    }
    // per-bot sdk can also override additionalDirectories — re-validate so a
    // per-bot relative / '~' entry can't slip past the global-only check, and
    // reject any entry that overlaps this bot's trust anchors: its writable cwd
    // (AGENTS.md), the config/SOUL tree, the group-config dir, its memory dir
    // (re-injected into future turns), and codexHome (auth.json / config.toml —
    // credentials; may be relocated outside baseDir, e.g. a shared ~/.codex).
    assertAdditionalDirectories(id, resolved.sdk.additionalDirectories, [
      { label: "the bot's writable cwd", path: resolved.cwdBase ?? resolved.cwd },
      { label: 'the config/SOUL/data tree (baseDir)', path: resolved.baseDir },
      { label: 'groupConfigDir (trusted group instructions)', path: resolved.groupConfigDir },
      { label: 'the bot memory directory', path: resolved.memoryBase },
      { label: 'codexHome (agent credentials / config.toml)', path: resolved.sdk.codexHome },
    ]);
    // Fail-fast on misspelled enums so a typo surfaces at boot, not on every
    // message (where buildThreadOptions would throw inside the handler and the
    // bot would look online but fail every turn).
    assertSdkEnums(id, resolved.sdk);
    assertMaxResponseChars(id, resolved.maxResponseChars);
    // GROUP.md trust boundary: groupConfigDir must not be the bot's writable cwd.
    assertGroupConfigDirOutsideCwd(resolved);
    return preserveConfigSuppression(resolved, config, bot, perBotFile);
  });

  return resolvedBots;
}

/**
 * Expand a leading `~` or `~/` to the user's home directory. Env var values are
 * not shell-expanded, so a config like `codexHome: "~/.codex"` must be resolved
 * here or it would create a literal directory named "~". Returns undefined for
 * undefined input (caller falls back to the derived default).
 */
export function expandHome(p: string | undefined): string | undefined {
  if (p === undefined) return undefined;
  if (p === '~') return homedir();
  if (p.startsWith('~/')) return pathJoin(homedir(), p.slice(2));
  return p;
}

/**
 * Validate `sdk.additionalDirectories`: every entry must be an explicit
 * absolute path. Relative / '~' entries expand per-runtime and could resolve
 * outside the intended sandbox boundary, so reject them rather than guess.
 * Called on both the global merged config (loadConfig) and each per-bot config
 * (resolveBotConfigs) — a per-bot override must not slip past the global check.
 *
 * `trustAnchors` are directories that establish the agent's trusted inputs: the
 * session cwd (where AGENTS.md — the frozen security prefix + SOUL/GROUP text —
 * is written), the operator config/SOUL/data tree, and the group-instructions
 * dir (injected UNSANITIZED as trusted). The sandboxed agent is driven by
 * untrusted IM input, so a writable root that overlaps any anchor would let the
 * agent overwrite the very files that govern its own trust boundary — a
 * trust-escape. Reject overlap in EITHER direction (entry contains an anchor,
 * or sits inside one). These roots do not constrain danger-full-access.
 */
function assertAdditionalDirectories(
  id: string,
  dirs: string[] | undefined,
  trustAnchors: Array<{ label: string; path: string | undefined }> = [],
): void {
  // additionalDirectories comes from untyped JSON. A bare string would iterate
  // char-by-char (misleading "unsafe entry 'f'") and a non-iterable would throw
  // a raw TypeError below — fail closed with an actionable message instead.
  if (dirs !== undefined && !Array.isArray(dirs)) {
    throw new Error(
      `Bot "${id}": sdk.additionalDirectories must be an array of absolute paths (got ${typeof dirs}).`,
    );
  }
  for (const dir of dirs ?? []) {
    if (typeof dir !== 'string' || !isAbsolute(dir) || dir.startsWith('~')) {
      throw new Error(
        `Bot "${id}": unsafe sdk.additionalDirectories entry ${JSON.stringify(dir)} — must be an absolute path (no '~' or relative).`,
      );
    }
    // A '..' segment resolves per-runtime to a directory the literal path does
    // not name (e.g. "/srv/bus/../../etc"), sidestepping the overlap checks
    // below. Reject rather than silently normalize, so the granted root is
    // exactly what the operator wrote.
    if (dir.split(sep).includes('..')) {
      throw new Error(
        `Bot "${id}": unsafe sdk.additionalDirectories entry ${JSON.stringify(dir)} — must not contain '..' path segments.`,
      );
    }
    const entry = canonicalize(dir);
    for (const anchor of trustAnchors) {
      if (!anchor.path) continue;
      const a = canonicalize(anchor.path);
      if (entry === a || isPathInside(entry, a) || isPathInside(a, entry)) {
        throw new Error(
          `Bot "${id}": unsafe sdk.additionalDirectories entry ${JSON.stringify(dir)} — ` +
          `overlaps ${anchor.label} (${anchor.path}). An agent-writable root must not contain, ` +
          `equal, or sit inside a trusted instruction/config location, or untrusted IM input could ` +
          `drive the agent to overwrite its own trust anchors.`,
        );
      }
    }
  }
}

/**
 * Validate the codex sdk enum fields at boot so a misspelled value fails fast
 * (instead of throwing inside the per-message handler). Mirrors the allowed
 * sets in agent-bridge; kept here (no import) to avoid a config↔bridge cycle.
 */
function assertSdkEnums(id: string, sdk: Config['sdk']): void {
  const check = (field: string, value: string | undefined, allowed: string[]): void => {
    if (value !== undefined && !allowed.includes(value)) {
      throw new Error(`Bot "${id}": invalid sdk.${field} '${value}' (allowed: ${allowed.join(', ')})`);
    }
  };
  check('sandboxMode', sdk.sandboxMode, ['read-only', 'workspace-write', 'danger-full-access']);
  check('approvalPolicy', sdk.approvalPolicy, ['never', 'on-request', 'on-failure', 'untrusted']);
  check('modelReasoningEffort', sdk.modelReasoningEffort, ['minimal', 'low', 'medium', 'high', 'xhigh']);
  check('webSearchMode', sdk.webSearchMode, ['disabled', 'cached', 'live']);
  check('outputSelection', sdk.outputSelection, ['final', 'phase', 'heuristic', 'legacy']);
  check('runtime', sdk.runtime, ['exec', 'app-server']);
  validateRecovery(sdk.recovery);
  if (sdk.privateDiagnosticsDetails !== undefined && typeof sdk.privateDiagnosticsDetails !== 'boolean') {
    throw new Error(`Bot "${id}": sdk.privateDiagnosticsDetails must be a boolean`);
  }
  if (sdk.privateDiagnostics !== undefined && typeof sdk.privateDiagnostics !== 'boolean') {
    throw new Error(`Bot "${id}": sdk.privateDiagnostics must be a boolean`);
  }
}

/**
 * Validate maxResponseChars at boot. Only values that never worked are
 * rejected (non-integer, zero, negative); every positive integer is accepted.
 * Small limits (1–44) run without the truncation notice — see
 * output-selection.ts capSelected.
 */
function assertMaxResponseChars(id: string, value: unknown): void {
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    throw new Error(`Bot "${id}": maxResponseChars must be a positive integer (got ${String(value)})`);
  }
}

/**
 * v1.1: openclaw-style per-bot personality. Read `<botRoot>/SOUL.md` if it
 * exists and return its trimmed contents as the bot's "soul" (voice/stance/
 * boundaries), to be composed into the agent system prompt. Mirrors openclaw's
 * SOUL.md: a file you edit, not a config string. When the file is absent or
 * empty, returns undefined so the caller falls back to the `systemPrompt`
 * config string. Best-effort — a read error never blocks startup.
 */
export function loadSoul(botRoot: string): string | undefined {
  const path = pathJoin(botRoot, 'SOUL.md');
  if (!existsSync(path)) return undefined;
  try {
    const content = readFileSync(path, 'utf-8').trim();
    return content.length > 0 ? content : undefined;
  } catch (err) {
    console.warn(
      `[codex-channel-octo] WARNING: failed to read ${path}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return undefined;
  }
}
