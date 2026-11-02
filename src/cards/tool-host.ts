/**
 * Trusted per-turn explicit-card tool host (TD v3 §2.4 as amended by AM-08 v4, WP-08).
 *
 * One host per Bot, built only over a store whose explicit ledger was
 * recovered (`ledgerRecovered`), registered as the `tool_host` resource owner.
 *
 * - Generation: `openGeneration` registers the turn's handler generation in
 *   the durable ledger and returns the authority-free `CardInjectionLaunch`.
 *   The injected server id is minted once per generation and never rotates.
 * - Attempt: every `prepareAttempt` closes the previous attempt registration
 *   and opens a fresh `127.0.0.1` ephemeral listener, a ≥256-bit authority kept
 *   in parent memory and a single-use 256-bit bootstrap ticket in an
 *   owner-only file. The merged MCP entry carries only absolute paths, the
 *   ticket path and the port: no authority, no `env`, no `env_vars`.
 * - Redemption (§5): first valid redemption consumes the ticket; a replay while
 *   the registration is live revokes it; expiry without redemption closes it
 *   at TTL; any other frame is unauthenticated zero state.
 * - Dispatch (§7.3): D0 frame parse → D1 authenticate on the receiving
 *   registration → fence and liveness → D2 charge with RFC 8785 dedup → D3
 *   handler lookup → D4 argument validation → D5 handler through the
 *   `ExplicitSendPort` → D6 correlated reply. The 32/10 budget is the store's
 *   and is never refunded.
 *
 * The production op table is frozen empty at WP-08 (gate G-b), so no turn is
 * ever offered an injection and the ordinary path is byte-identical. Nothing
 * here logs, and no authority or ticket value leaves this module except in
 * the bootstrap reply on the registration's own listener.
 */

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readSync,
  realpathSync,
  rmSync,
  statSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, parse as parsePath, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import type {
  CardResourceOwner,
  CardToolResult,
  Diag,
  JsonValue,
  MonotonicClock,
  ResourceDrainReport,
  ShutdownFence,
  ToolOpcode,
  TrustedTurnContext,
  WallClock,
} from "./contracts.js";
import type { CardPolicy } from "./policy.js";
import {
  canonicalJson,
  canonicalRequestBody,
  encodeBootstrapReply,
  encodeReplyFrame,
  isBootstrapShaped,
  parseBootstrapFrame,
  parseCardToolResult,
  parseRequestFrame,
  parseStrictJson,
  readFrame,
  type ToolRequestFrame,
} from "./protocol.js";
import { EXPLICIT_DISPLAY } from "./explicit-display.js";
import { EXPLICIT_INTERACTIVE, interactionDegradation } from "./explicit-interactive.js";
import { ledgerRecovered } from "./recovery.js";
import { EXPLICIT_BUDGET_EXHAUSTED, MAX_EXPLICIT_INVOCATIONS, type CardBinding, type CardStore, type ExplicitCard, type ExplicitFinish, type FinishExplicitInput } from "./store.js";

// ─── public contract (AM-08 v4 §7.1) ────────────────────────────────────────

/** Timer port (structurally the pacer's), so the host never imports the card writer. */
export interface HostTimers {
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
}

/** Bridge-visible launch: no authority, no endpoint. */
export interface CardInjectionLaunch {
  readonly serverId: string;
  readonly generation: string;
  prepareAttempt(): Promise<AttemptHandle | undefined>;
  /**
   * App-server runtime: the per-attempt host dispatcher for `item/tool/call`
   * on the gateway's own pipe (no listener, ticket or MCP entry). Runs the
   * per-attempt G-d admit; undefined ⇒ no explicit tools for the attempt.
   */
  prepareAppServerAttempt(port: AppServerReplyPort): AppServerAttemptCards | undefined;
}

// ─── app-server dispatch (XIN-2384 rev2 §5–§6 + addendum A1–A5) ──────────────

/** Reply timer: fires `T_pre + T_send` after the call frame was read (R-2). */
export const CALL_SETTLE_MS = 16_000;
/** Call-start admission: remaining turn time ≥ `T_call + R` = 18 s + 60 s. */
export const CALL_ADMISSION_MS = 78_000;
/** Early calls held per binding before the turn id is trusted (TB-5). */
export const HOLD_MAX = 32;
/** Identical-replay joins answered per ledger row (§5.3). */
export const JOIN_MAX = 4;
/** Explicit card toolset version declared on new threads (T2a). */
export const APP_SERVER_TOOLSET_VERSION = 1;

/** One `thread/start.dynamicTools` entry. */
export interface DynamicToolSpec {
  readonly type: "function";
  readonly name: ToolOpcode;
  readonly description: string;
  readonly inputSchema: { readonly type: "object" };
}

/**
 * Versioned discovery and digest for an admitted offer (T2a/T0). The default
 * is the current production thread toolset; interaction remains topology-gated.
 * Each attempt supplies its frozen generation offer, including synthetic controls.
 */
export function appServerToolset(ops: readonly ToolOpcode[] = ["display"]): { readonly tools: readonly DynamicToolSpec[]; readonly digest: string } {
  const tools: DynamicToolSpec[] = (["display", "interactive"] as const).filter((op) => ops.includes(op)).map((name) => ({
    type: "function", name, inputSchema: { type: "object" },
    description: name === "display" ? "Send a display card to the current conversation." : "Send an interactive card to the current requester.",
  }));
  const digest = `v${APP_SERVER_TOOLSET_VERSION}:${createHash("sha256").update(canonicalJson(tools as unknown as JsonValue), "utf8").digest("hex")}`;
  return Object.freeze({ tools: Object.freeze(tools.map((t) => Object.freeze(t))), digest });
}

/** The client's reply capability; `uncharged` replies count toward its R-9a cap. */
export interface AppServerReplyPort {
  respond(id: number | string, result: unknown, opts?: { uncharged?: boolean }): boolean;
}

/** Per-attempt dispatcher (`AttemptBinding`), driven by the runner. */
export interface AppServerAttemptCards {
  /** Declared on `thread/start` of a new thread only (T1: never on resume). */
  readonly dynamicTools: readonly DynamicToolSpec[];
  readonly toolsetDigest: string;
  /** The thread of this child and the toolset it was created with (T0/T5); null = none. */
  setThread(threadId: string, toolsetDigest: string | null): void;
  /** Our only `turn/start` was enqueued (TB-0). */
  turnStartEnqueued(): void;
  /** The trusted turn id (TB-1/TB-2); releases held calls in order. */
  bindTurn(turnId: string): void;
  /** `turn/completed`: later calls are refused uncharged. */
  turnCompleted(): void;
  /** Synchronous; every reply goes through the port. */
  onToolCall(id: number | string, params: unknown): void;
  /** Binding close (mismatch, child exit, attempt end): held Δ0, in-flight per R-4. */
  close(): void;
}

export interface AttemptHandle {
  /** The only entry merged into `mcp_servers.<serverId>`; authority-free. */
  readonly mcpEntry: Readonly<Record<string, unknown>>;
  close(): void;
  /**
   * Trusted `mcp_tool_call.server` match (§4.6): the stable server id of this
   * generation AND a live invocation record (registration and generation live).
   */
  isTrustedServer(server: unknown): boolean;
}

export interface ExplicitOpContext {
  readonly ctx: TrustedTurnContext;
  readonly requestId: string;
}

/** The only transport capability a handler gets; the host owns reserve → transport → finish. */
export interface ExplicitSendPort {
  reserveAndSend(card: ExplicitCard): Promise<CardToolResult>;
}

export interface ExplicitOpHandler<O extends ToolOpcode = ToolOpcode> {
  readonly op: O;
  /** Arguments only — never the authority field. */
  handle(args: Extract<ToolRequestFrame, { op: O }>["args"], c: ExplicitOpContext, send: ExplicitSendPort, signal: AbortSignal): Promise<CardToolResult>;
}

export type ExplicitOpTable = ReadonlyMap<ToolOpcode, ExplicitOpHandler>;

/** Closed operation registry; registration does not enable runtime discovery. */
export const PRODUCTION_EXPLICIT_OPS: ExplicitOpTable = Object.freeze(new Map<ToolOpcode, ExplicitOpHandler>([
  ["display", EXPLICIT_DISPLAY as ExplicitOpHandler], ["interactive", EXPLICIT_INTERACTIVE as ExplicitOpHandler],
]));

export const EXPLICIT_OP_UNAVAILABLE = Object.freeze({
  status: "error",
  error: Object.freeze({ code: "unavailable", diagnostics: Object.freeze([Object.freeze({ path: "$.op", rule: "explicit_op_unavailable" })]) }),
} as const);

/** Transport outcome of one reserved explicit send; supplied by the send package (WP-09+). */
export type ExplicitTransportOutcome =
  | { readonly kind: "acked"; readonly messageId: string }
  | { readonly kind: "failed" }
  | { readonly kind: "ambiguous" };

export interface ExplicitTransport {
  send(input: {
    readonly ctx: TrustedTurnContext; readonly card: ExplicitCard; readonly cardId: string;
    readonly clientMsgNo: string; readonly signal: AbortSignal;
  }): Promise<ExplicitTransportOutcome>;
}

// ─── fixed results ──────────────────────────────────────────────────────────

function errorResult(code: Extract<CardToolResult, { status: "error" }>["error"]["code"], diagnostics?: readonly Diag[]): CardToolResult {
  return Object.freeze({ status: "error", error: Object.freeze(diagnostics ? { code, diagnostics: Object.freeze(diagnostics.map((d) => Object.freeze({ ...d }))) } : { code }) });
}

