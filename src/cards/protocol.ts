/**
 * Explicit-card IPC protocol between the injected MCP proxy and the parent
 * tool host (§2.4): versioned, length-prefixed UTF-8 JSON frames.
 *
 *   frame   = uint32 big-endian body length || UTF-8 JSON body
 *   request = {v:1, request_id:<128-bit hex>, authority:<≥256-bit hex>, op, args}
 *   reply   = {v:1, request_id, result:CardToolResult}
 *
 * Total frame size, including the 4-byte prefix, is capped at 32,768 bytes.
 * Accepted requests carry only the closed C.1 authoring grammar, checked
 * structurally here (exact keys, closed unions, JSON types). Authentication,
 * budgets, semantic label/ID/limit rules, redaction, policy and building
 * belong to later packages.
 * Rejections carry closed codes and content-free diagnostics: no untrusted
 * key spelling or value is echoed.
 */

import type {
  ButtonData,
  ButtonSpec,
  CardError,
  CardToolResult,
  Diag,
  DisplayBlock,
  DisplayCardArgs,
  InputSpec,
  InteractiveCardArgs,
  JsonObject,
  JsonValue,
  Option,
  RichRun,
  SafeReasonCode,
  ToolOpcode,
} from "./contracts.js";

export const PROTOCOL_VERSION = 1;
export const FRAME_PREFIX_BYTES = 4;
export const MAX_FRAME_BYTES = 32_768;
export const MAX_FRAME_BODY_BYTES = MAX_FRAME_BYTES - FRAME_PREFIX_BYTES;
export const MAX_DIAGNOSTICS = 16;
export const MAX_DIAG_PATH_BYTES = 128;
export const MAX_DIAG_RULE_BYTES = 64;

const REQUEST_ID = /^[0-9a-f]{32}$/;
const AUTHORITY = /^(?:[0-9a-f]{2}){32,64}$/;
const INT64_DECIMAL = /^(?:0|[1-9][0-9]{0,18})$/;
const INT64_MAX = 9_223_372_036_854_775_807n;

// ─── Strict bounded JSON ────────────────────────────────────────────────────

export interface StrictJsonLimits {
  readonly maxDepth: number;
  readonly maxNodes: number;
  /**
   * `reject`: integer literals that lose precision fail the parse; exactly
   * representable finite author numbers retain their numeric type.
   * `preserve`: integers outside the safe range become exact decimal strings, so identity fields
   * stay lossless and numeric fields fail their own type checks. Fraction/exponent tokens whose
   * parsed number is integer-valued but differs from the token's exact value (for example
   * `1.0000000000000001`, `9007199254740993.0` or an underflowed `-1e-400`) keep their original
   * token text, so a rounded number can never stand in for an identity, sequence or cursor.
   * Exactly integral tokens such as `1.0` or `1e0` stay numbers.
   */
  readonly unsafeIntegers: "reject" | "preserve";
}

export type JsonRejectCode =
  | "malformed_json"
  | "duplicate_key"
  | "forbidden_key"
  | "depth_exceeded"
  | "too_many_nodes"
  | "unsafe_integer"
  | "lone_surrogate";

export type StrictJsonResult =
  | { readonly ok: true; readonly value: JsonValue }
  | { readonly ok: false; readonly code: JsonRejectCode };

const FORBIDDEN_KEYS: ReadonlySet<string> = new Set(["__proto__", "constructor", "prototype"]);

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

class JsonReject {
  constructor(readonly code: JsonRejectCode) {}
}

/**
 * RFC 8259 parser that rejects duplicate keys, prototype-sensitive keys,
 * lone surrogates and excessive depth/size. Objects have a null prototype.
 */
