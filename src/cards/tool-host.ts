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
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
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
import { ledgerRecovered } from "./recovery.js";
import { EXPLICIT_BUDGET_EXHAUSTED, type CardBinding, type CardStore, type ExplicitCard, type ExplicitFinish, type FinishExplicitInput } from "./store.js";

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

/** WP-08: frozen EMPTY. WP-09 adds the display handler only. */
export const PRODUCTION_EXPLICIT_OPS: ExplicitOpTable = Object.freeze(new Map<ToolOpcode, ExplicitOpHandler>());

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

// ─── gateway-wide discovery gate G-d (§6) ───────────────────────────────────

/** One running Bot's model-command exposure, as resolved from its startup config. */
export interface GatewayExposureEntry {
  /** Raw `sdk.sandboxMode`; `danger-full-access` disables injection gateway-wide. */
  readonly sandboxMode: string | undefined;
  /** Effective CODEX_HOME of the Bot's Codex runs; undefined fails closed. */
  readonly codexHome: string | undefined;
}

const exposures = new Map<symbol, GatewayExposureEntry>();
const liveHosts = new Set<{ revokeAll(): void }>();

/** Managed/system configuration layers; any presence disables injection. */
const SYSTEM_LAYERS: readonly string[] = Object.freeze([
  "/etc/codex",
  "/Library/Managed Preferences/com.openai.codex.plist",
]);

/** CODEX_HOME entries that add hooks, managed layers or plugins; any presence disables injection. */
const CODEX_HOME_DENIED: readonly string[] = Object.freeze([
  "managed_config.toml", "requirements.toml", "hooks.json", "hooks", "plugins",
]);