const AUTHORITY_CLOSED = errorResult("unavailable", [{ path: "$", rule: "explicit_authority_closed" }]);
const REQUEST_ID_REUSED = errorResult("validation_failed", [{ path: "$.request_id", rule: "request_id_reused" }]);
const SEND_UNCONFIRMED = errorResult("send_unconfirmed");
const SEND_FAILED = errorResult("unavailable", [{ path: "$", rule: "explicit_send_failed" }]);
const POLICY_DENIED = errorResult("policy_denied");
const CAPACITY_FULL = errorResult("capacity_full");

// ─── limits ─────────────────────────────────────────────────────────────────

/** Bootstrap ticket lifetime (§4.2). */
export const BOOTSTRAP_TTL_MS = 5_000;
const MAX_CONNECTIONS_PER_REGISTRATION = 8;
const MAX_PENDING_FRAMES_PER_SOCKET = 256;
const SERVER_ID_PREFIX = "octo_cards_";
const SERVER_ID = /^octo_cards_[0-9a-f]{32}$/;
const MCP_STARTUP_TIMEOUT_SEC = 10;

// ─── gateway-wide discovery gate G-d (§6; WP09-PF v3 §4.4 as amended by v3.1) ─

/** One running Bot's model-command exposure, as resolved from its startup config. */
export interface GatewayExposureEntry {
  /** Resolved sandbox mode (`resolveSandbox(config.sdk)`); anything but `read-only` disables injection gateway-wide. */
  readonly sandboxMode: string | undefined;
  /** Effective CODEX_HOME of the Bot's Codex runs; undefined fails closed. */
  readonly codexHome: string | undefined;
  /** `sdk.codexApiKey` is configured (presence only, never the value); anything but `true` fails closed. */
  readonly apiKeyConfigured: boolean;
  /** `sdk.env` has a {@link CODEX_AUTH_ENV_MARKERS} key (presence only); anything but `false` fails closed. */
  readonly sdkEnvAuthMarkers: boolean;
}

const exposures = new Map<symbol, GatewayExposureEntry>();
const liveHosts = new Set<{ revokeAll(): void }>();

/** System configuration layers; any presence disables injection. Managed preferences are walked separately. */
const SYSTEM_LAYERS: readonly string[] = Object.freeze(["/etc/codex"]);

/** macOS managed-preferences root, walked without following links (§4.4-1). */
const MANAGED_PREFERENCES_ROOT = "/Library/Managed Preferences";
const MANAGED_PREFERENCES_MAX_DEPTH = 3;
const MANAGED_PREFERENCES_MAX_ENTRIES = 4096;
const CODEX_MANAGED_PLIST = "com.openai.codex.plist";

/**
 * CODEX_HOME entries that add hooks, managed layers, plugins, stored auth or a
 * cloud-requirements bundle; any presence disables injection.
 */
const CODEX_HOME_DENIED: readonly string[] = Object.freeze([
  "managed_config.toml", "requirements.toml", "hooks.json", "hooks", "plugins",
  "auth.json", "cloud-config-bundle-cache.json",
]);

/** Environment keys that select PAT or workload-identity auth over the API key; checked by key presence only. */
export const CODEX_AUTH_ENV_MARKERS: readonly string[] = Object.freeze([
  "CODEX_ACCESS_TOKEN", "OPENAI_FEDERATION_RULE_ID", "OPENAI_IDENTITY_TOKEN_FILE", "OPENAI_WORKLOAD_IDENTITY_CONTEXT",
]);

/** True when `env` has any {@link CODEX_AUTH_ENV_MARKERS} key (or is not an object). Never reads a value. */
export function hasCodexAuthEnvMarker(env: Readonly<Record<string, unknown>> | undefined): boolean {
  if (env === undefined) return false;
  if (env === null || typeof env !== "object") return true;
  return CODEX_AUTH_ENV_MARKERS.some((key) => Object.hasOwn(env, key));
}

/**
 * Features Codex 0.163.0 enables by default that add plugin, connector
 * (`codex_apps`), hook or skill-installed MCP paths, or the unsandboxed
 * code-mode process host. Each must be explicitly `false` in `[features]`;
 * absence leaves the default on.
 */
export const REQUIRED_DISABLED_CODEX_FEATURES: readonly string[] = Object.freeze([
  "apps", "plugins", "remote_plugin", "hooks", "skill_mcp_dependency_install", "code_mode_host",
]);

/** Closed allowlist of top-level `config.toml` keys that add no model-command path. */
const ADMITTED_TOP_KEYS: ReadonlySet<string> = new Set([
  "model", "model_provider", "model_reasoning_effort", "model_reasoning_summary", "model_verbosity",
  "model_context_window", "model_max_output_tokens", "preferred_auth_method", "forced_login_method",
  "cli_auth_credentials_store", "hide_agent_reasoning", "show_raw_agent_reasoning",
  "disable_response_storage", "project_doc_max_bytes", "file_opener",
]);
/** Top-level keys with a fixed value: API-key login is forced and credentials stay in the file store. */
const FIXED_TOP_VALUES: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ["forced_login_method", new Set(['"api"', "'api'"])],
  ["cli_auth_credentials_store", new Set(['"file"', "'file'"])],
]);
/** `[model_providers.<id>]` scalar keys. */
const ADMITTED_PROVIDER_KEYS: ReadonlySet<string> = new Set([
  "name", "base_url", "env_key", "wire_api", "requires_openai_auth",
  "request_max_retries", "stream_max_retries", "stream_idle_timeout_ms",
]);

const BARE_KEY = /^[A-Za-z0-9_-]+$/;
const SCALAR = /^(?:"(?:[^"\\\u0000-\u001f]|\\["\\/bfnrt]|\\u[0-9A-Fa-f]{4})*"|'[^'\u0000-\u001f]*'|[+-]?(?:0|[1-9][0-9]*)|true|false)$/;

/**
 * Closed-allowlist parse of one `config.toml`: only bare top-level keys from
 * the allowlist, with `forced_login_method = "api"` required and
 * `cli_auth_credentials_store`, if present, `"file"`; `[model_providers.<bare
 * id>]` tables of scalar keys, with basic/literal strings, integers or
 * booleans; and one `[features]` table that sets every
 * {@link REQUIRED_DISABLED_CODEX_FEATURES} entry to `false` and nothing else.
 * Anything else — a missing or enabled required feature, another
 * `mcp_servers` entry, `notify`, hooks, profiles, plugins, connectors, arrays,
 * inline tables, dotted keys, `[features.<name>]` tables, multi-line strings,
 * a repeated table or key — is not admitted.
 */
export function admitsCodexConfigToml(text: string): boolean {
  let table: "top" | "provider" | "features" = "top";
  const tables = new Set<string>();
  let keys = new Set<string>();
  const disabled = new Set<string>();
  let apiLoginForced = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/^[ \t]+|[ \t]+$/g, "");
    if (line === "" || line.startsWith("#")) continue;
    const header = /^\[([A-Za-z0-9_.-]+)\]$/.exec(line);
    if (header !== null) {
      const name = header[1] as string;
      const parts = name.split(".");
      if (name === "features") table = "features";
      else if (parts.length === 2 && parts[0] === "model_providers" && BARE_KEY.test(parts[1] as string)) table = "provider";
      else return false;
      if (tables.has(name)) return false;
      tables.add(name);
      keys = new Set();
      continue;
    }
    const kv = /^([A-Za-z0-9_-]+)[ \t]*=[ \t]*(.+?)(?:[ \t]+#.*)?$/.exec(line);
    if (kv === null) return false;
    const key = kv[1] as string;
    const value = kv[2] as string;
    if (keys.has(key)) return false;
    keys.add(key);
    if (table === "features") {
      if (!REQUIRED_DISABLED_CODEX_FEATURES.includes(key) || value !== "false") return false;
      disabled.add(key);
      continue;
    }
    if (!SCALAR.test(value)) return false;
    if (table === "top" ? !ADMITTED_TOP_KEYS.has(key) : !ADMITTED_PROVIDER_KEYS.has(key)) return false;
    if (table === "top") {
      const fixed = FIXED_TOP_VALUES.get(key);
      if (fixed !== undefined && !fixed.has(value)) return false;
      if (key === "forced_login_method") apiLoginForced = true;
    }
  }
  return apiLoginForced && REQUIRED_DISABLED_CODEX_FEATURES.every((f) => disabled.has(f));
}

/** `lstat` presence: only `ENOENT` is absent; any entry (a dangling link included) or any other error is present. */
function present(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code !== "ENOENT";
  }
}

const MAX_CONFIG_BYTES = 65_536;

interface ConfigStat {
  readonly dev: bigint;
  readonly ino: bigint;
  readonly size: bigint;
  readonly mtimeNs: bigint;
}

/**
 * fd-bound read of one `config.toml` (v3.1 N-a): `O_NOFOLLOW` open, made
 * `O_NONBLOCK` so a FIFO cannot stall the gateway before the `fstat`, `fstat`
 * of a regular file of at most 64 KiB, the bytes from that same fd, then a
 * final `lstat` of the path with the same `dev`/`ino`. The digest and the
 * parse use the one buffer read. Null on any error or deviation.
 */
function readBoundConfig(path: string): { readonly sha256: string; readonly stat: ConfigStat; readonly text: string } | null {
  let fd: number | undefined;
  try {
    fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    const st = fstatSync(fd, { bigint: true });
    if (!st.isFile() || st.size > BigInt(MAX_CONFIG_BYTES)) return null;
    const buf = Buffer.alloc(MAX_CONFIG_BYTES + 1);
    let len = 0;
    for (;;) {
      const n = readSync(fd, buf, len, buf.length - len, null);
      if (n === 0) break;
      len += n;
      if (len > MAX_CONFIG_BYTES) return null;
    }
    if (BigInt(len) !== st.size) return null;
    const bytes = buf.subarray(0, len);
    closeSync(fd);
    fd = undefined;
    const after = lstatSync(path, { bigint: true });
    if (after.dev !== st.dev || after.ino !== st.ino) return null;
    return {
      sha256: createHash("sha256").update(bytes).digest("hex"),
      stat: { dev: st.dev, ino: st.ino, size: st.size, mtimeNs: st.mtimeNs },
      text: new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    };
  } catch {
    return null;
  } finally {
    if (fd !== undefined) { try { closeSync(fd); } catch { /* closed */ } }
  }
}