export function parseStrictJson(text: string, limits: StrictJsonLimits): StrictJsonResult {
  let pos = 0;
  let nodes = 0;

  const fail = (code: JsonRejectCode): never => { throw new JsonReject(code); };
  const skipWs = (): void => {
    while (pos < text.length) {
      const c = text.charCodeAt(pos);
      if (c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d) pos++;
      else break;
    }
  };
  const countNode = (): void => {
    nodes++;
    if (nodes > limits.maxNodes) fail("too_many_nodes");
  };

  const parseString = (): string => {
    pos++; // opening quote
    let out = "";
    for (;;) {
      if (pos >= text.length) fail("malformed_json");
      const c = text.charCodeAt(pos);
      if (c === 0x22) { pos++; break; }
      if (c < 0x20) fail("malformed_json");
      if (c === 0x5c) {
        const e = text[pos + 1];
        pos += 2;
        switch (e) {
          case '"': out += '"'; break;
          case "\\": out += "\\"; break;
          case "/": out += "/"; break;
          case "b": out += "\b"; break;
          case "f": out += "\f"; break;
          case "n": out += "\n"; break;
          case "r": out += "\r"; break;
          case "t": out += "\t"; break;
          case "u": {
            const hex = text.slice(pos, pos + 4);
            if (!/^[0-9a-fA-F]{4}$/.test(hex)) fail("malformed_json");
            out += String.fromCharCode(parseInt(hex, 16));
            pos += 4;
            break;
          }
          default: fail("malformed_json");
        }
        continue;
      }
      out += text[pos];
      pos++;
    }
    if (LONE_SURROGATE.test(out)) fail("lone_surrogate");
    return out;
  };

  const parseNumber = (): number | string => {
    const m = /^-?(?:0|[1-9][0-9]*)(\.[0-9]+)?([eE][+-]?[0-9]+)?/.exec(text.slice(pos, pos + 400));
    if (!m) fail("malformed_json");
    const token = m![0];
    pos += token.length;
    const n = Number(token);
    if (!Number.isFinite(n)) fail("malformed_json");
    const isIntegerToken = m![1] === undefined && m![2] === undefined;
    if (isIntegerToken) {
      if (!Number.isSafeInteger(n)) {
        if (limits.unsafeIntegers === "preserve") return token;
        if (BigInt(n) !== BigInt(token)) fail("unsafe_integer");
      }
      return n;
    }
    if (limits.unsafeIntegers === "preserve" && Number.isInteger(n) && !isExactIntegralToken(token, n)) return token;
    return n;
  };

  const parseValue = (depth: number): JsonValue => {
    if (depth > limits.maxDepth) fail("depth_exceeded");
    skipWs();
    countNode();
    const c = text[pos];
    if (c === "{") {
      pos++;
      const obj: Record<string, JsonValue> = Object.create(null) as Record<string, JsonValue>;
      skipWs();
      if (text[pos] === "}") { pos++; return obj; }
      for (;;) {
        skipWs();
        if (text[pos] !== '"') fail("malformed_json");
        const key = parseString();
        if (FORBIDDEN_KEYS.has(key)) fail("forbidden_key");
        if (Object.prototype.hasOwnProperty.call(obj, key)) fail("duplicate_key");
        skipWs();
        if (text[pos] !== ":") fail("malformed_json");
        pos++;
        obj[key] = parseValue(depth + 1);
        skipWs();
        if (text[pos] === ",") { pos++; continue; }
        if (text[pos] === "}") { pos++; return obj; }
        fail("malformed_json");
      }
    }
    if (c === "[") {
      pos++;
      const arr: JsonValue[] = [];
      skipWs();
      if (text[pos] === "]") { pos++; return arr; }
      for (;;) {
        arr.push(parseValue(depth + 1));
        skipWs();
        if (text[pos] === ",") { pos++; continue; }
        if (text[pos] === "]") { pos++; return arr; }
        fail("malformed_json");
      }
    }
    if (c === '"') return parseString();
    if (c === "t" && text.startsWith("true", pos)) { pos += 4; return true; }
    if (c === "f" && text.startsWith("false", pos)) { pos += 5; return false; }
    if (c === "n" && text.startsWith("null", pos)) { pos += 4; return null; }
    if (c === "-" || (c !== undefined && c >= "0" && c <= "9")) return parseNumber();
    return fail("malformed_json");
  };

  try {
    const value = parseValue(1);
    skipWs();
    if (pos !== text.length) return { ok: false, code: "malformed_json" };
    return { ok: true, value };
  } catch (err) {
    if (err instanceof JsonReject) return { ok: false, code: err.code };
    throw err;
  }
}

// Largest digit count of the integer part of a finite double (Number.MAX_VALUE has 309).
const MAX_FINITE_INTEGER_DIGITS = 309;
// Exponent magnitudes beyond this many digits cannot yield a finite, exactly integral
// value from a token of at most a few hundred digits.
const MAX_EXPONENT_DIGITS = 6;
const NUMBER_PARTS = /^-?([0-9]+)(?:\.([0-9]+))?(?:[eE]([+-]?)([0-9]+))?$/;

/**
 * True when the fraction/exponent `token` denotes exactly the integer `n`
 * (already finite and integer-valued). The comparison is on decimal digits
 * with bounded work: no BigInt exponentiation and at most
 * MAX_FINITE_INTEGER_DIGITS characters are materialized.
 */
function isExactIntegralToken(token: string, n: number): boolean {
  const parts = NUMBER_PARTS.exec(token);
  if (!parts) return false;
  const [, intDigits, fracDigits = "", expSign, expDigitsRaw = "0"] = parts;
  const significant = `${intDigits}${fracDigits}`.replace(/^0+/, "");
  if (significant === "") return n === 0; // exact zero, e.g. 0.0 or -0e5
  const expDigits = expDigitsRaw.replace(/^0+/, "");
  // A nonzero mantissa with an enormous negative exponent is fractional; with an
  // enormous positive one it is not finite. Neither can equal `n`.
  if (expDigits.length > MAX_EXPONENT_DIGITS) return false;
  const exponent = (expSign === "-" ? -1 : 1) * Number(expDigits || "0");
  const mantissa = significant.replace(/0+$/, "");
  // value = mantissa × 10^scale
  const scale = exponent - fracDigits.length + (significant.length - mantissa.length);
  if (scale < 0) return false; // fractional value, including underflow to ±0
  if (mantissa.length + scale > MAX_FINITE_INTEGER_DIGITS) return false;
  const exact = `${mantissa}${"0".repeat(scale)}`;
  const rounded = BigInt(n);
  return (rounded < 0n ? -rounded : rounded).toString() === exact;
}

export function isJsonObject(value: JsonValue | undefined): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(obj: JsonObject, required: readonly string[], optional: readonly string[] = []): boolean {
  const keys = Object.keys(obj);
  for (const key of required) if (!Object.prototype.hasOwnProperty.call(obj, key)) return false;
  return keys.every((k) => required.includes(k) || optional.includes(k));
}

/** Unsigned decimal int64 identity, accepting a string or a safe integer. */
export function parseInt64Identity(value: JsonValue | undefined): string | null {
  let digits: string;
  if (typeof value === "string") digits = value;
  else if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) digits = String(value);
  else return null;
  if (!INT64_DECIMAL.test(digits) || BigInt(digits) > INT64_MAX) return null;
  return digits;
}

