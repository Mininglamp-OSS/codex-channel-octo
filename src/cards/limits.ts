/** Pure conservative bounds. No serialization calls untrusted getters/toJSON. */
import type { Limits } from "./contracts.js";

export const CARD_BOUNDS = Object.freeze({ sourceBlocks: 200, nodes: 200, depth: 12,
  buttons: 6, inputs: 5, sectionOptions: 20, payloadBytes: 16384,
  inputTextBytes: 4096, inputsBytes: 16384, summaryScalars: 280, turnSummaryScalars: 6000 });
const DEFAULTS: Limits = Object.freeze({ maxNodes: 200, maxDepth: 12, maxPayloadBytes: 16384,
  maxInputTextBytes: 4096, maxInputsBytes: 16384 });
const LIMIT_FIELDS = { max_nodes: "maxNodes", max_depth: "maxDepth", max_payload_bytes: "maxPayloadBytes",
  max_input_text_bytes: "maxInputTextBytes", max_inputs_bytes: "maxInputsBytes" } as const;
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u;

export function withinCount(count: number, cap: number): boolean {
  return Number.isSafeInteger(count) && count >= 0 && Number.isSafeInteger(cap) && cap >= 0 && count <= cap;
}
export function withinUtf8(text: string, cap: number): boolean {
  return typeof text === "string" && !LONE_SURROGATE.test(text) && withinCount(Buffer.byteLength(text, "utf8"), cap);
}
export function withinScalars(text: string, cap: number): boolean {
  if (typeof text !== "string" || LONE_SURROGATE.test(text) || !withinCount(0, cap)) return false;
  let count = 0;
  for (const scalar of text) { if (scalar.length > 0 && ++count > cap) return false; }
  return true;
}

/** Plain data records only, including the null-prototype WP-01 JSON projection. */
export function closedRecord(value: unknown, keys?: readonly string[]): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const proto: unknown = Object.getPrototypeOf(value);
  if (proto !== null && proto !== Object.prototype) return false;
  const own = Reflect.ownKeys(value);
  if (own.length > 256) return false;
  return own.every(key => typeof key === "string" && (!keys || keys.includes(key))
    && Object.getOwnPropertyDescriptor(value, key)?.enumerable === true
    && "value" in Object.getOwnPropertyDescriptor(value, key)!);
}
export function profileString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.trim() === value
    && withinUtf8(value, 128) && !/[\u0000-\u001f\u007f-\u009f]/u.test(value);
}
export function stringList(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.length <= 256 && value.every(profileString)
    && new Set(value).size === value.length;
}

export interface NormalizedLimits {
  readonly limits: Limits;
  readonly valid: boolean;
  readonly payloadValid: boolean;
  readonly layoutValid: boolean;
  readonly inputsValid: boolean;
}
export function normalizeLimits(server: unknown): NormalizedLimits {
  const limits = { ...DEFAULTS };
  let payloadValid = true, layoutValid = true, inputsValid = true;
  if (server !== undefined) {
    if (!closedRecord(server, Object.keys(LIMIT_FIELDS))) {
      payloadValid = layoutValid = inputsValid = false;
    } else {
      for (const [key, field] of Object.entries(LIMIT_FIELDS)) {
        const value = server[key];
        if (value === undefined) continue;
        if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
          if (field === "maxPayloadBytes") payloadValid = false;
          else if (field === "maxNodes" || field === "maxDepth") layoutValid = false;
          else inputsValid = false;
        } else limits[field] = Math.min(value, DEFAULTS[field]);
      }
    }
  }
  return Object.freeze({ limits: Object.freeze(limits), valid: payloadValid && layoutValid && inputsValid,
    payloadValid, layoutValid, inputsValid });
}

/** Both arguments are normalized limits. Revalidate to fail closed on forged callers. */
export function effectiveLimits(server: Limits, pinned?: Limits): Limits {
  const fields = Object.values(LIMIT_FIELDS);
  if (!closedRecord(server, fields) || Object.keys(server).length !== fields.length
    || (pinned !== undefined && (!closedRecord(pinned, fields) || Object.keys(pinned).length !== fields.length))) {
    throw new Error("invalid_card_limits");
  }
  const out = { ...DEFAULTS };
  for (const field of Object.values(LIMIT_FIELDS)) {
    const current = server[field], previous = pinned?.[field] ?? DEFAULTS[field];
    if (!Number.isSafeInteger(current) || current <= 0 || !Number.isSafeInteger(previous) || previous <= 0) {
      throw new Error("invalid_card_limits");
    }
    out[field] = Math.min(DEFAULTS[field], current, previous);
  }
  return Object.freeze(out);
}

/** Bounded data walk; undefined is permitted only for absent optional profile fields. */
export function measureStructure(value: unknown, allowUndefined = false): Readonly<{ nodes: number; depth: number }> | undefined {
  let nodes = 0, depth = 0, visited = 0, bytes = 0;
  const ancestors = new Set<object>();
  function walk(v: unknown, level: number): boolean {
    if (++visited > 10000 || level > 16) return false;
    if (v === undefined) return allowUndefined;
    if (v === null || typeof v === "boolean") return true;
    if (typeof v === "number") return allowUndefined || Number.isFinite(v);
    if (typeof v === "string") {
      bytes += Buffer.byteLength(v, "utf8");
      return bytes <= 65536 && withinUtf8(v, 65536);
    }
    if (typeof v !== "object" || ancestors.has(v)) return false;
    nodes++; depth = Math.max(depth, level);
    ancestors.add(v);
    let values: unknown[];
    if (Array.isArray(v)) {
      if (Object.getPrototypeOf(v) !== Array.prototype || v.length > 10000
        || Reflect.ownKeys(v).length !== v.length + 1) return false;
      values = [];
      for (let i = 0; i < v.length; i++) {
        const d = Object.getOwnPropertyDescriptor(v, String(i));
        if (!d || !("value" in d) || !d.enumerable) return false;
        values.push(d.value);
      }
    } else {
      if (!closedRecord(v)) return false;
      values = Object.values(v);
    }
    const ok = values.every(child => walk(child, level + 1));
    ancestors.delete(v);
    return ok;
  }
  try { return walk(value, 1) ? Object.freeze({ nodes, depth }) : undefined; }
  catch { return undefined; }
}
export function measureEnvelope(value: unknown): number | undefined {
  if (measureStructure(value) === undefined) return undefined;
  try {
    const serialized = JSON.stringify(value);
    return serialized === undefined ? undefined : Buffer.byteLength(serialized, "utf8");
  } catch { return undefined; }
}