/** Facts of one admitted exposure; every field is part of the redeem-time comparison. */
interface ExposureFacts {
  readonly codexHome: string;
  readonly sandboxMode: string;
  readonly configSha256: string;
  readonly configStat: ConfigStat;
  /** {@link CODEX_HOME_DENIED} presence, in order. */
  readonly denied: readonly boolean[];
  readonly apiKeyConfigured: boolean;
  readonly sdkEnvAuthMarkers: boolean;
}

/** One exposure's G-d terms: resolved `read-only`, API-key auth only, and a CODEX_HOME that admits nothing else. */
function exposureFacts(e: GatewayExposureEntry): ExposureFacts | null {
  if (e.sandboxMode !== "read-only" || e.apiKeyConfigured !== true || e.sdkEnvAuthMarkers !== false) return null;
  const home = e.codexHome;
  if (typeof home !== "string" || !isAbsolute(home)) return null;
  const denied = CODEX_HOME_DENIED.map((name) => present(join(home, name)));
  if (denied.some(Boolean)) return null;
  // No config.toml leaves the 0.163 default-on features enabled.
  const config = readBoundConfig(join(home, "config.toml"));
  if (config === null || !admitsCodexConfigToml(config.text)) return null;
  return { codexHome: home, sandboxMode: e.sandboxMode, configSha256: config.sha256, configStat: config.stat, denied,
    apiKeyConfigured: e.apiKeyConfigured, sdkEnvAuthMarkers: e.sdkEnvAuthMarkers };
}

/**
 * Bounded walk of the managed-preferences root (§4.4-1). Only a root `lstat`
 * of `ENOENT` is `absent`. Links are never followed; a symlink or any
 * non-regular, non-directory entry, any error (including an entry that
 * disappears after `readdir`), an entry deeper than 3, more than 4096 visited
 * entries or a Codex plist in any letter case is `off`.
 */
function managedPreferencesState(): "absent" | "clean" | "off" {
  let root;
  try {
    root = lstatSync(MANAGED_PREFERENCES_ROOT);
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "ENOENT" ? "absent" : "off";
  }
  if (!root.isDirectory()) return "off";
  try {
    let visited = 0;
    const queue: { readonly dir: string; readonly depth: number }[] = [{ dir: MANAGED_PREFERENCES_ROOT, depth: 0 }];
    for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
      for (const name of readdirSync(next.dir)) {
        const depth = next.depth + 1;
        if (++visited > MANAGED_PREFERENCES_MAX_ENTRIES || depth > MANAGED_PREFERENCES_MAX_DEPTH) return "off";
        if (name.toLowerCase() === CODEX_MANAGED_PLIST) return "off";
        const path = join(next.dir, name);
        const st = lstatSync(path);
        if (st.isDirectory()) queue.push({ dir: path, depth });
        else if (!st.isFile()) return "off";
      }
    }
    return "clean";
  } catch {
    return "off";
  }
}

/**
 * Host-administrative Codex layers (`/etc/codex`, a managed Codex plist) are
 * absent. A managed `cli_auth_credentials_store` would override the
 * app-server runtime's ephemeral store, so that runtime refuses to spawn
 * unless this holds.
 */
export function hostAdministrativeLayersAbsent(): boolean {
  return !SYSTEM_LAYERS.some(present) && managedPreferencesState() !== "off";
}

/** True when any ancestor of `cwd` (inclusive) carries a project `.codex` layer, or on any doubt. */
function projectLayerPresent(cwd: string): boolean {
  try {
    let dir = realpathSync(cwd);
    for (;;) {
      if (present(join(dir, ".codex"))) return true;
      const parent = dirname(dir);
      if (parent === dir) return false;
      dir = parent;
    }
  } catch {
    return true;
  }
}

/** Gateway-scoped G-d facts (v3.1 D1); exposures sorted by (codexHome, sandboxMode, apiKeyConfigured, sdkEnvAuthMarkers). */
interface GatewaySnapshot {
  readonly exposures: readonly ExposureFacts[];
  readonly processEnvAuthMarkers: boolean;
  readonly systemLayers: readonly boolean[];
  readonly mdm: "absent" | "clean";
}

/** Session-scoped G-d facts: the admitted cwd and its absent project layer. */
interface SessionSnapshot {
  readonly cwd: string;
  readonly projectLayer: false;
}

/** Deep-frozen facts captured at admit and recomputed at redeem. Holds no secret value. */
interface AdmitSnapshot {
  readonly gateway: GatewaySnapshot;
  readonly session: SessionSnapshot;
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Exposure order (v3.1 N-b); identical tuples are interchangeable. */
function compareExposures(a: ExposureFacts, b: ExposureFacts): number {
  return compareText(a.codexHome, b.codexHome) || compareText(a.sandboxMode, b.sandboxMode)
    || Number(a.apiKeyConfigured) - Number(b.apiKeyConfigured) || Number(a.sdkEnvAuthMarkers) - Number(b.sdkEnvAuthMarkers);
}

/**
 * Gateway terms: at least one running Bot (none at all is off), every
 * exposure admissible, no auth marker in the live `process.env`, no system
 * layer and a managed-preferences walk of `absent` or `clean`. Null when any
 * fails.
 */
function gatewaySnapshot(): GatewaySnapshot | null {
  if (exposures.size === 0) return null;
  const facts: ExposureFacts[] = [];
  for (const e of exposures.values()) {
    const f = exposureFacts(e);
    if (f === null) return null;
    facts.push(f);
  }
  const processEnvAuthMarkers = hasCodexAuthEnvMarker(process.env);
  if (processEnvAuthMarkers) return null;
  const systemLayers = SYSTEM_LAYERS.map(present);
  if (systemLayers.some(Boolean)) return null;
  const mdm = managedPreferencesState();
  if (mdm === "off") return null;
  return { exposures: facts.sort(compareExposures), processEnvAuthMarkers, systemLayers, mdm };
}

/** Session terms: an absolute cwd with no project `.codex` layer. */
function sessionSnapshot(cwd: unknown): SessionSnapshot | null {
  if (typeof cwd !== "string" || !isAbsolute(cwd) || projectLayerPresent(cwd)) return null;
  return { cwd, projectLayer: false };
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const v of Object.values(value)) deepFreeze(v);
    Object.freeze(value);
  }
  return value;
}

/**
 * Single-use admit slot (v3.1 N-c). {@link gatewayAdmitsInjection} fills it as
 * its last action; `prepareAttempt` clears it, calls `admit()` and takes it in
 * one synchronous step, so no other admit can interleave.
 */
let admitSlot: AdmitSnapshot | undefined;

/** Empty the admit slot and return what it held. */
function takeAdmitSlot(): AdmitSnapshot | undefined {
  const taken = admitSlot;
  admitSlot = undefined;
  return taken;
}

/**
 * G-d, evaluated against every running Bot's exposure at every attempt:
 * injection only when every Bot resolves to `read-only` with API-key auth
 * only, every Bot's CODEX_HOME admits nothing but the injected server, no
 * auth marker is in the live environment, no managed/system layer exists and
 * the session cwd has no project `.codex` layer. Unknown ⇒ off.
 */
export function gatewayAdmitsInjection(sessionCwd: string | undefined): boolean {
  let snapshot: AdmitSnapshot | undefined;
  try {
    const gateway = gatewaySnapshot();
    const session = gateway === null ? null : sessionSnapshot(sessionCwd);
    if (gateway !== null && session !== null) snapshot = deepFreeze({ gateway, session });
  } catch {
    snapshot = undefined;
  }
  admitSlot = snapshot;
  return snapshot !== undefined;
}

/**
 * Redeem-time fence (v3.1 D1): `gateway` when the gateway terms fail or
 * throw; `local` when the session terms fail or throw, or the recomputed
 * snapshot differs from the admitted one; `admitted` otherwise.
 */
function redeemFence(admitted: AdmitSnapshot): "admitted" | "local" | "gateway" {
  let gateway: GatewaySnapshot | null;
  try {
    gateway = gatewaySnapshot();
  } catch {
    gateway = null;
  }
  if (gateway === null) return "gateway";
  try {
    const session = sessionSnapshot(admitted.session.cwd);
    if (session === null) return "local";
    return isDeepStrictEqual(deepFreeze({ gateway, session }), admitted) ? "admitted" : "local";
  } catch {
    return "local";
  }
}

/** Case 2 on every live attempt registration of every host. */
function revokeEveryHost(): void {
  for (const host of [...liveHosts]) { try { host.revokeAll(); } catch { /* fenced per registration */ } }
}

/**
 * Record one running Bot's exposure. A registration that fails the
 * per-exposure G-d terms revokes every live attempt registration of every
 * host (case 2).
 */
export function registerGatewayExposure(entry: GatewayExposureEntry): () => void {
  const key = Symbol("bot");
  const recorded: GatewayExposureEntry = Object.freeze({ sandboxMode: entry.sandboxMode, codexHome: entry.codexHome,
    apiKeyConfigured: entry.apiKeyConfigured, sdkEnvAuthMarkers: entry.sdkEnvAuthMarkers });
  exposures.set(key, recorded);
  let unsafe: boolean;
  try { unsafe = exposureFacts(recorded) === null; } catch { unsafe = true; }
  if (unsafe) revokeEveryHost();
  return () => { exposures.delete(key); };
}

/** G-c: darwin-arm64 only; Linux and Windows stay off pending their probes. */
export function explicitPlatformCertified(platform: string = process.platform, arch: string = process.arch): boolean {
  return platform === "darwin" && arch === "arm64";
}