/**
 * Acknowledged message identity: a lossless unsigned int64 that is never
 * zero (zero is a cursor value, not a message).
 */
export function parseMessageIdentity(value: JsonValue | undefined): string | null {
  const id = parseInt64Identity(value);
  return id === null || id === "0" ? null : id;
}

const utf8 = new TextEncoder();
function byteLength(s: string): number {
  return utf8.encode(s).byteLength;
}

// ─── Framing ────────────────────────────────────────────────────────────────

export type FrameErrorCode = "frame_empty" | "frame_too_large";

export type FrameRead =
  | { readonly kind: "incomplete" }
  | { readonly kind: "frame"; readonly body: Uint8Array; readonly consumed: number }
  | { readonly kind: "error"; readonly code: FrameErrorCode };

/**
 * Read one frame from the head of `buffer`. Oversized or empty declared
 * lengths are rejected from the prefix alone, before buffering the body.
 */
export function readFrame(buffer: Uint8Array): FrameRead {
  if (buffer.byteLength < FRAME_PREFIX_BYTES) return { kind: "incomplete" };
  const length = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength).getUint32(0, false);
  if (length === 0) return { kind: "error", code: "frame_empty" };
  if (length > MAX_FRAME_BODY_BYTES) return { kind: "error", code: "frame_too_large" };
  const total = FRAME_PREFIX_BYTES + length;
  if (buffer.byteLength < total) return { kind: "incomplete" };
  return { kind: "frame", body: buffer.slice(FRAME_PREFIX_BYTES, total), consumed: total };
}

export class FrameEncodeError extends Error {
  readonly code: "frame_too_large" | "invalid_message";
  constructor(code: "frame_too_large" | "invalid_message") {
    super(`card protocol frame rejected: ${code}`);
    this.name = "FrameEncodeError";
    this.code = code;
  }
}

function encodeBody(json: string): Uint8Array {
  const body = utf8.encode(json);
  if (body.byteLength > MAX_FRAME_BODY_BYTES) throw new FrameEncodeError("frame_too_large");
  const frame = new Uint8Array(FRAME_PREFIX_BYTES + body.byteLength);
  new DataView(frame.buffer).setUint32(0, body.byteLength, false);
  frame.set(body, FRAME_PREFIX_BYTES);
  return frame;
}

// ─── Request frames ─────────────────────────────────────────────────────────

/** Authenticatable request header; carries no author content. */
export interface ToolRequestHeader {
  readonly v: 1;
  readonly request_id: string;
  readonly authority: string;
  readonly op: ToolOpcode;
}

/** Accepted request: the opcode selects exactly one closed authoring grammar. */
export type ToolRequestFrame =
  | (Omit<ToolRequestHeader, "op"> & { readonly op: "display"; readonly args: DisplayCardArgs })
  | (Omit<ToolRequestHeader, "op"> & { readonly op: "interactive"; readonly args: InteractiveCardArgs });

/** Framing/header failures: rejected before any authority state exists. */
export type FrameRejectCode =
  | "malformed_utf8"
  | JsonRejectCode
  | "bad_shape"
  | "bad_version"
  | "bad_request_id"
  | "bad_authority"
  | "bad_opcode"
  | "bad_args";

export type RequestParse =
  | { readonly ok: true; readonly frame: ToolRequestFrame }
  | { readonly ok: false; readonly stage: "frame"; readonly code: FrameRejectCode }
  /**
   * Well-framed request whose arguments were rejected. The tool host
   * authenticates `header` before deciding whether the outcome is charged.
   */
  | {
    readonly ok: false; readonly stage: "args"; readonly header: ToolRequestHeader;
    readonly code: Extract<CardError, "invalid_route" | "validation_failed">; readonly diagnostics: readonly Diag[];
  };

const ARGS_LIMITS: StrictJsonLimits = { maxDepth: 32, maxNodes: 4096, unsafeIntegers: "reject" };

function decodeUtf8(body: Uint8Array): string | null {
  if (body.byteLength >= 3 && body[0] === 0xef && body[1] === 0xbb && body[2] === 0xbf) return null;
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(body);
  } catch {
    return null;
  }
}

/** Parse a request body (frame prefix already removed by `readFrame`). */
export function parseRequestFrame(body: Uint8Array): RequestParse {
  const frameReject = (code: FrameRejectCode): RequestParse => ({ ok: false, stage: "frame", code });
  if (body.byteLength === 0 || body.byteLength > MAX_FRAME_BODY_BYTES) return frameReject("bad_shape");
  const text = decodeUtf8(body);
  if (text === null) return frameReject("malformed_utf8");
  const parsed = parseStrictJson(text, ARGS_LIMITS);
  if (!parsed.ok) return frameReject(parsed.code);
  const v = parsed.value;
  if (!isJsonObject(v) || !hasExactKeys(v, ["v", "request_id", "authority", "op", "args"])) {
    return frameReject("bad_shape");
  }
  const { request_id: requestId, authority, op, args } = v;
  if (v.v !== PROTOCOL_VERSION) return frameReject("bad_version");
  if (typeof requestId !== "string" || !REQUEST_ID.test(requestId)) return frameReject("bad_request_id");
  if (typeof authority !== "string" || !AUTHORITY.test(authority)) return frameReject("bad_authority");
  if (op !== "display" && op !== "interactive") return frameReject("bad_opcode");
  if (!isJsonObject(args)) return frameReject("bad_args");

  const header: ToolRequestHeader = Object.freeze({ v: 1, request_id: requestId, authority, op: op as ToolOpcode });
  const screen = screenAuthorArgs(args);
  if (!screen.ok) return { ok: false, stage: "args", header, code: screen.code, diagnostics: screen.diagnostics };

  const ctx: GrammarCtx = { diagnostics: [], buttonDataEntries: 0, buttonDataBytes: 0 };
  const accepted = op === "display" ? readDisplayArgs(args, ctx) : readInteractiveArgs(args, ctx);
  if (accepted === null || ctx.diagnostics.length > 0) {
    const diagnostics = ctx.diagnostics.length > 0 ? ctx.diagnostics : [Object.freeze({ path: "$", rule: "invalid" })];
    return { ok: false, stage: "args", header, code: "validation_failed", diagnostics: Object.freeze(diagnostics) };
  }
  const frame: ToolRequestFrame = op === "display"
    ? { v: 1, request_id: requestId, authority, op: "display", args: accepted as DisplayCardArgs }
    : { v: 1, request_id: requestId, authority, op: "interactive", args: accepted as InteractiveCardArgs };
  return { ok: true, frame: deepFreeze(frame) };
}