/** Closed allowlist of top-level `config.toml` keys that add no model-command path. */
const ADMITTED_TOP_KEYS: ReadonlySet<string> = new Set([
  "model", "model_provider", "model_reasoning_effort", "model_reasoning_summary", "model_verbosity",
  "model_context_window", "model_max_output_tokens", "preferred_auth_method", "forced_login_method",
  "cli_auth_credentials_store", "hide_agent_reasoning", "show_raw_agent_reasoning",
  "disable_response_storage", "project_doc_max_bytes", "file_opener",
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
 * the allowlist and `[model_providers.<bare id>]` tables of scalar keys, with
 * basic/literal strings, integers or booleans. Anything else — another
 * `mcp_servers` entry, `notify`, hooks, profiles, plugins, connectors, arrays,
 * inline tables, dotted keys, multi-line strings — is not admitted.
 */
export function admitsCodexConfigToml(text: string): boolean {
  let table: "top" | "provider" = "top";
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/^[ \t]+|[ \t]+$/g, "");
    if (line === "" || line.startsWith("#")) continue;
    const header = /^\[([A-Za-z0-9_.-]+)\]$/.exec(line);
    if (header !== null) {
      const parts = (header[1] as string).split(".");
      if (parts.length !== 2 || parts[0] !== "model_providers" || !BARE_KEY.test(parts[1] as string)) return false;
      table = "provider";
      continue;
    }
    const kv = /^([A-Za-z0-9_-]+)[ \t]*=[ \t]*(.+?)(?:[ \t]+#.*)?$/.exec(line);
    if (kv === null) return false;
    const key = kv[1] as string;
    const value = kv[2] as string;
    if (!SCALAR.test(value)) return false;
    if (table === "top" ? !ADMITTED_TOP_KEYS.has(key) : !ADMITTED_PROVIDER_KEYS.has(key)) return false;
  }
  return true;
}

function admitsCodexHome(home: string | undefined): boolean {
  if (typeof home !== "string" || !isAbsolute(home)) return false;
  try {
    for (const name of CODEX_HOME_DENIED) if (existsSync(join(home, name))) return false;
    const configPath = join(home, "config.toml");
    let st;
    try { st = lstatSync(configPath); } catch (err) { return (err as NodeJS.ErrnoException).code === "ENOENT"; }
    if (!st.isFile() || st.size > 65_536) return false;
    return admitsCodexConfigToml(readFileSync(configPath, "utf8"));
  } catch {
    return false;
  }
}

/** True when any ancestor of `cwd` (inclusive) carries a project `.codex` layer, or on any doubt. */
function projectLayerPresent(cwd: string): boolean {
  try {
    let dir = realpathSync(cwd);
    for (;;) {
      if (existsSync(join(dir, ".codex"))) return true;
      const parent = dirname(dir);
      if (parent === dir) return false;
      dir = parent;
    }
  } catch {
    return true;
  }
}

/**
 * G-d, evaluated against every running Bot's exposure at every attempt:
 * injection only when no Bot is danger-full-access, every Bot's CODEX_HOME
 * admits nothing but the injected server, no managed/system layer exists and
 * the session cwd has no project `.codex` layer. Unknown ⇒ off.
 */
export function gatewayAdmitsInjection(sessionCwd: string | undefined): boolean {
  try {
    if (exposures.size === 0 || typeof sessionCwd !== "string" || !isAbsolute(sessionCwd)) return false;
    for (const e of exposures.values()) {
      if (e.sandboxMode === "danger-full-access" || !admitsCodexHome(e.codexHome)) return false;
    }
    for (const layer of SYSTEM_LAYERS) if (existsSync(layer)) return false;
    return !projectLayerPresent(sessionCwd);
  } catch {
    return false;
  }
}

/**
 * Record one running Bot's exposure. A registration that newly fails G-d
 * closes every live attempt registration of every host (case-3 close).
 */
export function registerGatewayExposure(entry: GatewayExposureEntry): () => void {
  const key = Symbol("bot");
  exposures.set(key, Object.freeze({ sandboxMode: entry.sandboxMode, codexHome: entry.codexHome }));
  let unsafe = entry.sandboxMode === "danger-full-access";
  if (!unsafe) { try { unsafe = !admitsCodexHome(entry.codexHome); } catch { unsafe = true; } }
  if (unsafe) for (const host of [...liveHosts]) { try { host.revokeAll(); } catch { /* fenced per registration */ } }
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
  readonly policy?: Pick<CardPolicy, "authorize">;
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
  /** Per-attempt gates (G-d and runtime liveness); false ⇒ no injection for the attempt. */
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
  readonly authRejected: number;
  readonly frameRejected: number;
  readonly liveRegistrations: number;
  readonly liveListeners: number;
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
  ttlTimer: unknown;
  expiryTimer: unknown;
  port: number;
}

interface RequestState {
  readonly reg: Registration;
  readonly requestId: string;
  readonly abort: AbortController;
  reserved: boolean;
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

  const counters = { bootstrapRedeemed: 0, bootstrapReplay: 0, bootstrapExpired: 0, bootstrapUnknown: 0, authRejected: 0, frameRejected: 0 };
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
    message?: FinishExplicitInput["message"]): boolean => {
    try {
      const r = store.finishExplicitRequest({ generation: gen.input.ctx.turnGeneration, requestId, outcome,
        safeResultJson: JSON.stringify(result), ...(message !== undefined ? { message } : {}) });
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
    const req: RequestState = { reg, requestId, abort: new AbortController(), reserved: false, finished: false, result: undefined, port: undefined };
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
      if (!req.finished && finish(gen, req.requestId, outcome, result)) { req.finished = true; req.result = result; }
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
    const closedNow = req.abort.signal.aborted || !gen.live || req.reg.state !== "live";
    if (closedNow) return settle("cancelled", AUTHORITY_CLOSED);
    if (threw) return settle("failed", EXPLICIT_OP_UNAVAILABLE);
    const valid = handled !== undefined ? parseCardToolResult(JSON.parse(JSON.stringify(handled)) as JsonValue) : null;
    // A success without a reservation would be fabricated.
    return settle("failed", valid !== null && valid.status === "error" ? valid : EXPLICIT_OP_UNAVAILABLE);
  }

  async function reserveAndSend(gen: Generation, req: RequestState, op: ToolOpcode, card: ExplicitCard): Promise<CardToolResult> {
    const settled = (outcome: ExplicitFinish, result: CardToolResult, message?: FinishExplicitInput["message"]): CardToolResult => {
      if (!req.finished && finish(gen, req.requestId, outcome, result, message)) { req.finished = true; req.result = result; }
      return req.result ?? result;
    };
    // Pre-reserve: any failure here leaves the request charged for the D5 outcome.
    if (req.abort.signal.aborted || !registrationLive(req.reg)) throw new Closed();
    if (options.transport === undefined) throw new Error("explicit transport unavailable");
    if (card === null || typeof card !== "object" || card.opcode !== op || !sameBinding(card.binding, gen.input.binding)) {
      throw new Error("explicit card binding mismatch");
    }
    if (options.policy !== undefined) {
      let allowed = false;
      try { allowed = options.policy.authorize(op === "display" ? "display" : "interaction", { botRef: gen.input.ctx.botRef }).allowed; } catch { allowed = false; }
      if (!allowed) return settled("failed", POLICY_DENIED);
    }
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
    // Post-reserve: host-owned classification; any doubt is ambiguous.
    let outcome: ExplicitTransportOutcome;
    try {
      outcome = await options.transport.send({ ctx: gen.input.ctx, card, cardId: r.cardId, clientMsgNo: r.clientMsgNo, signal: req.abort.signal });
    } catch {
      outcome = { kind: "ambiguous" };
    }
    if (outcome.kind === "acked") {
      const result: CardToolResult = { status: "sent", message_id: outcome.messageId,
        route: { kind: gen.input.ctx.routeEligibility.kind, ref: r.cardId.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 64) || "card" },
        ...(r.sessionId !== null ? { session_id: r.sessionId.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 64) } : {}) };
      const valid = parseCardToolResult(result as unknown as JsonValue);
      if (valid !== null && finish(gen, req.requestId, "acked", valid,
        { kind: "ack", messageId: outcome.messageId, currentResetEpoch: gen.input.currentResetEpoch(), policyAllows: true })) {
        req.finished = true; req.result = valid;
        return valid;
      }
      return settled("ambiguous", SEND_UNCONFIRMED, { kind: "ambiguous" });
    }
    if (outcome.kind === "failed") return settled("failed", SEND_FAILED, { kind: "failed" });
    return settled("ambiguous", SEND_UNCONFIRMED, { kind: "ambiguous" });
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

  async function openRegistration(gen: Generation): Promise<Registration | undefined> {
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
        ticketDeadlineMono: now + BOOTSTRAP_TTL_MS, ttlTimer: undefined, expiryTimer: undefined, port: address.port,
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
        if (!gen.input.admit() || !entryUsable(entry)) return undefined;
        const reg = await openRegistration(gen);
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
    return Object.freeze({ serverId: gen.serverId, generation: gen.input.ctx.turnGeneration, prepareAttempt });
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
        const gen: Generation = { input, serverId, live: true, attempt: undefined, inflight: new Map(), requests: new Set() };
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
          if (req.reserved) finish(req.reg.gen, req.requestId, "ambiguous", SEND_UNCONFIRMED, { kind: "ambiguous" });
          else finish(req.reg.gen, req.requestId, "cancelled", AUTHORITY_CLOSED);
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