/** Roots a bootstrap path must stay outside of (§4.2). */
export function bootstrapExcludedRoots(input: {
  readonly cwdBase?: string; readonly additionalDirectories?: readonly string[]; readonly codexHome?: string;
}): readonly string[] {
  const roots = new Set<string>(["/tmp", tmpdir()]);
  const envTmp = process.env.TMPDIR;
  if (typeof envTmp === "string" && envTmp.length > 0) roots.add(envTmp);
  if (input.cwdBase) roots.add(input.cwdBase);
  for (const d of input.additionalDirectories ?? []) roots.add(d);
  if (input.codexHome) roots.add(input.codexHome);
  return Object.freeze([...roots]);
}

// ─── packaged entry (G-f) ───────────────────────────────────────────────────

export interface PackagedEntry {
  readonly nodePath: string;
  readonly serverPath: string;
}

export function defaultPackagedEntry(): PackagedEntry {
  return Object.freeze({ nodePath: process.execPath, serverPath: fileURLToPath(new URL("./mcp-server.js", import.meta.url)) });
}

function entryUsable(entry: PackagedEntry): boolean {
  try {
    if (!isAbsolute(entry.nodePath) || !isAbsolute(entry.serverPath)) return false;
    return statSync(entry.nodePath).isFile() && lstatSync(entry.serverPath).isFile();
  } catch {
    return false;
  }
}

function within(path: string, root: string): boolean {
  return path === root || path.startsWith(root.endsWith(sep) ? root : root + sep);
}

function realOrSelf(p: string): string {
  try { return realpathSync(p); } catch { return p; }
}

/** Every component of `path` resolves outside every excluded root. */
function contained(path: string, excluded: readonly string[]): boolean {
  const roots = excluded.flatMap((r) => (isAbsolute(r) ? [r, realOrSelf(r)] : []));
  const { root } = parsePath(path);
  let current = root;
  for (const part of path.slice(root.length).split(sep).filter((s) => s.length > 0)) {
    current = join(current, part);
    const real = realOrSelf(current);
    for (const r of roots) if (within(current, r) || within(real, r)) return false;
  }
  return true;
}

// ─── host ───────────────────────────────────────────────────────────────────

export type ToolHostStore = Pick<CardStore, "registerHandler" | "closeHandler" | "chargeExplicitRequest" | "reserveExplicitSend" | "finishExplicitRequest">;

export interface ToolHostOptions {
  /** Must be a store recovered by `openCardSubsystem` (G-g). */
  readonly store: CardStore;
  readonly installationRef: string;
  /** `<dataDir>/cards`; the bootstrap root is `<cardsDir>/bootstrap`. */
  readonly cardsDir: string;
  readonly ops: ExplicitOpTable;
  readonly excludedRoots: readonly string[];
  readonly clock: MonotonicClock;
  readonly wall: WallClock;
  readonly timers: HostTimers;
  readonly entry?: PackagedEntry;
  readonly transport?: ExplicitTransport;
  readonly policy?: Pick<CardPolicy, "authorize"> & Partial<Pick<CardPolicy, "snapshot">>;
}

export interface GenerationInput {
  /** Frozen trusted context carrying the stable `injectedServerId`. */
  readonly ctx: TrustedTurnContext;
  readonly binding: CardBinding;
  /** Monotonic dispatch deadline; rotation never extends it. */
  readonly expiresAtMono: number;
  /** Durable reset epoch at call time; a /reset fences the generation. */
  readonly currentResetEpoch: () => number;
  /** Ops offered to this generation (policy/route narrowed, table-backed). */
  readonly ops: readonly ToolOpcode[];
  /**
   * Per-attempt gates (G-d and runtime liveness); false ⇒ no injection for the
   * attempt. Its last term must be {@link gatewayAdmitsInjection}, whose
   * admit snapshot it captures; true without one opens no registration.
   */
  readonly admit: () => boolean;
}

export interface ExplicitGeneration {
  readonly launch: CardInjectionLaunch;
  readonly live: boolean;
  /** Settle/timeout/supersede/reset/shutdown fence; idempotent. */
  close(): void;
}

export interface ToolHostStats {
  readonly bootstrapRedeemed: number;
  readonly bootstrapReplay: number;
  readonly bootstrapExpired: number;
  readonly bootstrapUnknown: number;
  /** Redeem-time G-d fence closed the redeeming registration (v3.1 D1 steps 1–3). */
  readonly bootstrapAdmitDrift: number;
  /** The fence found the gateway terms failing and revoked every live registration (step 1 only). */
  readonly bootstrapAdmitGatewayRevoke: number;
  readonly authRejected: number;
  readonly frameRejected: number;
  readonly liveRegistrations: number;
  readonly liveListeners: number;
  /** App-server attempts opened with explicit tools. */
  readonly appAttempts: number;
  /** Δ0 refusals on the app-server path (unbound, foreign, admission, caps, unknown tool). */
  readonly appUnchargedRefusals: number;
  /** Calls naming another thread or turn (TB-4). */
  readonly appForeignCalls: number;
  /** Calls on a thread that predates the current toolset (T5/R1). */
  readonly appOldThreadCalls: number;
}

export interface ToolHost extends CardResourceOwner {
  readonly kind: "tool_host";
  openGeneration(input: GenerationInput): ExplicitGeneration | undefined;
  stats(): ToolHostStats;
}

class Closed extends Error { constructor() { super("explicit authority closed"); } }

interface Generation {
  readonly input: GenerationInput;
  readonly serverId: string;
  live: boolean;
  attempt: Registration | undefined;
  /** The app-server attempt binding, if any; a new attempt closes the previous one. */
  appAttempt: AppServerAttemptCards | undefined;
  readonly inflight: Map<string, Promise<CardToolResult>>;
  readonly requests: Set<RequestState>;
}

interface Registration {
  readonly gen: Generation;
  state: "pending" | "live" | "closed" | "revoked";
  readonly server: Server;
  readonly sockets: Set<Socket>;
  readonly authority: Buffer;
  readonly ticket: Buffer;
  readonly ticketPath: string;
  readonly dir: string;
  readonly ticketDeadlineMono: number;
  /** G-d facts captured synchronously with this attempt's admit. */
  readonly admitSnapshot: AdmitSnapshot;
  ttlTimer: unknown;
  expiryTimer: unknown;
  port: number;
}

interface RequestState {
  readonly gen: Generation;
  /** The MCP registration that charged it; absent on the app-server path. */
  readonly reg: Registration | undefined;
  readonly requestId: string;
  readonly abort: AbortController;
  /** Pre-reserve guard: authority live, generation live, not closing, not expired. */
  readonly live: () => boolean;
  /** Post-handler guard: the authority has not been closed. */
  readonly open: () => boolean;
  /** Set on rows the app-server dispatcher settles (SC-1). */
  readonly settledBy?: "app_server";
  reserved: boolean;
  /** `transport.send` was called (or may have been) for the reservation. */
  sendCalled: boolean;
  finished: boolean;
  result: CardToolResult | undefined;
  port: Promise<CardToolResult> | undefined;
}