/** Encode a request; the result must re-parse as the same accepted frame. */
export function encodeRequestFrame(frame: ToolRequestFrame): Uint8Array {
  const encoded = encodeBody(JSON.stringify({
    v: frame.v, request_id: frame.request_id, authority: frame.authority, op: frame.op, args: frame.args,
  }));
  const reparsed = parseRequestFrame(encoded.slice(FRAME_PREFIX_BYTES));
  if (!reparsed.ok) throw new FrameEncodeError("invalid_message");
  return encoded;
}

function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

// ─── Author-argument boundary screen ────────────────────────────────────────

const ROUTING_EXACT: ReadonlySet<string> = new Set([
  "bot", "botid", "botref", "robot", "robotid", "obo", "uid", "fromuid", "touid", "groupno", "spaceid",
  "messageid", "clientmsgno", "cardseq", "origin", "host", "port", "route", "routing", "server",
  "serverid", "generation", "authority", "auth", "bearer", "jwt", "channeltype",
]);
const ROUTING_CONTAINS: readonly string[] = [
  "channel", "thread", "topic", "account", "token", "authoriz", "password", "passwd", "secret",
  "apikey", "credential", "cookie", "onbehalf", "endpoint", "apiorigin", "apiurl", "baseurl",
  "webhook", "sessionkey", "requester",
];
const HTML_KEYS: ReadonlySet<string> = new Set([
  "html", "rawhtml", "innerhtml", "outerhtml", "markup", "script", "style", "iframe", "svg",
  "onclick", "onload", "onerror", "srcdoc",
]);

const HTML_MARKUP = /<\/?[A-Za-z][A-Za-z0-9-]*(?:\s[^<>]*)?\/?>|<!--|<!\[CDATA\[|<\?[A-Za-z]|&#x?[0-9A-Fa-f]+;|javascript:/i;
const CREDENTIAL_VALUE = /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}|\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.|-----BEGIN [A-Z ]*PRIVATE KEY-----/;

// Grammar keys that may appear verbatim in diagnostic paths; any other key
// is rendered as `*` so untrusted spellings never reach diagnostics.
const PATH_SAFE_KEYS: ReadonlySet<string> = new Set([
  "title", "blocks", "kind", "text", "level", "runs", "label", "url", "items", "value", "columns",
  "headers", "rows", "expanded", "sections", "inputs", "buttons", "id", "required", "minLength",
  "maxLength", "min", "max", "timezone", "multiple", "options", "data",
]);

function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/**
 * Routing, context, credential or API-authority key (normalized spelling).
 * Shared by the protocol screen and the REST request boundary.
 */
export function isReservedAuthorKey(key: string): boolean {
  return isRoutingKey(key);
}

function isRoutingKey(key: string): boolean {
  const k = normalizeKey(key);
  return ROUTING_EXACT.has(k) || ROUTING_CONTAINS.some((part) => k.includes(part));
}

function appendPath(path: string, segment: string): string {
  const next = `${path}${segment}`;
  return byteLength(next) <= MAX_DIAG_PATH_BYTES ? next : path;
}

/** Schema field path; `key` is always a literal grammar key, never author input. */
function fieldPath(path: string, key: string): string {
  return appendPath(path, `.${key}`);
}

function keySegment(key: string): string {
  return `.${PATH_SAFE_KEYS.has(key) ? key : "*"}`;
}

type ScreenResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly code: "invalid_route" | "validation_failed"; readonly diagnostics: readonly Diag[] };

/**
 * Runs before the grammar parse. Routing, context, credential or
 * API-authority keys anywhere (including nested button data) reject as
 * `invalid_route` ahead of any other validation; HTML keys/markup and
 * credential-shaped values reject as `validation_failed`.
 */
function screenAuthorArgs(args: JsonObject): ScreenResult {
  let routingPath: string | null = null;
  const diagnostics: Diag[] = [];
  const add = (path: string, rule: string): void => {
    if (diagnostics.length < MAX_DIAGNOSTICS) diagnostics.push(Object.freeze({ path, rule }));
  };

  const walk = (value: JsonValue, path: string): void => {
    if (routingPath !== null) return;
    if (typeof value === "string") {
      if (HTML_MARKUP.test(value)) add(path, "html_markup");
      else if (CREDENTIAL_VALUE.test(value)) add(path, "credential_value");
      return;
    }
    if (Array.isArray(value)) {
      (value as readonly JsonValue[]).forEach((item, i) => walk(item, appendPath(path, `[${i}]`)));
      return;
    }
    if (isJsonObject(value)) {
      for (const key of Object.keys(value)) {
        const childPath = appendPath(path, keySegment(key));
        if (isRoutingKey(key)) { routingPath = childPath; return; }
        if (HTML_KEYS.has(normalizeKey(key))) add(childPath, "html_forbidden");
        walk(value[key], childPath);
        if (routingPath !== null) return;
      }
    }
  };

  walk(args, "$");
  if (routingPath !== null) {
    return { ok: false, code: "invalid_route", diagnostics: [Object.freeze({ path: routingPath, rule: "routing_field" })] };
  }
  return diagnostics.length === 0 ? { ok: true } : { ok: false, code: "validation_failed", diagnostics };
}

