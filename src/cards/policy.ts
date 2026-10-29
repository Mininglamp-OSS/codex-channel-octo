/** Per-runtime, per-Bot policy authority. No shared cache and no write/event wiring. */
import { createHash } from "node:crypto";
import type { CardApi } from "./api.js";
import { classifyProfileFailure, OctoApiError } from "./api.js";
import type { BotRef, MonotonicClock, PolicySnapshot, SafeReasonCode, TrustedTurnContext } from "./contracts.js";
import { negotiate, type LocalNarrowing } from "./caps.js";
import { disabledProfile, parseProfile, type NormalizedProfile } from "./profile-parse.js";
import { effectiveLimits } from "./limits.js";

export type PolicyOperation = "automatic" | "display" | "interaction";
export interface PolicyOptions {
  readonly botRef: BotRef;
  readonly api: Pick<CardApi, "origin" | "getProfile">;
  readonly clock: MonotonicClock;
  readonly ttlMs?: number;
  /** Already validated trusted preferences; parsed by a later configuration package. */
  readonly localNarrowing?: LocalNarrowing;
}
export type Authorization =
  | Readonly<{ allowed: false; reason: SafeReasonCode }>
  | Readonly<{ allowed: true; snapshot: PolicySnapshot; limits: ReturnType<typeof effectiveLimits> }>;
export interface CardPolicy {
  snapshot(): Promise<PolicySnapshot>;
  invalidate(scope: string): number;
  /** Synchronous authority check immediately before a later consumer's operation. */
  authorize(op: PolicyOperation, ctx: Pick<TrustedTurnContext, "botRef">, pinned?: PolicySnapshot): Authorization;
  /** Classification only: never authorizes a send/edit or API neutralization. */
  closureDisposition(op: PolicyOperation, pinned: PolicySnapshot, current: PolicySnapshot): "denied" | "expired_closure_only";
}
type Epochs = Record<PolicyOperation, number>;
interface Issuance { readonly generation: number; readonly epochs: Epochs }
interface Flight { readonly generation: number; readonly promise: Promise<PolicySnapshot> }

function sameBot(a: BotRef, b: BotRef): boolean {
  return a.originKey === b.originKey && a.credentialRef === b.credentialRef;
}
function fingerprint(p: NormalizedProfile): string {
  // Hash normalized allowlisted facts only. No raw profile or compatibility extensions.
  return createHash("sha256").update(JSON.stringify({ automatic: p.automatic,
    display: { ...p.display, elements: [...p.display.elements].sort(), actions: [...p.display.actions].sort() },
    interaction: { ...p.interaction, inputs: [...p.interaction.inputs].sort() }, reasons: p.reasons })).digest("hex");
}
function resolvedFailure(error: unknown): NormalizedProfile | undefined {
  if (!(error instanceof OctoApiError) || error.operation !== "get_profile") return undefined;
  const failure = classifyProfileFailure(error);
  if (failure.category === "unavailable") return undefined;
  return disabledProfile(failure.reason === "profile_404" ? "profile_404" : failure.reason === "auth" ? "auth_rejected"
    : error.code === "malformed_config" ? "config_inconsistent" : "profile_malformed");
}