function digest(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function sameBinding(a: CardBinding, b: CardBinding): boolean {
  return a.sessionKey === b.sessionKey && a.channelId === b.channelId && a.channelType === b.channelType
    && a.topicScope === b.topicScope && a.generation === b.generation && a.resetEpoch === b.resetEpoch;
}

function ctEqualHex(expected: Buffer, presented: string): boolean {
  if (presented.length !== expected.length * 2 || !/^[0-9a-f]+$/.test(presented)) return false;
  return timingSafeEqual(expected, Buffer.from(presented, "hex"));
}

function lengthPrefixed(frame: Uint8Array): Buffer {
  return Buffer.from(frame.buffer, frame.byteOffset, frame.byteLength);
}

/** Context reference bound into the registration tuple; never model-derived. */
function contextRef(ctx: TrustedTurnContext): string {
  return digest(canonicalJson({
    route: { channelId: ctx.route.channelId, channelType: ctx.route.channelType, ...(ctx.route.topicScope !== undefined ? { topicScope: ctx.route.topicScope } : {}) },
    requesterUid: ctx.requesterUid, sessionKey: ctx.sessionKey,
    routeEligibility: { ...ctx.routeEligibility },
    origin: ctx.origin.kind === "user" ? { kind: "user" } : { kind: ctx.origin.kind, admissionId: ctx.origin.admissionId },
  }));
}

/**
 * Build the Bot's tool host; undefined (never a throw) when the ledger was not
 * recovered first or the bootstrap root cannot be prepared.
 */
export function createToolHost(options: ToolHostOptions): ToolHost | undefined {
  // Restart ordering (G-g): no listener may exist before `recoverExplicitLedger` ran.
  if (!ledgerRecovered(options.store)) return undefined;
  const { store, clock, wall, timers } = options;
  const entry = options.entry ?? defaultPackagedEntry();
  const bootstrapRoot = join(options.cardsDir, "bootstrap");
  try {
    // Startup removes any stale bootstrap directory before the first listener exists.
    rmSync(bootstrapRoot, { recursive: true, force: true });
    mkdirSync(bootstrapRoot, { recursive: true, mode: 0o700 });
  } catch {
    return undefined;
  }

  const counters = { bootstrapRedeemed: 0, bootstrapReplay: 0, bootstrapExpired: 0, bootstrapUnknown: 0,
    bootstrapAdmitDrift: 0, bootstrapAdmitGatewayRevoke: 0, authRejected: 0, frameRejected: 0,
    appAttempts: 0, appUnchargedRefusals: 0, appForeignCalls: 0, appOldThreadCalls: 0 };
  const generations = new Set<Generation>();
  const registrations = new Set<Registration>();
  /** Every unfinished charged request of this host, for the shutdown drain. */
  const open = new Set<RequestState>();
  const work = new Set<Promise<unknown>>();
  let closing = false;

  const track = <T>(p: Promise<T>): Promise<T> => {
    const settled = p.then(() => undefined, () => undefined);
    work.add(settled);
    void settled.finally(() => work.delete(settled));
    return p;
  };

  const fence = (gen: Generation) => ({
    generation: gen.input.ctx.turnGeneration,
    runtimeIncarnation: gen.input.ctx.runtimeIncarnation,
    resetEpoch: gen.input.currentResetEpoch(),
  });

  /** Ledger finish; a request already finished elsewhere stays as it is. */
  const finish = (gen: Generation, requestId: string, outcome: ExplicitFinish, result: CardToolResult,
    message?: FinishExplicitInput["message"], settledBy?: "app_server"): boolean => {
    try {
      const r = store.finishExplicitRequest({ generation: gen.input.ctx.turnGeneration, requestId, outcome,
        safeResultJson: JSON.stringify(result), ...(message !== undefined ? { message } : {}),
        ...(settledBy !== undefined ? { settledBy } : {}) });
      return r.kind === "finished";
    } catch {
      return false;
    }
  };

  // ── registrations ──

  function teardown(reg: Registration): void {
    timers.clearTimeout(reg.ttlTimer);
    timers.clearTimeout(reg.expiryTimer);
    try { reg.server.close(); } catch { /* already closed */ }
    for (const s of reg.sockets) { try { s.destroy(); } catch { /* gone */ } }
    reg.sockets.clear();
    try { unlinkSync(reg.ticketPath); } catch { /* already unlinked */ }
    try { rmSync(reg.dir, { recursive: true, force: true }); } catch { /* best effort; startup sweeps */ }
    reg.authority.fill(0);
    reg.ticket.fill(0);
    registrations.delete(reg);
    if (reg.gen.attempt === reg) reg.gen.attempt = undefined;
  }

  /** Normal close (rotation, attempt end, TTL, generation close). */
  function closeRegistration(reg: Registration): void {
    if (reg.state === "closed" || reg.state === "revoked") return;
    reg.state = "closed";
    for (const req of reg.gen.requests) if (req.reg === reg) req.abort.abort();
    teardown(reg);
  }

  /** §5 case 2: replay while live, or a gateway-wide G-d failure. */
  function revokeRegistration(reg: Registration): void {
    if (reg.state === "closed" || reg.state === "revoked") return;
    reg.state = "revoked";
    for (const req of reg.gen.requests) {
      if (req.reg !== reg || req.finished) continue;
      req.abort.abort();
      // charged → cancelled; reserved → ambiguous (retained, never resubmitted).
      if (req.reserved) {
        if (finish(reg.gen, req.requestId, "ambiguous", SEND_UNCONFIRMED, { kind: "ambiguous" })) { req.finished = true; req.result = SEND_UNCONFIRMED; }
      } else if (finish(reg.gen, req.requestId, "cancelled", AUTHORITY_CLOSED)) {
        req.finished = true; req.result = AUTHORITY_CLOSED;
      }
    }
    teardown(reg);
  }

  function closeGeneration(gen: Generation): void {
    if (!gen.live) return;
    gen.live = false;
    try { store.closeHandler(gen.input.ctx.turnGeneration); } catch { /* the in-memory fence still holds */ }
    if (gen.attempt !== undefined) closeRegistration(gen.attempt);
    gen.appAttempt?.close();
    for (const req of gen.requests) req.abort.abort();
    generations.delete(gen);
  }

  function registrationLive(reg: Registration): boolean {
    return reg.state === "live" && reg.gen.live && !closing && clock.nowMono() < reg.gen.input.expiresAtMono;
  }

  // ── dispatch ──

  function reply(socket: Socket, requestId: string, result: CardToolResult): void {
    if (socket.destroyed) return;
    let frame: Uint8Array;
    try { frame = encodeReplyFrame({ v: 1, request_id: requestId, result }); }
    catch { frame = encodeReplyFrame({ v: 1, request_id: requestId, result: EXPLICIT_OP_UNAVAILABLE }); }
    try { socket.write(lengthPrefixed(frame)); } catch { /* peer gone */ }
  }

  function rejectSocket(socket: Socket): void {
    try { socket.destroy(); } catch { /* gone */ }
  }

  function onBootstrap(reg: Registration, socket: Socket, body: Uint8Array): void {
    const frame = parseBootstrapFrame(body);
    if (frame === null) { counters.frameRejected++; rejectSocket(socket); return; }
    if (reg.state === "closed" || reg.state === "revoked") { counters.bootstrapExpired++; rejectSocket(socket); return; }
    if (!ctEqualHex(reg.ticket, frame.bootstrap)) { counters.bootstrapUnknown++; rejectSocket(socket); return; }
    if (reg.state === "live") {
      // Case 2: the ticket was already consumed and the registration is live.
      counters.bootstrapReplay++;
      revokeRegistration(reg);
      return;
    }
    if (clock.nowMono() >= reg.ticketDeadlineMono || !reg.gen.live || closing) {
      // Case 3 reached before the TTL timer fired.
      counters.bootstrapExpired++;
      closeRegistration(reg);
      return;
    }
    // Redeem-time G-d fence: before any authority, request or ledger state exists.
    const fenced = redeemFence(reg.admitSnapshot);
    if (fenced !== "admitted") {
      counters.bootstrapAdmitDrift++;
      closeRegistration(reg);
      if (fenced === "gateway") {
        // Some Bot's exposure is no longer admissible: every live authority goes (case 2).
        counters.bootstrapAdmitGatewayRevoke++;
        revokeEveryHost();
      }
      return;
    }
    // Case 1: first valid redemption.
    reg.state = "live";
    counters.bootstrapRedeemed++;
    timers.clearTimeout(reg.ttlTimer);
    try { unlinkSync(reg.ticketPath); } catch { /* already gone */ }
    let out: Uint8Array;
    try { out = encodeBootstrapReply({ v: 1, authority: reg.authority.toString("hex"), ops: reg.gen.input.ops }); }
    catch { closeRegistration(reg); return; }
    try { socket.write(lengthPrefixed(out)); } catch { /* the proxy stays inert */ }
  }

  async function onCall(reg: Registration, socket: Socket, body: Uint8Array): Promise<void> {
    // D0: framing, version, ids and closed grammar, before any authority state.
    const parsed = parseRequestFrame(body);
    if (!parsed.ok && parsed.stage === "frame") { counters.frameRejected++; rejectSocket(socket); return; }
    const header = parsed.ok ? parsed.frame : parsed.header;
    // D1: authenticate on the receiving registration only.
    if (reg.state !== "live" || !ctEqualHex(reg.authority, header.authority)) { counters.authRejected++; rejectSocket(socket); return; }
    const gen = reg.gen;
    const requestId = header.request_id;
    // Fence and liveness before accounting.
    if (!registrationLive(reg)) { reply(socket, requestId, AUTHORITY_CLOSED); return; }
    const canonical = canonicalRequestBody(body);
    if (canonical === null) { counters.frameRejected++; rejectSocket(socket); return; }
    // D2: charge with (generation, request_id, RFC 8785 digest) deduplication.
    let charge;
    try {
      charge = store.chargeExplicitRequest({ ...fence(gen), requestId, bodyDigest: digest(canonical), opcode: header.op });
    } catch {
      reply(socket, requestId, AUTHORITY_CLOSED);
      return;
    }
    switch (charge.kind) {
      case "rejected":
        reply(socket, requestId, AUTHORITY_CLOSED);
        if (charge.reason !== "unknown_generation") closeGeneration(gen);
        return;
      case "exhausted":
        reply(socket, requestId, EXPLICIT_BUDGET_EXHAUSTED as CardToolResult);
        return;
      case "body_mismatch":
        reply(socket, requestId, REQUEST_ID_REUSED);
        return;
      case "joined": {
        reply(socket, requestId, await joinResult(gen, requestId, charge.request));
        return;
      }
      case "charged":
        break;
      default:
        reply(socket, requestId, AUTHORITY_CLOSED);
        return;
    }
    const req: RequestState = {
      gen, reg, requestId, abort: new AbortController(), live: () => registrationLive(reg), open: () => reg.state === "live",
      reserved: false, sendCalled: false, finished: false, result: undefined, port: undefined,
    };
    gen.requests.add(req);
    open.add(req);
    const run = track(runCharged(gen, req, header.op, parsed));
    gen.inflight.set(requestId, run);
    let result: CardToolResult;
    try { result = await run; } finally { gen.inflight.delete(requestId); gen.requests.delete(req); open.delete(req); }
    reply(socket, requestId, result);
  }

  async function joinResult(gen: Generation, requestId: string, record: { state: string; safeResultJson: string | null }): Promise<CardToolResult> {
    if (record.safeResultJson !== null) {
      const parsed = parseStrictJson(record.safeResultJson, { maxDepth: 8, maxNodes: 256, unsafeIntegers: "reject" });
      const result = parsed.ok ? parseCardToolResult(parsed.value as JsonValue) : null;
      return result ?? EXPLICIT_OP_UNAVAILABLE;
    }
    const pending = gen.inflight.get(requestId);
    if (pending !== undefined) { try { return await pending; } catch { return EXPLICIT_OP_UNAVAILABLE; } }
    // Retained row with no in-flight promise (§7.4).
    return record.state === "charged" ? EXPLICIT_OP_UNAVAILABLE : SEND_UNCONFIRMED;
  }

  async function runCharged(gen: Generation, req: RequestState, op: ToolOpcode, parsed: ReturnType<typeof parseRequestFrame>): Promise<CardToolResult> {
    const settle = (outcome: ExplicitFinish, result: CardToolResult): CardToolResult => {
      if (!req.finished && finish(gen, req.requestId, outcome, result, undefined, req.settledBy)) { req.finished = true; req.result = result; }
      return req.result ?? result;
    };
    // D3: handler lookup. Absent → charged, failed, no reservation, transport or sequence.
    const handler = gen.input.ops.includes(op) ? options.ops.get(op) : undefined;
    if (handler === undefined || handler.op !== op) return settle("failed", EXPLICIT_OP_UNAVAILABLE);
    // D4: argument validation. Reject → charged, failed, no reservation.
    if (!parsed.ok) {
      if (parsed.stage !== "args") return settle("failed", EXPLICIT_OP_UNAVAILABLE);
      return settle("failed", errorResult(parsed.code, parsed.diagnostics));
    }
    // D5: the handler, through the host-owned send port.
    const port: ExplicitSendPort = { reserveAndSend: (card) => {
      if (req.port !== undefined) return Promise.reject(new Error("explicit send already reserved"));
      req.port = reserveAndSend(gen, req, op, card);
      return req.port;
    } };
    let handled: CardToolResult | undefined;
    let threw = false;
    try {
      handled = await handler.handle(parsed.frame.args as never, Object.freeze({ ctx: gen.input.ctx, requestId: req.requestId }), port, req.abort.signal);
    } catch {
      threw = true;
    }
    if (req.port !== undefined) {
      let sent: CardToolResult | undefined;
      try { sent = await req.port; } catch { threw = true; }
      // Post-reserve outcomes are host-owned; the handler cannot choose them.
      if (req.reserved || req.finished) return req.result ?? sent ?? SEND_UNCONFIRMED;
    }
    // No reservation was made.
    const closedNow = req.abort.signal.aborted || !gen.live || !req.open();
    if (closedNow) return settle("cancelled", AUTHORITY_CLOSED);
    if (threw) return settle("failed", EXPLICIT_OP_UNAVAILABLE);
    const valid = handled !== undefined ? parseCardToolResult(JSON.parse(JSON.stringify(handled)) as JsonValue) : null;
    // A success without a reservation would be fabricated.
    return settle("failed", valid !== null && valid.status === "error" ? valid : EXPLICIT_OP_UNAVAILABLE);
  }

  async function reserveAndSend(gen: Generation, req: RequestState, op: ToolOpcode, card: ExplicitCard): Promise<CardToolResult> {
    const settled = (outcome: ExplicitFinish, result: CardToolResult, message?: FinishExplicitInput["message"]): CardToolResult => {
      if (!req.finished && finish(gen, req.requestId, outcome, result, message, req.settledBy)) { req.finished = true; req.result = result; }
      return req.result ?? result;
    };
    // Pre-reserve: any failure here leaves the request charged for the D5 outcome.
    if (req.abort.signal.aborted || !req.live()) throw new Closed();
    if (options.transport === undefined) throw new Error("explicit transport unavailable");
    if (card === null || typeof card !== "object" || card.opcode !== op || !sameBinding(card.binding, gen.input.binding)) {
      throw new Error("explicit card binding mismatch");
    }
    if (options.policy !== undefined) {
      let allowed = false;
      try {
        if (card.informational === true) {
          const snapshot = await options.policy.snapshot?.();
          allowed = snapshot !== undefined && snapshot.botRef.originKey === gen.input.ctx.botRef.originKey
            && snapshot.botRef.credentialRef === gen.input.ctx.botRef.credentialRef && interactionDegradation(snapshot) === card.reason;
        } else allowed = options.policy.authorize(op === "display" ? "display" : "interaction", { botRef: gen.input.ctx.botRef }).allowed;
      } catch { allowed = false; }
      if (!allowed) return settled("failed", POLICY_DENIED);
    }
    // Policy probing can await: recheck closure immediately before the atomic store fence.
    if (req.abort.signal.aborted || !req.live()) throw new Closed();
    const r = store.reserveExplicitSend({ ...fence(gen), requestId: req.requestId, card });
    switch (r.kind) {
      case "reserved": break;
      case "exhausted": req.finished = true; req.result = EXPLICIT_BUDGET_EXHAUSTED as CardToolResult; return req.result;
      case "capacity_full": req.finished = true; req.result = CAPACITY_FULL; return req.result;
      case "rejected":
        if (r.reason !== "unknown_generation") closeGeneration(gen);
        throw new Closed();
      default: throw new Error("explicit reservation unavailable");
    }
    req.reserved = true;
    // App-server path: a call stopped before the send is provably unsent (R-4 `abandoned`; the slot stays consumed).
    if (req.settledBy !== undefined && req.abort.signal.aborted) {
      return settled("cancelled", AUTHORITY_CLOSED, { kind: "abandoned" });
    }
    // Post-reserve: host-owned classification; any doubt is ambiguous.
    let outcome: ExplicitTransportOutcome;
    req.sendCalled = true;
    try {
      outcome = await options.transport.send({ ctx: gen.input.ctx, card, cardId: r.cardId, clientMsgNo: r.clientMsgNo, signal: req.abort.signal });
    } catch {
      outcome = { kind: "ambiguous" };
    }
    // SC-1: the reply timer already settled this row ambiguous; the late outcome is audit (and card binding) only.
    if (req.settledBy !== undefined && req.finished) {
      recordLate(gen, req, op, outcome);
      return req.result ?? SEND_UNCONFIRMED;
    }
    if (outcome.kind === "acked") {
      let policyAllows = true;
      if (op === 'interactive' && card.informational !== true && options.policy !== undefined) {
        try { policyAllows = options.policy.authorize('interaction', { botRef: gen.input.ctx.botRef }).allowed; }
        catch { policyAllows = false; }
      }
      const result: CardToolResult = !policyAllows ? POLICY_DENIED : card.informational === true
        ? { status: "degraded", message_id: outcome.messageId, interaction_available: false, reason: card.reason }
        : { status: "sent", message_id: outcome.messageId,
        route: { kind: gen.input.ctx.routeEligibility.kind, ref: r.cardId.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 64) || "card" },
        ...(r.sessionId !== null ? { session_id: r.sessionId.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 64) } : {}) };
      const valid = parseCardToolResult(result as unknown as JsonValue);
      if (valid !== null && finish(gen, req.requestId, "acked", valid,
        { kind: "ack", messageId: outcome.messageId, currentResetEpoch: gen.input.currentResetEpoch(), policyAllows }, req.settledBy)) {
        req.finished = true; req.result = valid;
        return valid;
      }
      return settled("ambiguous", SEND_UNCONFIRMED, { kind: "ambiguous" });
    }
    if (outcome.kind === "failed") return settled("failed", SEND_FAILED, { kind: "failed" });
    return settled("ambiguous", SEND_UNCONFIRMED, { kind: "ambiguous" });
  }

  /** SC-1b: a late transport outcome after an app-server `ambiguous` settlement. */
  function recordLate(gen: Generation, req: RequestState, op: ToolOpcode, outcome: ExplicitTransportOutcome): void {
    if (outcome.kind === "ambiguous") return;
    let policyAllows = true;
    if (options.policy !== undefined) {
      try { policyAllows = options.policy.authorize(op === "display" ? "display" : "interaction", { botRef: gen.input.ctx.botRef }).allowed; } catch { policyAllows = false; }
    }
    try {
      store.recordLateExplicitOutcome(outcome.kind === "acked"
        ? { generation: gen.input.ctx.turnGeneration, requestId: req.requestId, outcome: "acked",
          ack: { messageId: outcome.messageId, currentResetEpoch: gen.input.currentResetEpoch(), policyAllows } }
        : { generation: gen.input.ctx.turnGeneration, requestId: req.requestId, outcome: "failed" });
    } catch { /* audit only */ }
  }

  // ── app-server attempts ──

  const PLACEHOLDER_REQUEST_ID = "0".repeat(32);
  const PLACEHOLDER_AUTHORITY = "0".repeat(64);

  interface CallParams {
    readonly threadId: string; readonly turnId: string; readonly callId: string;
    readonly namespace: string | null; readonly tool: string; readonly arguments: unknown;
  }

  function callParams(v: unknown): CallParams | null {
    if (v === null || typeof v !== "object" || Array.isArray(v)) return null;
    const p = v as Record<string, unknown>;
    if (typeof p.threadId !== "string" || typeof p.turnId !== "string" || typeof p.callId !== "string" || typeof p.tool !== "string") return null;
    if (p.namespace !== null && p.namespace !== undefined && typeof p.namespace !== "string") return null;
    return { threadId: p.threadId, turnId: p.turnId, callId: p.callId, namespace: (p.namespace as string | null | undefined) ?? null, tool: p.tool, arguments: p.arguments };
  }

  /** D6: the dynamic tool reply carrying the bounded card result. */
  function toolReply(result: CardToolResult): { contentItems: { type: "inputText"; text: string }[]; success: boolean } {
    return { contentItems: [{ type: "inputText", text: JSON.stringify(result) }], success: result.status === "sent" || result.status === "degraded" };
  }

  function refusalReply(text: string): { contentItems: { type: "inputText"; text: string }[]; success: false } {
    return { contentItems: [{ type: "inputText", text }], success: false };
  }

  function openAppAttempt(gen: Generation, port: AppServerReplyPort): AppServerAttemptCards {
    const toolset = appServerToolset(gen.input.ops);
    let state: "live" | "closed" = "live";
    let threadId: string | null = null;
    let threadTools: ReadonlySet<string> = new Set();
    let turnStart: "none" | "outstanding" | "completed" = "none";
    let activeTurnId: string | null = null;
    let chargedTasks = 0;
    const joins = new Map<string, number>();

    interface Latch { readonly done: boolean; answer(result: unknown, uncharged: boolean): void }
    interface Call {
      readonly id: number | string; readonly p: CallParams; latch: Latch; req: RequestState | undefined;
      /** What the call's own timer does: refuse while held, R-4 once admitted (A5 keeps the timer). */
      onTimer: () => void;
    }
    const held: Call[] = [];
    const charged = new Set<Call>();

    /** One reply per JSON-RPC id, with its own settle timer from frame read (R-2, R-8). */
    const latch = (id: number | string, receivedAt: number, onTimer: () => void): Latch => {
      let done = false;
      const timer = timers.setTimeout(() => { if (!done) onTimer(); }, Math.max(0, receivedAt + CALL_SETTLE_MS - clock.nowMono()));
      return {
        get done() { return done; },
        answer(result, uncharged) {
          if (done) return;
          done = true;
          timers.clearTimeout(timer);
          if (uncharged) counters.appUnchargedRefusals++;
          try { port.respond(id, result, { uncharged }); } catch { /* the client is closed */ }
        },
      };
    };
    const refuse = (id: number | string, text: string): void => {
      counters.appUnchargedRefusals++;
      try { port.respond(id, refusalReply(text), { uncharged: true }); } catch { /* closed */ }
    };

    /** attemptLive (§5.2): binding, generation, deadline, child and turn. */
    const attemptLive = (p: CallParams): boolean => state === "live" && gen.live && !closing
      && clock.nowMono() < gen.input.expiresAtMono && activeTurnId !== null && p.threadId === threadId && p.turnId === activeTurnId;

    /** R-4: stop a charged call by row state; the slot of an abandoned send stays consumed. */
    const r4 = (call: Call): void => {
      const req = call.req;
      if (req === undefined) { call.latch.answer(refusalReply("explicit cards are unavailable"), true); return; }
      if (!req.finished) {
        req.abort.abort();
        let outcome: ExplicitFinish = "cancelled";
        let result: CardToolResult = AUTHORITY_CLOSED;
        let message: FinishExplicitInput["message"];
        if (req.reserved && !req.sendCalled) message = { kind: "abandoned" };
        else if (req.reserved) { outcome = "ambiguous"; result = SEND_UNCONFIRMED; message = { kind: "ambiguous" }; }
        if (finish(gen, req.requestId, outcome, result, message, "app_server")) { req.finished = true; req.result = result; }
      }
      call.latch.answer(toolReply(req.result ?? EXPLICIT_OP_UNAVAILABLE), false);
    };

    /** Receipt or release from `held`: D1′ trusted turn, admission, D0/D4 grammar, D2 charge. */
    const admit = (call: Call): void => {
      const { p } = call;
      if (p.turnId !== activeTurnId) { counters.appForeignCalls++; call.latch.answer(refusalReply("not the active turn"), true); return; }
      if (!attemptLive(p)) { call.latch.answer(refusalReply("explicit cards are unavailable"), true); return; }
      if (gen.input.expiresAtMono - clock.nowMono() < CALL_ADMISSION_MS) {
        call.latch.answer(refusalReply("explicit cards are unavailable for the rest of this turn"), true); return;
      }
      if (p.namespace !== null || (p.tool !== "display" && p.tool !== "interactive") || !threadTools.has(p.tool)) {
        if (threadTools.size === 0) counters.appOldThreadCalls++;
        call.latch.answer(refusalReply("unknown tool"), true); return;
      }
      if (chargedTasks >= MAX_EXPLICIT_INVOCATIONS) { call.latch.answer(refusalReply("too many concurrent card calls"), true); return; }
      const op = p.tool as ToolOpcode;
      // D0/D4: the closed grammar of the MCP frames, applied to `{op, args}`.
      let body: Uint8Array;
      try { body = Buffer.from(JSON.stringify({ v: 1, request_id: PLACEHOLDER_REQUEST_ID, authority: PLACEHOLDER_AUTHORITY, op, args: p.arguments }), "utf8"); }
      catch { call.latch.answer(refusalReply("invalid arguments"), true); return; }
      const parsed = parseRequestFrame(body);
      const canonical = canonicalRequestBody(body);
      if ((!parsed.ok && parsed.stage === "frame") || canonical === null) { call.latch.answer(refusalReply("invalid arguments"), true); return; }
      // §5.3: one ledger row per logical call, inside the existing (generation, request_id) key.
      const requestId = `a1:${digest(canonicalJson([p.threadId, p.turnId, p.callId]))}`;
      let charge;
      try { charge = store.chargeExplicitRequest({ ...fence(gen), requestId, bodyDigest: digest(canonical), opcode: op }); }
      catch { call.latch.answer(toolReply(AUTHORITY_CLOSED), true); return; }
      switch (charge.kind) {
        case "rejected":
          call.latch.answer(toolReply(AUTHORITY_CLOSED), true);
          if (charge.reason !== "unknown_generation") closeGeneration(gen);
          return;
        case "exhausted": call.latch.answer(toolReply(EXPLICIT_BUDGET_EXHAUSTED as CardToolResult), true); return;
        case "body_mismatch": call.latch.answer(toolReply(REQUEST_ID_REUSED), true); return;
        case "joined": {
          const n = (joins.get(requestId) ?? 0) + 1;
          if (n > JOIN_MAX) { call.latch.answer(refusalReply("duplicate call"), true); return; }
          joins.set(requestId, n);
          void joinResult(gen, requestId, charge.request).then((r) => call.latch.answer(toolReply(r), false),
            () => call.latch.answer(toolReply(EXPLICIT_OP_UNAVAILABLE), false));
          return;
        }
        case "charged": break;
        default: call.latch.answer(toolReply(AUTHORITY_CLOSED), true); return;
      }
      const req: RequestState = {
        gen, reg: undefined, requestId, abort: new AbortController(), live: () => attemptLive(p), open: () => state === "live",
        settledBy: "app_server", reserved: false, sendCalled: false, finished: false, result: undefined, port: undefined,
      };
      call.req = req;
      charged.add(call);
      chargedTasks++;
      gen.requests.add(req);
      open.add(req);
      const run = track(runCharged(gen, req, op, parsed));
      gen.inflight.set(requestId, run);
      void run.then((result) => call.latch.answer(toolReply(result), false), () => call.latch.answer(toolReply(EXPLICIT_OP_UNAVAILABLE), false))
        .finally(() => { gen.inflight.delete(requestId); gen.requests.delete(req); open.delete(req); charged.delete(call); chargedTasks--; });
    };

    const handle: AppServerAttemptCards = {
      dynamicTools: toolset.tools,
      toolsetDigest: toolset.digest,
      setThread(id, threadDigest) {
        threadId = id;
        threadTools = threadDigest === toolset.digest ? new Set(toolset.tools.map((t) => t.name)) : new Set();
      },
      turnStartEnqueued() { if (turnStart === "none") turnStart = "outstanding"; },
      bindTurn(turnId) {
        if (state !== "live" || activeTurnId !== null || turnStart !== "outstanding") return;
        activeTurnId = turnId;
        // A5: released calls keep their original timers, now stopping them by row state.
        for (const call of held.splice(0)) {
          if (call.latch.done) continue;
          call.onTimer = () => r4(call);
          admit(call);
        }
      },
      turnCompleted() {
        activeTurnId = null;
        turnStart = "completed";
        for (const call of held.splice(0)) call.latch.answer(refusalReply("turn not yet bound"), true);
      },
      onToolCall(id, params) {
        const receivedAt = clock.nowMono();
        const p = callParams(params);
        if (p === null || state !== "live") { refuse(id, "explicit cards are unavailable"); return; }
        if (threadId === null || p.threadId !== threadId) { counters.appForeignCalls++; refuse(id, "unknown thread"); return; }
        const call: Call = { id, p, latch: undefined as unknown as Latch, req: undefined, onTimer: () => r4(call) };
        call.latch = latch(id, receivedAt, () => call.onTimer());
        if (activeTurnId === null) {
          if (turnStart !== "outstanding" || held.length >= HOLD_MAX) { call.latch.answer(refusalReply("turn not yet bound"), true); return; }
          call.onTimer = () => {
            const i = held.indexOf(call);
            if (i >= 0) held.splice(i, 1);
            call.latch.answer(refusalReply("turn not yet bound"), true);
          };
          held.push(call);
          return;
        }
        admit(call);
      },
      close() {
        if (state === "closed") return;
        state = "closed";
        for (const call of held.splice(0)) call.latch.answer(refusalReply("turn not yet bound"), true);
        for (const call of [...charged]) r4(call);
        if (gen.appAttempt === handle) gen.appAttempt = undefined;
      },
    };
    return handle;
  }

  function attachSocket(reg: Registration, socket: Socket): void {
    if (reg.state === "closed" || reg.state === "revoked" || reg.sockets.size >= MAX_CONNECTIONS_PER_REGISTRATION) {
      rejectSocket(socket);
      return;
    }
    reg.sockets.add(socket);
    socket.setNoDelay(true);
    let buffer: Buffer = Buffer.alloc(0);
    let pending = 0;
    socket.on("data", (chunk: Buffer) => {
      buffer = buffer.length === 0 ? chunk : Buffer.concat([buffer, chunk]);
      for (;;) {
        const r = readFrame(buffer);
        if (r.kind === "incomplete") return;
        if (r.kind === "error") { counters.frameRejected++; rejectSocket(socket); return; }
        buffer = buffer.subarray(r.consumed);
        if (++pending > MAX_PENDING_FRAMES_PER_SOCKET) { rejectSocket(socket); return; }
        const body = r.body;
        if (isBootstrapShaped(body)) { pending--; onBootstrap(reg, socket, body); continue; }
        void track(onCall(reg, socket, body)).catch(() => undefined).finally(() => { pending--; });
      }
    });
    socket.on("error", () => { /* closed below */ });
    socket.on("close", () => { reg.sockets.delete(socket); });
  }

  async function openRegistration(gen: Generation, admitSnapshot: AdmitSnapshot): Promise<Registration | undefined> {
    let dir: string | undefined;
    let fd: number | undefined;
    let server: Server | undefined;
    try {
      if (!contained(bootstrapRoot, options.excludedRoots)) return undefined;
      dir = mkdtempSync(join(bootstrapRoot, "r-"));
      const ticketPath = join(dir, "t");
      if (!contained(ticketPath, options.excludedRoots)) throw new Error("bootstrap path not contained");
      const ticket = randomBytes(32);
      const authority = randomBytes(32);
      fd = openSync(ticketPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
      const text = Buffer.from(ticket.toString("hex"), "utf8");
      if (writeSync(fd, text, 0, text.length, 0) !== text.length) throw new Error("short ticket write");
      const st = fstatSync(fd);
      if (!st.isFile() || (process.platform !== "win32" && (st.mode & 0o777) !== 0o600)) throw new Error("ticket mode");
      closeSync(fd);
      fd = undefined;
      const srv = createServer({ allowHalfOpen: false, pauseOnConnect: false });
      server = srv;
      await new Promise<void>((resolve, reject) => {
        srv.once("error", reject);
        srv.listen({ host: "127.0.0.1", port: 0, exclusive: true }, () => { srv.off("error", reject); resolve(); });
      });
      const address = srv.address();
      if (address === null || typeof address !== "object" || address.address !== "127.0.0.1") throw new Error("listener address");
      const now = clock.nowMono();
      const reg: Registration = {
        gen, state: "pending", server: srv, sockets: new Set(), authority, ticket, ticketPath, dir,
        ticketDeadlineMono: now + BOOTSTRAP_TTL_MS, admitSnapshot, ttlTimer: undefined, expiryTimer: undefined, port: address.port,
      };
      srv.on("connection", (socket) => attachSocket(reg, socket));
      srv.on("error", () => closeRegistration(reg));
      // Case 3: never redeemed by the TTL → normal close.
      reg.ttlTimer = timers.setTimeout(() => {
        if (reg.state === "pending") { counters.bootstrapExpired++; closeRegistration(reg); }
      }, BOOTSTRAP_TTL_MS);
      reg.expiryTimer = timers.setTimeout(() => closeGeneration(gen), Math.max(0, gen.input.expiresAtMono - now));
      return reg;
    } catch {
      if (fd !== undefined) { try { closeSync(fd); } catch { /* closed */ } }
      if (server !== undefined) { try { server.close(); } catch { /* closed */ } }
      if (dir !== undefined) { try { rmSync(dir, { recursive: true, force: true }); } catch { /* swept at startup */ } }
      return undefined;
    }
  }

  function makeLaunch(gen: Generation): CardInjectionLaunch {
    const prepareAttempt = async (): Promise<AttemptHandle | undefined> => {
      try {
        // Rotation: the previous registration closes; the generation ledger is kept.
        if (gen.attempt !== undefined) closeRegistration(gen.attempt);
        if (!gen.live || closing || clock.nowMono() >= gen.input.expiresAtMono || gen.input.ops.length === 0) return undefined;
        // Single-use admit slot: clear, admit, take and clear again, with no await in between.
        let admitted = false;
        let snapshot: AdmitSnapshot | undefined;
        takeAdmitSlot();
        try {
          admitted = gen.input.admit();
          snapshot = takeAdmitSlot();
        } finally {
          takeAdmitSlot();
        }
        // An admit that did not run G-d (an empty slot) opens nothing.
        if (admitted !== true || snapshot === undefined || !isAbsolute(snapshot.session.cwd) || !entryUsable(entry)) return undefined;
        const reg = await openRegistration(gen, snapshot);
        if (reg === undefined) return undefined;
        if (!gen.live || closing) { closeRegistration(reg); return undefined; }
        registrations.add(reg);
        gen.attempt = reg;
        const tools: Record<string, { approval_mode: "approve" }> = {};
        for (const op of gen.input.ops) tools[op] = { approval_mode: "approve" };
        const mcpEntry = Object.freeze({
          command: entry.nodePath,
          args: Object.freeze([entry.serverPath, "--bootstrap", reg.ticketPath, "--port", String(reg.port)]),
          required: true,
          startup_timeout_sec: MCP_STARTUP_TIMEOUT_SEC,
          startup_readiness: "connection",
          enabled_tools: Object.freeze([...gen.input.ops]),
          tools: Object.freeze(tools),
        });
        let closed = false;
        return Object.freeze({
          mcpEntry,
          close(): void { if (closed) return; closed = true; closeRegistration(reg); },
          isTrustedServer(server: unknown): boolean {
            return server === gen.serverId && gen.live && !closed && reg.state === "live";
          },
        });
      } catch {
        return undefined;
      }
    };
    const prepareAppServerAttempt = (port: AppServerReplyPort): AppServerAttemptCards | undefined => {
      try {
        // A new attempt closes the previous binding and any MCP registration first.
        gen.appAttempt?.close();
        if (gen.attempt !== undefined) closeRegistration(gen.attempt);
        if (!gen.live || closing || clock.nowMono() >= gen.input.expiresAtMono || gen.input.ops.length === 0) return undefined;
        // Per-attempt G-d, immediately before the spawn (§5.5).
        let admitted = false;
        takeAdmitSlot();
        try { admitted = gen.input.admit(); takeAdmitSlot(); } finally { takeAdmitSlot(); }
        if (admitted !== true) return undefined;
        const attempt = openAppAttempt(gen, port);
        gen.appAttempt = attempt;
        counters.appAttempts++;
        return attempt;
      } catch {
        return undefined;
      }
    };
    return Object.freeze({ serverId: gen.serverId, generation: gen.input.ctx.turnGeneration, prepareAttempt, prepareAppServerAttempt });
  }

  const host: ToolHost & { revokeAll(): void } = {
    kind: "tool_host",

    openGeneration(input) {
      try {
        if (closing || !ledgerRecovered(store)) return undefined;
        const ctx = input.ctx;
        const serverId = ctx.injectedServerId;
        if (typeof serverId !== "string" || !SERVER_ID.test(serverId) || !serverId.startsWith(SERVER_ID_PREFIX)) return undefined;
        if (!Number.isFinite(input.expiresAtMono) || input.expiresAtMono <= clock.nowMono()) return undefined;
        if (input.binding.generation !== ctx.turnGeneration) return undefined;
        // One immutable offer drives app-server discovery/dispatch and MCP
        // redemption/configuration. Registration alone never grants an op.
        const ops = Object.freeze((["display", "interactive"] as const)
          .filter((op) => input.ops.includes(op)));
        input = Object.freeze({ ...input, ops });
        const tuple = canonicalJson({
          runtimeIncarnation: ctx.runtimeIncarnation, botRef: { originKey: ctx.botRef.originKey, credentialRef: ctx.botRef.credentialRef },
          turnGeneration: ctx.turnGeneration, injectedServerId: serverId, resetEpoch: ctx.resetEpoch,
          policyIdentity: ctx.policyIdentity, contextRef: contextRef(ctx),
        });
        const registered = store.registerHandler({
          generation: ctx.turnGeneration, installationRef: options.installationRef, sessionKey: ctx.sessionKey,
          runtimeIncarnation: ctx.runtimeIncarnation, resetEpoch: ctx.resetEpoch,
          // The monotonic clock is fractional (`performance.now()`); the durable expiry is whole milliseconds.
          expiresAt: Math.floor(wall.nowUtcMs() + Math.max(0, input.expiresAtMono - clock.nowMono())),
          contextDigest: digest(tuple), policyIdentity: ctx.policyIdentity,
        });
        // A duplicate identity or failed registration disables injection.
        if (registered.kind !== "registered") return undefined;
        const gen: Generation = { input, serverId, live: true, attempt: undefined, appAttempt: undefined, inflight: new Map(), requests: new Set() };
        generations.add(gen);
        const launch = makeLaunch(gen);
        return Object.freeze({
          launch,
          get live() { return gen.live; },
          close(): void { closeGeneration(gen); },
        });
      } catch {
        return undefined;
      }
    },

    stats() {
      let listeners = 0;
      for (const r of registrations) if (r.server.listening) listeners++;
      return Object.freeze({ ...counters, liveRegistrations: registrations.size, liveListeners: listeners });
    },

    revokeAll() {
      for (const reg of [...registrations]) revokeRegistration(reg);
      for (const gen of [...generations]) gen.appAttempt?.close();
    },

    close(): void {
      if (closing) return;
      closing = true;
      liveHosts.delete(host);
      for (const gen of [...generations]) closeGeneration(gen);
      for (const reg of [...registrations]) closeRegistration(reg);
    },

    async drain(f: ShutdownFence): Promise<ResourceDrainReport> {
      const pending = [...work];
      if (pending.length === 0) {
        try { rmSync(bootstrapRoot, { recursive: true, force: true }); } catch { /* swept at startup */ }
        return Object.freeze({ settled: 0, aborted: 0, unresolved: 0 });
      }
      let handle: unknown;
      const deadline = new Promise<"deadline">((resolve) => {
        handle = timers.setTimeout(() => resolve("deadline"), Math.max(0, f.deadlineMono - clock.nowMono()));
        f.signal.addEventListener("abort", () => resolve("deadline"), { once: true });
      });
      const first = await Promise.race([Promise.all(pending).then(() => "settled" as const), deadline]);
      timers.clearTimeout(handle);
      let unresolved = 0;
      if (first !== "settled") {
        // Past the shared deadline: retained, never refunded or resubmitted.
        for (const req of open) {
          if (req.finished) continue;
          unresolved++;
          if (req.reserved) finish(req.gen, req.requestId, "ambiguous", SEND_UNCONFIRMED, { kind: "ambiguous" }, req.settledBy);
          else finish(req.gen, req.requestId, "cancelled", AUTHORITY_CLOSED, undefined, req.settledBy);
          req.finished = true;
        }
      }
      try { rmSync(bootstrapRoot, { recursive: true, force: true }); } catch { /* swept at startup */ }
      const left = pending.filter((p) => work.has(p)).length;
      return Object.freeze({ settled: pending.length - left, aborted: 0, unresolved: Math.max(unresolved, left) });
    },
  };
  liveHosts.add(host);
  return host;
}