// ─── Closed structural authoring grammar (C.1) ─────────────────────────────
//
// Shape only: exact keys at every object, closed `kind` unions, JSON types and
// integer-ness. Label/ID grammar, cardinality, byte and capability rules,
// redaction and policy belong to the schema/builder packages.

/** Normative conservative bounds for button `data` (C.1). */
export const BUTTON_DATA_MAX_DEPTH = 4;
export const BUTTON_DATA_MAX_ENTRIES = 64;
export const BUTTON_DATA_MAX_BYTES = 2048;

interface GrammarCtx {
  diagnostics: Diag[];
  buttonDataEntries: number;
  buttonDataBytes: number;
}

function diag(ctx: GrammarCtx, path: string, rule: string): null {
  if (ctx.diagnostics.length < MAX_DIAGNOSTICS) ctx.diagnostics.push(Object.freeze({ path, rule }));
  return null;
}

/** Exact-key object reader; unknown keys are reported at the object path, never by name. */
function readObject(
  value: JsonValue | undefined, path: string, ctx: GrammarCtx,
  required: readonly string[], optional: readonly string[] = [],
): JsonObject | null {
  if (!isJsonObject(value)) return diag(ctx, path, "wrong_type");
  let ok = true;
  for (const key of Object.keys(value)) {
    if (!required.includes(key) && !optional.includes(key)) { diag(ctx, path, "unknown_field"); ok = false; break; }
  }
  for (const key of required) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) { diag(ctx, fieldPath(path, key), "missing_field"); ok = false; }
  }
  return ok ? value : null;
}

function readString(value: JsonValue | undefined, path: string, ctx: GrammarCtx): string | null {
  return typeof value === "string" ? value : diag(ctx, path, "wrong_type");
}

function readOptionalString(obj: JsonObject, key: string, path: string, ctx: GrammarCtx): string | undefined | null {
  return obj[key] === undefined ? undefined : readString(obj[key], fieldPath(path, key), ctx);
}

function readBoolean(value: JsonValue | undefined, path: string, ctx: GrammarCtx): boolean | null {
  return typeof value === "boolean" ? value : diag(ctx, path, "wrong_type");
}

function readNumber(value: JsonValue | undefined, path: string, ctx: GrammarCtx): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : diag(ctx, path, "wrong_type");
}

function readInteger(value: JsonValue | undefined, path: string, ctx: GrammarCtx): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) ? value : diag(ctx, path, "wrong_type");
}

function readArray<T>(
  value: JsonValue | undefined, path: string, ctx: GrammarCtx,
  item: (v: JsonValue, p: string) => T | null,
): T[] | null {
  if (!Array.isArray(value)) return diag(ctx, path, "wrong_type");
  const out: T[] = [];
  let ok = true;
  (value as readonly JsonValue[]).forEach((v, i) => {
    const parsed = item(v, appendPath(path, `[${i}]`));
    if (parsed === null) ok = false;
    else out.push(parsed);
  });
  return ok ? out : null;
}

/** Drop `undefined` optionals so accepted objects contain only present keys. */
function compact<T extends object>(obj: T): T {
  for (const key of Object.keys(obj) as (keyof T)[]) if (obj[key] === undefined) delete obj[key];
  return obj;
}

function readRichRun(value: JsonValue, path: string, ctx: GrammarCtx): RichRun | null {
  if (!isJsonObject(value)) return diag(ctx, path, "wrong_type");
  switch (value.kind) {
    case "text": case "emphasis": case "strong": case "code": {
      const o = readObject(value, path, ctx, ["kind", "text"]);
      const text = o ? readString(o.text, fieldPath(path, "text"), ctx) : null;
      return o && text !== null ? { kind: value.kind, text } : null;
    }
    case "link": {
      const o = readObject(value, path, ctx, ["kind", "label", "url"]);
      if (!o) return null;
      const label = readString(o.label, fieldPath(path, "label"), ctx);
      const url = readString(o.url, fieldPath(path, "url"), ctx);
      return label !== null && url !== null ? { kind: "link", label, url } : null;
    }
    default:
      return diag(ctx, fieldPath(path, "kind"), "unknown_kind");
  }
}

function readBlocks(value: JsonValue | undefined, path: string, ctx: GrammarCtx): DisplayBlock[] | null {
  return readArray(value, path, ctx, (v, p) => readDisplayBlock(v, p, ctx));
}

