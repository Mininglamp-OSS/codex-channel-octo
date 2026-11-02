/**
 * Inbound route facts for the explicit-card G-e gate (WP-09 RC-1).
 *
 * `deriveRouteFacts` turns three adapter-owned inputs into the `obo` and
 * `docTask` facts of `CardTurnInput`. It only supplies facts; every other
 * runtime gate (policy, transport, deadline, reset epoch, cwd, binding) still
 * decides whether anything is offered.
 *
 * - `origin`: the frozen {@link WS_IM_ORIGIN} token, minted only by the WS IM
 *   handler in `index.ts`. It is compared by identity, so a string, a copy or a
 *   payload field claiming the same origin is not the origin.
 * - `payload`: only its TOP-LEVEL keys are read. Any server-reserved OBO key
 *   (`__obo_*`, any `obo_*`, `actual_sender_uid`) marks a known OBO delivery.
 *   This is a superset of octo-server's `obopayload.IsReservedKey`, so a forged
 *   key can only suppress an offer.
 * - `outboundIdentity`: `'self'` only when the merged per-Bot `Config` holds no
 *   OBO send configuration ({@link deriveOutboundIdentity}).
 *
 * | fact      | value       | when                                                       |
 * |-----------|-------------|------------------------------------------------------------|
 * | `obo`     | `true`      | a top-level reserved OBO key                               |
 * | `obo`     | `false`     | WS IM origin, `'self'` identity and no reserved key        |
 * | `obo`     | `undefined` | anything else (config OBO, no/forged origin, odd payload)  |
 * | `docTask` | `false`     | WS IM origin: doc and task work arrives only as typed events, never as a turn |
 * | `docTask` | `undefined` | anything else                                              |
 *
 * The reserved-key and OBO-config-key names live only in this module.
 */

const ORIGIN_BRAND: unique symbol = Symbol("inbound-route-facts.origin");

/** An adapter-owned inbound origin; only {@link WS_IM_ORIGIN} exists. */
export interface InboundOrigin {
  readonly [ORIGIN_BRAND]: true;
  readonly kind: "ws_im";
}

/** The WS IM handler's origin token. Only `index.ts` imports it. */
export const WS_IM_ORIGIN: InboundOrigin = Object.freeze({ [ORIGIN_BRAND]: true as const, kind: "ws_im" as const });

/** The Bot's own send identity: `'self'`, or `'unknown'` when any OBO send configuration may exist. */
export type OutboundIdentity = "self" | "unknown";

export interface RouteFacts {
  readonly obo: boolean | undefined;
  readonly docTask: boolean | undefined;
}

export interface RouteFactsInput {
  readonly origin?: InboundOrigin;
  readonly payload: unknown;
  readonly outboundIdentity: OutboundIdentity;
}

/** Prefix of octo-server's server-only marker namespace (`obopayload.ReservedKeyPrefix`). */
const RESERVED_MARKER_PREFIX = "__obo_";
/** Prefix of the fan-out routing keys (`obopayload.ExplicitReservedKeys`); every `obo_*` key is treated as reserved. */
const RESERVED_ROUTING_PREFIX = "obo_";
/** Prefix-less reserved key set by octo-server's OBO send path. */
const RESERVED_SENDER_KEY = "actual_sender_uid";

/** Per-Bot config keys that configure sending on behalf of a human. */
const OBO_CONFIG_KEYS: readonly string[] = Object.freeze(["onBehalfOf", "on_behalf_of"]);
const OBO_CONFIG_KEY_NORMALIZED = new Set(OBO_CONFIG_KEYS.map(normalizeConfigKey));

/** Config scan bounds; reaching either yields `'unknown'`. */
const MAX_CONFIG_DEPTH = 64;
const MAX_CONFIG_NODES = 50_000;

/** Suppression only: no source key, value, credential or sending authority. */
const CONFIG_SUPPRESSED: unique symbol = Symbol("inbound-route-facts.config-suppressed");

function isReservedKey(key: string): boolean {
  return key.startsWith(RESERVED_MARKER_PREFIX) || key.startsWith(RESERVED_ROUTING_PREFIX) || key === RESERVED_SENDER_KEY;
}

function normalizeConfigKey(key: string): string {
  return key.replace(/[_-]/g, "").toLowerCase();
}