export function createPolicy(options: PolicyOptions): CardPolicy {
  const ttl = options.ttlMs ?? 60000;
  const ref = options.botRef;
  if (!ref || typeof ref.credentialRef !== "string" || ref.credentialRef.length === 0 || ref.credentialRef.length > 256
    || !/^[A-Za-z0-9_-]+$/.test(ref.credentialRef) || ref.originKey !== options.api.origin.key
    || !Number.isSafeInteger(ttl) || ttl < 1 || ttl > 60000) throw new Error("invalid_card_policy_binding");
  const botRef: BotRef = Object.freeze({ originKey: ref.originKey, credentialRef: ref.credentialRef });
  const api = options.api, clock = options.clock;
  const local = Object.freeze({ ...options.localNarrowing });
  let generation = 0;
  let highWater = -1;
  let cached: PolicySnapshot | undefined;
  let lastResolved: PolicySnapshot | undefined;
  let flight: Flight | undefined;
  const epochs: Epochs = { automatic: 0, display: 0, interaction: 0 };
  const issued = new WeakMap<PolicySnapshot, Issuance>();

  function now(): number | undefined {
    let value: number;
    try { value = clock.nowMono(); } catch { return undefined; }
    if (!Number.isFinite(value) || value < 0 || value > Number.MAX_SAFE_INTEGER - 60000 || value < highWater) return undefined;
    highWater = value;
    return value;
  }
  function make(profile: NormalizedProfile, gen: number, at: number, expiry: number): PolicySnapshot {
    const snapshot: PolicySnapshot = Object.freeze({ botRef, generation: gen, fetchedAtMono: at,
      expiresAtMono: expiry, profileHash: fingerprint(profile), ...profile });
    issued.set(snapshot, { generation: gen, epochs: { ...epochs } });
    return snapshot;
  }
  function unavailable(gen: number, at: number): PolicySnapshot {
    return make(disabledProfile("profile_unavailable", "unavailable"), gen, at, at);
  }
  function fresh(p: PolicySnapshot, at: number): boolean {
    return p.generation === generation && at >= p.fetchedAtMono && at < p.expiresAtMono;
  }
  function owned(p: PolicySnapshot, op: PolicyOperation): boolean {
    const record = issued.get(p);
    return record !== undefined && record.generation === generation && record.epochs[op] === epochs[op];
  }

  async function fetchSnapshot(gen: number, at: number): Promise<PolicySnapshot> {
    let normalized: NormalizedProfile;
    let resolved = true;
    try { normalized = negotiate(parseProfile(await api.getProfile()), local); }
    catch (error) {
      const denied = resolvedFailure(error);
      resolved = denied !== undefined;
      normalized = denied ?? disabledProfile("profile_unavailable", "unavailable");
    }
    const end = now();
    if (generation !== gen || end === undefined || end >= at + ttl) return unavailable(gen, at);
    if (resolved) {
      for (const op of ["automatic", "display", "interaction"] as const) {
        if (normalized[op].state !== "enabled") epochs[op]++;
      }
    }
    const snapshot = make(normalized, gen, at, resolved ? at + ttl : at);
    if (resolved) { cached = snapshot; lastResolved = snapshot; }
    return snapshot;
  }

  const policy: CardPolicy = {
    snapshot(): Promise<PolicySnapshot> {
      const at = now();
      if (at === undefined) return Promise.resolve(unavailable(generation, Math.max(0, highWater)));
      if (cached && fresh(cached, at)) return Promise.resolve(cached);
      if (flight?.generation === generation) return flight.promise;
      const gen = generation;
      const promise = fetchSnapshot(gen, at);
      const record: Flight = { generation: gen, promise };
      flight = record;
      // Identity comparison is essential: old completion cannot clear a newer flight.
      void promise.then(() => { if (flight === record) flight = undefined; }, () => { if (flight === record) flight = undefined; });
      return promise;
    },
    invalidate(scope: string): number {
      if (scope !== "bot_setting") return generation;
      if (generation === Number.MAX_SAFE_INTEGER) throw new Error("card_policy_generation_exhausted");
      generation++;
      cached = lastResolved = undefined;
      flight = undefined;
      return generation;
    },
    authorize(op, ctx, pinned): Authorization {
      const at = now();
      if (!sameBot(ctx.botRef, botRef) || at === undefined || !cached || !fresh(cached, at)
        || cached[op].state !== "enabled" || (pinned && (!owned(pinned, op) || pinned[op].state !== "enabled"))) {
        return Object.freeze({ allowed: false, reason: "policy_revoked" });
      }
      if (op === "automatic" && pinned && (cached.automatic.template?.id !== pinned.automatic.template?.id
        || cached.automatic.template?.version !== pinned.automatic.template?.version)) {
        return Object.freeze({ allowed: false, reason: "template_incompatible" });
      }
      const currentLimits = op === "automatic" ? { ...cached.display.limits, maxPayloadBytes: cached.automatic.maxPayloadBytes } : cached[op].limits;
      const previousLimits = !pinned ? undefined : op === "automatic"
        ? { ...pinned.display.limits, maxPayloadBytes: pinned.automatic.maxPayloadBytes } : pinned[op].limits;
      return Object.freeze({ allowed: true, snapshot: cached, limits: effectiveLimits(currentLimits, previousLimits) });
    },
    closureDisposition(op, pinned, current) {
      const at = now();
      if (at === undefined || !owned(pinned, op) || !owned(current, op) || lastResolved !== pinned
        || pinned[op].state !== "enabled" || current[op].state !== "unavailable" || at < pinned.expiresAtMono) return "denied";
      return "expired_closure_only";
    },
  };
  return Object.freeze(policy);
}