function readDisplayBlock(value: JsonValue, path: string, ctx: GrammarCtx): DisplayBlock | null {
  if (!isJsonObject(value)) return diag(ctx, path, "wrong_type");
  const at = (key: string): string => fieldPath(path, key);
  switch (value.kind) {
    case "heading": {
      const o = readObject(value, path, ctx, ["kind", "text"], ["level"]);
      if (!o) return null;
      const text = readString(o.text, at("text"), ctx);
      const level = o.level;
      if (level !== undefined && level !== 1 && level !== 2 && level !== 3) return diag(ctx, at("level"), "invalid_enum");
      return text === null ? null : compact<DisplayBlock>({ kind: "heading", text, level: level as 1 | 2 | 3 | undefined });
    }
    case "text": {
      const o = readObject(value, path, ctx, ["kind", "text"]);
      const text = o ? readString(o.text, at("text"), ctx) : null;
      return text === null ? null : { kind: "text", text };
    }
    case "rich_text": {
      const o = readObject(value, path, ctx, ["kind", "runs"]);
      const runs = o ? readArray(o.runs, at("runs"), ctx, (v, p) => readRichRun(v, p, ctx)) : null;
      return runs === null ? null : { kind: "rich_text", runs };
    }
    case "facts": {
      const o = readObject(value, path, ctx, ["kind", "items"]);
      const items = o ? readArray(o.items, at("items"), ctx, (v, p) => {
        const item = readObject(v, p, ctx, ["label", "value"]);
        if (!item) return null;
        const label = readString(item.label, fieldPath(p, "label"), ctx);
        const val = readString(item.value, fieldPath(p, "value"), ctx);
        return label !== null && val !== null ? { label, value: val } : null;
      }) : null;
      return items === null ? null : { kind: "facts", items };
    }
    case "columns": {
      const o = readObject(value, path, ctx, ["kind", "columns"]);
      const columns = o ? readArray(o.columns, at("columns"), ctx, (v, p) => {
        const col = readObject(v, p, ctx, ["blocks"]);
        const blocks = col ? readBlocks(col.blocks, fieldPath(p, "blocks"), ctx) : null;
        return blocks === null ? null : { blocks };
      }) : null;
      return columns === null ? null : { kind: "columns", columns };
    }
    case "table": {
      const o = readObject(value, path, ctx, ["kind", "headers", "rows"]);
      if (!o) return null;
      const headers = readArray(o.headers, at("headers"), ctx, (v, p) => readString(v, p, ctx));
      const rows = readArray(o.rows, at("rows"), ctx, (v, p) => readArray(v, p, ctx, (c, cp) => readString(c, cp, ctx)));
      return headers !== null && rows !== null ? { kind: "table", headers, rows } : null;
    }
    case "link": {
      const o = readObject(value, path, ctx, ["kind", "label", "url"]);
      if (!o) return null;
      const label = readString(o.label, at("label"), ctx);
      const url = readString(o.url, at("url"), ctx);
      return label !== null && url !== null ? { kind: "link", label, url } : null;
    }
    case "group": {
      const o = readObject(value, path, ctx, ["kind", "blocks"]);
      const blocks = o ? readBlocks(o.blocks, at("blocks"), ctx) : null;
      return blocks === null ? null : { kind: "group", blocks };
    }
    case "collapsible": {
      const o = readObject(value, path, ctx, ["kind", "label", "blocks"], ["expanded"]);
      if (!o) return null;
      const label = readString(o.label, at("label"), ctx);
      const blocks = readBlocks(o.blocks, at("blocks"), ctx);
      const expanded = o.expanded === undefined ? undefined : readBoolean(o.expanded, at("expanded"), ctx);
      if (label === null || blocks === null || expanded === null) return null;
      return compact<DisplayBlock>({ kind: "collapsible", label, blocks, expanded });
    }
    case "copy": {
      const o = readObject(value, path, ctx, ["kind", "label", "text"]);
      if (!o) return null;
      const label = readString(o.label, at("label"), ctx);
      const text = readString(o.text, at("text"), ctx);
      return label !== null && text !== null ? { kind: "copy", label, text } : null;
    }
    default:
      return diag(ctx, at("kind"), "unknown_kind");
  }
}

function readDisplayArgs(args: JsonObject, ctx: GrammarCtx): DisplayCardArgs | null {
  const o = readObject(args, "$", ctx, ["blocks"], ["title"]);
  if (!o) return null;
  const title = readOptionalString(o, "title", "$", ctx);
  const blocks = readBlocks(o.blocks, fieldPath("$", "blocks"), ctx);
  if (title === null || blocks === null) return null;
  return compact<DisplayCardArgs>({ title, blocks });
}

function readOption(value: JsonValue, path: string, ctx: GrammarCtx): Option | null {
  const o = readObject(value, path, ctx, ["id", "label"]);
  if (!o) return null;
  const id = readString(o.id, fieldPath(path, "id"), ctx);
  const label = readString(o.label, fieldPath(path, "label"), ctx);
  return id !== null && label !== null ? { id, label } : null;
}