/** True with a reserved top-level key, false without one, undefined when the payload cannot be inspected. */
function hasReservedTopLevelKey(payload: unknown): boolean | undefined {
  if (payload === null || typeof payload !== "object") return undefined;
  try {
    return Object.keys(payload).some(isReservedKey);
  } catch {
    return undefined;
  }
}

function isWsImOrigin(origin: unknown): boolean {
  return origin === WS_IM_ORIGIN && (origin as InboundOrigin)[ORIGIN_BRAND] === true;
}

/** Pure; never throws. */
export function deriveRouteFacts(input: RouteFactsInput): RouteFacts {
  const ws = isWsImOrigin(input.origin);
  const reserved = hasReservedTopLevelKey(input.payload);
  const obo = reserved === true ? true
    : ws && reserved === false && input.outboundIdentity === "self" ? false
      : undefined;
  return Object.freeze({ obo, docTask: ws ? false : undefined });
}

/**
 * `'self'` only when a full scan of the merged per-Bot `Config` finds no OBO
 * config key at any depth, including inside arrays. A hit, a value that
 * cannot be inspected without running code (accessor, proxy trap, function,
 * non-plain object) or a scan past its depth or size bound is `'unknown'`.
 * Cycle-safe and iterative; never throws.
 */
export function deriveOutboundIdentity(config: unknown): OutboundIdentity {
  if (config === null || typeof config !== "object" || Array.isArray(config)) return "unknown";
  try {
    return scanConfig(config) ? "self" : "unknown";
  } catch {
    return "unknown";
  }
}

/**
 * Preserve unknown identity BEFORE a configuration projection drops raw keys.
 * Shared layers own everything except the root `bots` registry; each entry
 * is scanned separately as a selected layer, never as a sibling's source.
 * Each explicit merge must carry this bit from its sources. It is immutable
 * and non-enumerable, carries no configuration values, and is invisible to
 * JSON/log projections. The pure scanner treats every symbol key as unknown.
 */
export function preserveConfigSuppression<T extends object>(target: T, scope: "shared" | "selected", ...sources: readonly unknown[]): T {
  const identity = scope === "shared" ? deriveSharedIdentity : deriveOutboundIdentity;
  if (identity(target) === "unknown" || sources.some((source) => identity(source) === "unknown")) {
    Object.defineProperty(target, CONFIG_SUPPRESSED, { value: true });
  }
  return target;
}

/** A shared source excludes only its root Bot registry, without invoking accessors. */
function deriveSharedIdentity(config: unknown): OutboundIdentity {
  if (config === null || typeof config !== "object" || Array.isArray(config)) return "unknown";
  try {
    const descriptors = Object.getOwnPropertyDescriptors(config);
    if (Object.hasOwn(descriptors, "bots") && !("value" in descriptors.bots)) return "unknown";
    delete descriptors.bots;
    // Preserve prototype, symbols and every other descriptor: a genuine
    // shared suppression bit or uninspectable setting must still fail closed.
    return deriveOutboundIdentity(Object.create(Object.getPrototypeOf(config), descriptors));
  } catch {
    return "unknown";
  }
}

function scanConfig(root: object): boolean {
  const seen = new WeakSet<object>();
  const stack: Array<{ readonly value: object; readonly depth: number }> = [{ value: root, depth: 0 }];
  let nodes = 0;
  while (stack.length > 0) {
    const { value, depth } = stack.pop()!;
    if (seen.has(value)) continue;
    seen.add(value);
    if (depth > MAX_CONFIG_DEPTH || ++nodes > MAX_CONFIG_NODES) return false;
    const proto = Object.getPrototypeOf(value);
    const isArray = Array.isArray(value);
    if (!isArray && proto !== Object.prototype && proto !== null) return false;
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key === "symbol") return false;
      if (isArray && key === "length") continue;
      if (OBO_CONFIG_KEY_NORMALIZED.has(normalizeConfigKey(key))) return false;
      const desc = Object.getOwnPropertyDescriptor(value, key);
      if (desc === undefined || !("value" in desc)) return false;
      const child: unknown = desc.value;
      if (typeof child === "function") return false;
      if (child !== null && typeof child === "object") stack.push({ value: child, depth: depth + 1 });
    }
  }
  return true;
}