function readInput(value: JsonValue, path: string, ctx: GrammarCtx): InputSpec | null {
  if (!isJsonObject(value)) return diag(ctx, path, "wrong_type");
  const at = (key: string): string => fieldPath(path, key);
  const base = ["id", "kind", "label", "required"] as const;
  const common = (o: JsonObject): { id: string; label: string; required: boolean } | null => {
    const id = readString(o.id, at("id"), ctx);
    const label = readString(o.label, at("label"), ctx);
    const required = readBoolean(o.required, at("required"), ctx);
    return id !== null && label !== null && required !== null ? { id, label, required } : null;
  };
  switch (value.kind) {
    case "text": {
      const o = readObject(value, path, ctx, base, ["minLength", "maxLength"]);
      const c = o ? common(o) : null;
      if (!o || !c) return null;
      const minLength = o.minLength === undefined ? undefined : readInteger(o.minLength, at("minLength"), ctx);
      const maxLength = o.maxLength === undefined ? undefined : readInteger(o.maxLength, at("maxLength"), ctx);
      if (minLength === null || maxLength === null) return null;
      return compact<InputSpec>({ ...c, kind: "text", minLength, maxLength });
    }
    case "number": {
      const o = readObject(value, path, ctx, [...base, "min", "max"]);
      const c = o ? common(o) : null;
      if (!o || !c) return null;
      const min = readNumber(o.min, at("min"), ctx);
      const max = readNumber(o.max, at("max"), ctx);
      return min !== null && max !== null ? { ...c, kind: "number", min, max } : null;
    }
    case "date": case "time": {
      const kind = value.kind;
      const o = readObject(value, path, ctx, base, ["timezone"]);
      const c = o ? common(o) : null;
      if (!o || !c) return null;
      const timezone = readOptionalString(o, "timezone", path, ctx);
      return timezone === null ? null : compact<InputSpec>({ ...c, kind, timezone });
    }
    case "toggle": {
      const o = readObject(value, path, ctx, base);
      const c = o ? common(o) : null;
      return c ? { ...c, kind: "toggle" } : null;
    }
    case "choice": {
      const o = readObject(value, path, ctx, [...base, "multiple", "min", "max", "options"]);
      const c = o ? common(o) : null;
      if (!o || !c) return null;
      const multiple = readBoolean(o.multiple, at("multiple"), ctx);
      const min = readInteger(o.min, at("min"), ctx);
      const max = readInteger(o.max, at("max"), ctx);
      const options = readArray(o.options, at("options"), ctx, (v, p) => readOption(v, p, ctx));
      if (multiple === null || min === null || max === null || options === null) return null;
      return { ...c, kind: "choice", multiple, min, max, options };
    }
    default:
      return diag(ctx, at("kind"), "unknown_kind");
  }
}

/** Bounded plain JSON object for button `data`; nested objects stay exact JSON. */
function readButtonData(value: JsonValue | undefined, path: string, ctx: GrammarCtx): ButtonData | null {
  if (!isJsonObject(value)) return diag(ctx, path, "wrong_type");
  let tooDeep = false;
  const count = (v: JsonValue, depth: number): void => {
    if (depth > BUTTON_DATA_MAX_DEPTH) { tooDeep = true; return; }
    if (Array.isArray(v)) {
      ctx.buttonDataEntries += v.length;
      for (const item of v as readonly JsonValue[]) count(item, depth + 1);
    } else if (isJsonObject(v)) {
      const keys = Object.keys(v);
      ctx.buttonDataEntries += keys.length;
      for (const key of keys) count(v[key], depth + 1);
    }
  };
  count(value, 1);
  ctx.buttonDataBytes += byteLength(JSON.stringify(value));
  if (tooDeep) return diag(ctx, path, "data_depth");
  if (ctx.buttonDataEntries > BUTTON_DATA_MAX_ENTRIES) return diag(ctx, path, "data_entries");
  if (ctx.buttonDataBytes > BUTTON_DATA_MAX_BYTES) return diag(ctx, path, "data_bytes");
  return value;
}

function readButton(value: JsonValue, path: string, ctx: GrammarCtx): ButtonSpec | null {
  const o = readObject(value, path, ctx, ["id", "label"], ["data"]);
  if (!o) return null;
  const id = readString(o.id, fieldPath(path, "id"), ctx);
  const label = readString(o.label, fieldPath(path, "label"), ctx);
  const data = o.data === undefined ? undefined : readButtonData(o.data, fieldPath(path, "data"), ctx);
  if (id === null || label === null || data === null) return null;
  return compact<ButtonSpec>({ id, label, data });
}

function readInteractiveArgs(args: JsonObject, ctx: GrammarCtx): InteractiveCardArgs | null {
  const o = readObject(args, "$", ctx, ["title", "buttons"], ["text", "sections", "inputs"]);
  if (!o) return null;
  const title = readString(o.title, fieldPath("$", "title"), ctx);
  const text = readOptionalString(o, "text", "$", ctx);
  const sections = o.sections === undefined ? undefined : readArray(o.sections, fieldPath("$", "sections"), ctx, (v, p) => {
    const s = readObject(v, p, ctx, ["text"]);
    const t = s ? readString(s.text, fieldPath(p, "text"), ctx) : null;
    return t === null ? null : { text: t };
  });
  const inputs = o.inputs === undefined ? undefined : readArray(o.inputs, fieldPath("$", "inputs"), ctx, (v, p) => readInput(v, p, ctx));
  const buttons = readArray(o.buttons, fieldPath("$", "buttons"), ctx, (v, p) => readButton(v, p, ctx));
  if (title === null || text === null || sections === null || inputs === null || buttons === null) return null;
  return compact<InteractiveCardArgs>({ title, text, sections, inputs, buttons });
}

// ─── Reply frames ───────────────────────────────────────────────────────────

export interface ToolReplyFrame {
  readonly v: 1;
  readonly request_id: string;
  readonly result: CardToolResult;
}

const CARD_ERRORS: ReadonlySet<string> = new Set<CardError>([
  "policy_denied", "unavailable", "invalid_route", "validation_failed",
  "limit_exceeded", "capacity_full", "send_unconfirmed",
]);
const SAFE_REASONS: ReadonlySet<string> = new Set<SafeReasonCode>([
  "profile_404", "profile_unavailable", "profile_malformed", "config_inconsistent", "capability_disabled",
  "auth_rejected", "template_incompatible", "profile_incompatible", "local_disabled", "policy_revoked",
  "interaction_unavailable",
]);
const ROUTE_KINDS: ReadonlySet<string> = new Set(["dm", "group", "topic"]);
const OPAQUE_REF = /^[A-Za-z0-9_-]{1,64}$/;
const DIAG_PATH = /^\$[A-Za-z0-9_.[\]*]{0,127}$/;
const DIAG_RULE = /^[a-z0-9_]{1,64}$/;

function parseDiag(value: JsonValue): Diag | null {
  if (!isJsonObject(value) || !hasExactKeys(value, ["path", "rule"])) return null;
  const { path, rule } = value;
  if (typeof path !== "string" || !DIAG_PATH.test(path)) return null;
  if (typeof rule !== "string" || !DIAG_RULE.test(rule)) return null;
  return Object.freeze({ path, rule });
}

/** Strict closed validation of a `CardToolResult`; `null` if anything deviates. */
export function parseCardToolResult(value: JsonValue | undefined): CardToolResult | null {
  if (!isJsonObject(value)) return null;
  switch (value.status) {
    case "sent": {
      if (!hasExactKeys(value, ["status", "message_id", "route"], ["session_id"])) return null;
      const messageId = typeof value.message_id === "string" ? parseMessageIdentity(value.message_id) : null;
      const route = value.route;
      if (messageId === null || !isJsonObject(route) || !hasExactKeys(route, ["kind", "ref"])) return null;
      if (typeof route.kind !== "string" || !ROUTE_KINDS.has(route.kind)) return null;
      if (typeof route.ref !== "string" || !OPAQUE_REF.test(route.ref)) return null;
      const safeRoute = Object.freeze({ kind: route.kind as "dm" | "group" | "topic", ref: route.ref });
      if (value.session_id === undefined) return Object.freeze({ status: "sent", message_id: messageId, route: safeRoute });
      if (typeof value.session_id !== "string" || !OPAQUE_REF.test(value.session_id)) return null;
      return Object.freeze({ status: "sent", message_id: messageId, route: safeRoute, session_id: value.session_id });
    }
    case "degraded": {
      if (!hasExactKeys(value, ["status", "message_id", "interaction_available", "reason"])) return null;
      const messageId = typeof value.message_id === "string" ? parseMessageIdentity(value.message_id) : null;
      if (messageId === null || value.interaction_available !== false) return null;
      if (typeof value.reason !== "string" || !SAFE_REASONS.has(value.reason)) return null;
      return Object.freeze({
        status: "degraded", message_id: messageId, interaction_available: false, reason: value.reason as SafeReasonCode,
      });
    }
    case "error": {
      if (!hasExactKeys(value, ["status", "error"])) return null;
      const error = value.error;
      if (!isJsonObject(error) || !hasExactKeys(error, ["code"], ["diagnostics"])) return null;
      if (typeof error.code !== "string" || !CARD_ERRORS.has(error.code)) return null;
      const code = error.code as CardError;
      if (error.diagnostics === undefined) return Object.freeze({ status: "error", error: Object.freeze({ code }) });
      if (!Array.isArray(error.diagnostics) || error.diagnostics.length > MAX_DIAGNOSTICS) return null;
      const diagnostics: Diag[] = [];
      for (const d of error.diagnostics as readonly JsonValue[]) {
        const parsed = parseDiag(d);
        if (parsed === null) return null;
        diagnostics.push(parsed);
      }
      return Object.freeze({ status: "error", error: Object.freeze({ code, diagnostics: Object.freeze(diagnostics) }) });
    }
    default:
      return null;
  }
}

const REPLY_LIMITS: StrictJsonLimits = { maxDepth: 8, maxNodes: 256, unsafeIntegers: "reject" };

export type ReplyParse =
  | { readonly ok: true; readonly frame: ToolReplyFrame }
  | { readonly ok: false; readonly code: "malformed_utf8" | JsonRejectCode | "bad_shape" | "bad_version" | "bad_request_id" | "bad_result" };

export function parseReplyFrame(body: Uint8Array): ReplyParse {
  if (body.byteLength === 0 || body.byteLength > MAX_FRAME_BODY_BYTES) return { ok: false, code: "bad_shape" };
  const text = decodeUtf8(body);
  if (text === null) return { ok: false, code: "malformed_utf8" };
  const parsed = parseStrictJson(text, REPLY_LIMITS);
  if (!parsed.ok) return { ok: false, code: parsed.code };
  const v = parsed.value;
  if (!isJsonObject(v) || !hasExactKeys(v, ["v", "request_id", "result"])) return { ok: false, code: "bad_shape" };
  if (v.v !== PROTOCOL_VERSION) return { ok: false, code: "bad_version" };
  if (typeof v.request_id !== "string" || !REQUEST_ID.test(v.request_id)) return { ok: false, code: "bad_request_id" };
  const result = parseCardToolResult(v.result);
  if (result === null) return { ok: false, code: "bad_result" };
  return { ok: true, frame: Object.freeze({ v: 1, request_id: v.request_id, result }) };
}

export function encodeReplyFrame(frame: ToolReplyFrame): Uint8Array {
  if (frame.v !== PROTOCOL_VERSION || !REQUEST_ID.test(frame.request_id)) throw new FrameEncodeError("invalid_message");
  // Round-trip through the strict validator so only closed results are emitted.
  const roundTrip = parseStrictJson(JSON.stringify(frame.result), REPLY_LIMITS);
  const result = roundTrip.ok ? parseCardToolResult(roundTrip.value) : null;
  if (result === null) throw new FrameEncodeError("invalid_message");
  return encodeBody(JSON.stringify({ v: frame.v, request_id: frame.request_id, result }));
}
