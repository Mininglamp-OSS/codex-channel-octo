/**
 * Typed card REST boundary (§5.1 / §5.3 / E.2).
 *
 * A standalone fetch client bound to one trusted configured API base and Bot
 * credential. It never accepts a URL or credential per call, never follows
 * redirects (a credential-bearing request that is redirected fails closed),
 * reads response bodies through a byte-bounded stream, enforces a 30-second
 * ceiling with external abort, and surfaces failures only as `OctoApiError`
 * (transport/status/retry-after/closed code) or `CardRequestError` (rejected
 * before transport). No retries or orchestration happen here.
 *
 * Envelopes follow the approved reference client
 * Mininglamp-OSS/openclaw-channel-octo@2e710e903fa43ac9440723746f7395d2f7b4347e
 * (`src/api-fetch.ts` getCardProfile, sendCardMessage, editCardMessage,
 * sendTemplateCardMessage, editTemplateCardMessage, fetchBotEvents,
 * ackBotEvent, getGroupMembers). Live server acceptance remains P01–P10.
 */

import type {
  AcDisplayElement,
  AcInput,
  AcInteractiveElement,
  AcLocalAction,
  AcOpenUrlAction,
  AcSubmitAction,
  AcTextBlock,
  AcTextRun,
  AuthoredCard,
  CardChannelType,
  CardProfileWire,
  CardRoute,
  DisplayAdaptiveCard,
  InteractiveAdaptiveCard,
  JsonObject,
  JsonValue,
  RegistryData,
  TemplateRef,
  WireCardConfig,
  WireProfileLimits,
  WireState,
  WireTemplate,
  WireTemplateRef,
  WireTemplateView,
  WireTemplating,
} from "./contracts.js";
import { apiBaseUrl, parseApiBase, type ApiBase, type NormalizedOrigin, normalizeOrigin } from "./origin.js";
import {
  isJsonObject,
  isReservedAuthorKey,
  parseMessageIdentity,
  parseStrictJson,
  type StrictJsonLimits,
} from "./protocol.js";

export const CARD_API_DEADLINE_MS = 30_000;
/** Conservative complete-envelope ceiling (E.2); negotiated limits only narrow it. */
export const CARD_ENVELOPE_MAX_BYTES = 16_384;
export const CARD_MESSAGE_TYPE = 17;
export const CARD_VERSION = "1.5";
export const AC_SCHEMA_URL = "http://adaptivecards.io/schemas/adaptive-card.json";
export const MAX_EVENT_WAIT_SECONDS = 30;
export const MAX_EVENT_LIMIT = 100;

const ACK_BODY_MAX_BYTES = 16 * 1024;
const PROFILE_BODY_MAX_BYTES = 64 * 1024;
const EVENTS_BODY_MAX_BYTES = 512 * 1024;
const MEMBERS_BODY_MAX_BYTES = 1024 * 1024;
const ERROR_BODY_MAX_BYTES = 4 * 1024;
const MAX_MEMBERS = 10_000;

const ENDPOINTS = Object.freeze({
  profile: "/v1/bot/card/profile",
  send: "/v1/bot/sendMessage",
  edit: "/v1/bot/message/edit",
  events: "/v1/bot/events",
});

// ─── Errors ─────────────────────────────────────────────────────────────────

export type ApiOperation =
  | "get_profile" | "send_registry" | "send_authored" | "edit_registry" | "edit_authored"
  | "poll_owned" | "ack" | "get_fresh_members";

export type ApiTransport = "response" | "timeout" | "network" | "abort";

export type OctoApiErrorCode =
  | "http_status"
  | "redirect_refused"
  | "response_too_large"
  | "malformed_response"
  | "malformed_config"
  | "missing_identity"
  | "identity_mismatch"
  | "stale_sequence"
  | "timeout"
  | "network"
  | "aborted";

/** Closed structural diagnostic for a rejected profile; never a raw field name or value. */
export type ProfileDiagnostic =
  | "profile_shape"
  | "compat_type"
  | "capability_list"
  | "limits_type"
  | "templating_type"
  | "config_shape"
  | "config_unknown_key"
  | "config_type"
  | "template_ref_shape";

/** Content-free API failure: never carries a response body, header or underlying error. */
export class OctoApiError extends Error {
  readonly operation: ApiOperation;
  readonly transport: ApiTransport;
  /** HTTP status; 0 when no response was received. */
  readonly status: number;
  readonly code: OctoApiErrorCode;
  readonly retryAfterMs?: number;
  readonly detail?: ProfileDiagnostic;

  constructor(
    operation: ApiOperation, transport: ApiTransport, status: number, code: OctoApiErrorCode,
    retryAfterMs?: number, detail?: ProfileDiagnostic,
  ) {
    super(`card api ${operation} failed: ${transport}/${status}/${code}${detail ? `/${detail}` : ""}`);
    this.name = "OctoApiError";
    this.operation = operation;
    this.transport = transport;
    this.status = status;
    this.code = code;
    if (retryAfterMs !== undefined) this.retryAfterMs = retryAfterMs;
    if (detail !== undefined) this.detail = detail;
  }
}

export type CardRequestErrorCode = "invalid_request" | "invalid_card" | "envelope_too_large" | "invalid_deadline";

/** Rejected before any transport: definitively not sent. */
export class CardRequestError extends Error {
  readonly code: CardRequestErrorCode;
  /** Closed client-side field name; never caller content. */
  readonly field: string;
  constructor(code: CardRequestErrorCode, field: string) {
    super(`card api request rejected: ${code} (${field})`);
    this.name = "CardRequestError";
    this.code = code;
    this.field = field;
  }
}

// ─── §5.3 classification ────────────────────────────────────────────────────

export type SendFailureClass = "ambiguous" | "contract" | "policy";
export type EditFailureClass = "retryable" | "stale" | "contract" | "policy" | "gone";
export type ProfileFailureClass =
  | { readonly category: "unavailable"; readonly cache: false }
  | { readonly category: "disabled"; readonly reason: "malformed" | "auth" | "profile_404"; readonly cache: true };

function is2xx(status: number): boolean { return status >= 200 && status < 300; }
function is3xx(status: number): boolean { return status >= 300 && status < 400; }

/**
 * Sends: anything that may have been accepted (timeout/network/abort, 2xx
 * without identity, 3xx, 429, 5xx, unlisted 4xx) is ambiguous and must never
 * be blindly resent. Only 400/422/404 are contract and 401/403 policy.
 */
export function classifySendFailure(err: OctoApiError | CardRequestError): SendFailureClass {
  if (err instanceof CardRequestError) return "contract";
  if (err.transport !== "response") return "ambiguous";
  const s = err.status;
  if (s === 400 || s === 422 || s === 404) return "contract";
  if (s === 401 || s === 403) return "policy";
  return "ambiguous";
}

/**
 * Edits: transport faults, 2xx without the expected identity, 429 and 5xx
 * are retryable under the same sequence/body. `stale` is reported only when
 * the client was configured with the proven P05a rejection code.
 */
export function classifyEditFailure(err: OctoApiError | CardRequestError): EditFailureClass {
  if (err instanceof CardRequestError) return "contract";
  if (err.code === "stale_sequence") return "stale";
  if (err.transport !== "response") return "retryable";
  const s = err.status;
  if (is2xx(s) || s === 429 || s >= 500) return "retryable";
  if (s === 401 || s === 403) return "policy";
  if (s === 404) return "gone";
  return "contract";
}

/**
 * Profile: a structurally malformed `config` (wrong types, unknown keys or
 * bad template ref) is a resolved, cacheable `disabled(malformed)` (E.2).
 * Thrown, unparsable or otherwise malformed-success results are uncached
 * `unavailable`.
 */
export function classifyProfileFailure(err: OctoApiError | CardRequestError): ProfileFailureClass {
  if (err instanceof OctoApiError && err.code === "malformed_config") {
    return { category: "disabled", reason: "malformed", cache: true };
  }
  if (err instanceof OctoApiError && err.transport === "response") {
    if (err.status === 400 || err.status === 422) return { category: "disabled", reason: "malformed", cache: true };
    if (err.status === 401 || err.status === 403) return { category: "disabled", reason: "auth", cache: true };
    if (err.status === 404) return { category: "disabled", reason: "profile_404", cache: true };
  }
  return { category: "unavailable", cache: false };
}

// ─── Request validation and closed serialization ────────────────────────────

const CLIENT_MSG_NO = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ANY_CONTROL = /\p{Cc}/u;
const CHANNEL_TYPES: ReadonlySet<number> = new Set<CardChannelType>([1, 2, 5]);
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
const WIRE_STATES: ReadonlySet<string> = new Set<WireState>(["reasoning", "answering", "completed", "stopped", "error"]);

const utf8 = new TextEncoder();
function byteLength(s: string): number { return utf8.encode(s).byteLength; }
function runeLength(s: string): number { return [...s].length; }

function reject(code: CardRequestErrorCode, field: string): never {
  throw new CardRequestError(code, field);
}

function wireString(value: unknown, field: string, code: CardRequestErrorCode = "invalid_card"): string {
  if (typeof value !== "string" || LONE_SURROGATE.test(value)) reject(code, field);
  return value as string;
}

function nonEmptyWireString(value: unknown, field: string, code: CardRequestErrorCode = "invalid_card"): string {
  const s = wireString(value, field, code);
  if (s.trim() === "") reject(code, field);
  return s;
}

function checkRoute(route: CardRoute): { channel_id: string; channel_type: CardChannelType } {
  const id = route?.channelId;
  if (typeof id !== "string" || id.trim() === "" || id.length > 256 || CONTROL_CHARS.test(id)) {
    reject("invalid_request", "channel_id");
  }
  if (!CHANNEL_TYPES.has(route.channelType)) reject("invalid_request", "channel_type");
  return { channel_id: id, channel_type: route.channelType };
}

function checkClientMsgNo(value: string): string {
  if (typeof value !== "string" || !CLIENT_MSG_NO.test(value)) reject("invalid_request", "client_msg_no");
  return value;
}

function checkMessageId(value: string): string {
  const id = typeof value === "string" ? parseMessageIdentity(value) : null;
  if (id === null) reject("invalid_request", "message_id");
  return id as string;
}

function checkSeq(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) reject("invalid_request", "card_seq");
  return value;
}

// The version is the exact server-selected string: no local allowlist or format, only
// well-formedness. The complete envelope cap bounds its size.
function checkTemplateRef(ref: TemplateRef): { id: string; version: string } {
  const r = ref as unknown;
  if (r === null || typeof r !== "object" || Array.isArray(r)) reject("invalid_request", "template_ref");
  const proto = Object.getPrototypeOf(r);
  if (proto !== Object.prototype && proto !== null) reject("invalid_request", "template_ref");
  const keys = Reflect.ownKeys(r as object);
  if (keys.length !== 2 || !Object.hasOwn(r as object, "id") || !Object.hasOwn(r as object, "version")) {
    reject("invalid_request", "template_ref");
  }
  const { id, version } = r as { id: unknown; version: unknown };
  if (id !== "ai.reasoning-process") reject("invalid_request", "template_ref");
  if (typeof version !== "string" || version.trim() === "" || version !== version.trim()
    || ANY_CONTROL.test(version) || LONE_SURROGATE.test(version)) {
    reject("invalid_request", "template_ref");
  }
  return { id: "ai.reasoning-process", version: version as string };
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], field: string): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) reject("invalid_card", field);
  return value as T;
}

function optionalBool(value: unknown, field: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") reject("invalid_card", field);
  return value as boolean;
}

function compact<T extends Record<string, unknown>>(obj: T): T {
  for (const key of Object.keys(obj)) if (obj[key] === undefined) delete obj[key];
  return obj;
}

function asRecord(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) reject("invalid_card", field);
  return value as Record<string, unknown>;
}

// Closed projections: only the source-grounded Adaptive Card element and
// property set is copied; any other runtime key is dropped, any wrong type
// rejects. Traversal is bounded before every descent (C.1: depth 12, 200
// rendered nodes; button data depth 4, 64 entries, 2,048 aggregate UTF-8
// bytes, no reserved keys), so a corrupted runtime value cannot overflow the
// stack or forward routing data. This is request-boundary validation, not
// card building or policy.

export const CARD_MAX_DEPTH = 12;
export const CARD_MAX_NODES = 200;
export const BUTTON_DATA_MAX_DEPTH = 4;
export const BUTTON_DATA_MAX_ENTRIES = 64;
export const BUTTON_DATA_MAX_BYTES = 2048;

interface ProjectCtx {
  nodes: number;
  dataEntries: number;
  dataBytes: number;
}

/** Count one rendered node at `depth` (1 = card body item) before descending. */
function enter(ctx: ProjectCtx, depth: number): void {
  if (depth > CARD_MAX_DEPTH) reject("invalid_card", "card.depth");
  ctx.nodes++;
  if (ctx.nodes > CARD_MAX_NODES) reject("invalid_card", "card.nodes");
}

function boundedArray<T>(
  value: unknown, field: string, ctx: ProjectCtx, depth: number,
  item: (v: unknown) => T, opts: { nonEmpty?: boolean } = {},
): T[] {
  if (!Array.isArray(value) || (opts.nonEmpty && value.length === 0)) reject("invalid_card", field);
  const items = value as unknown[];
  // Every item is at least one node; refuse before mapping an oversized array.
  if (ctx.nodes + items.length > CARD_MAX_NODES) reject("invalid_card", "card.nodes");
  return items.map((v) => { enter(ctx, depth); return item(v); });
}

function projectOpenUrl(value: unknown): AcOpenUrlAction {
  const o = asRecord(value, "Action.OpenUrl");
  if (o.type !== "Action.OpenUrl") reject("invalid_card", "Action.OpenUrl");
  const url = nonEmptyWireString(o.url, "Action.OpenUrl.url");
  let parsed: URL;
  try { parsed = new URL(url); } catch { return reject("invalid_card", "Action.OpenUrl.url"); }
  if (parsed.protocol !== "https:" || parsed.username !== "" || parsed.password !== "") {
    reject("invalid_card", "Action.OpenUrl.url");
  }
  return { type: "Action.OpenUrl", title: nonEmptyWireString(o.title, "Action.OpenUrl.title"), url };
}

function projectLocalAction(value: unknown, ctx: ProjectCtx, depth: number): AcLocalAction {
  const o = asRecord(value, "ActionSet.actions");
  switch (o.type) {
    case "Action.OpenUrl":
      return projectOpenUrl(o);
    case "Action.ToggleVisibility":
      return {
        type: "Action.ToggleVisibility",
        title: nonEmptyWireString(o.title, "Action.ToggleVisibility.title"),
        targetElements: boundedArray(o.targetElements, "Action.ToggleVisibility.targetElements", ctx, depth + 1, (t) => {
          const target = asRecord(t, "targetElements");
          const visible = optionalBool(target.isVisible, "targetElements.isVisible");
          if (visible === undefined) reject("invalid_card", "targetElements.isVisible");
          return { elementId: nonEmptyWireString(target.elementId, "targetElements.elementId"), isVisible: visible as boolean };
        }, { nonEmpty: true }),
      };
    case "Action.CopyToClipboard":
      return {
        type: "Action.CopyToClipboard",
        title: nonEmptyWireString(o.title, "Action.CopyToClipboard.title"),
        text: wireString(o.text, "Action.CopyToClipboard.text"),
      };
    default:
      return reject("invalid_card", "ActionSet.actions");
  }
}

function projectTextBlock(o: Record<string, unknown>): AcTextBlock {
  if (o.wrap !== true) reject("invalid_card", "TextBlock.wrap");
  return compact({
    type: "TextBlock" as const,
    text: wireString(o.text, "TextBlock.text"),
    wrap: true as const,
    weight: o.weight === undefined ? undefined : oneOf(o.weight, ["Bolder"] as const, "TextBlock.weight"),
    size: o.size === undefined ? undefined : oneOf(o.size, ["Medium", "Large"] as const, "TextBlock.size"),
    spacing: o.spacing === undefined ? undefined : oneOf(o.spacing, ["None", "Small", "Medium"] as const, "TextBlock.spacing"),
    separator: optionalBool(o.separator, "TextBlock.separator"),
    selectAction: o.selectAction === undefined ? undefined : projectOpenUrl(o.selectAction),
  });
}

function projectTextRun(value: unknown): AcTextRun {
  const o = asRecord(value, "TextRun");
  if (o.type !== "TextRun") reject("invalid_card", "TextRun");
  return compact({
    type: "TextRun" as const,
    text: wireString(o.text, "TextRun.text"),
    weight: o.weight === undefined ? undefined : oneOf(o.weight, ["Bolder"] as const, "TextRun.weight"),
    isSubtle: optionalBool(o.isSubtle, "TextRun.isSubtle"),
    fontType: o.fontType === undefined ? undefined : oneOf(o.fontType, ["Default", "Monospace"] as const, "TextRun.fontType"),
    color: o.color === undefined ? undefined
      : oneOf(o.color, ["good", "warning", "attention", "accent"] as const, "TextRun.color"),
  });
}

function projectFacts(o: Record<string, unknown>, ctx: ProjectCtx, depth: number): { type: "FactSet"; facts: { title: string; value: string }[] } {
  return {
    type: "FactSet",
    facts: boundedArray(o.facts, "FactSet.facts", ctx, depth + 1, (f) => {
      const fact = asRecord(f, "FactSet.facts");
      return { title: wireString(fact.title, "Fact.title"), value: wireString(fact.value, "Fact.value") };
    }, { nonEmpty: true }),
  };
}

function optionalId(value: unknown, field: string): string | undefined {
  return value === undefined ? undefined : nonEmptyWireString(value, field);
}

/** `depth` is the depth already entered for this element. */
function projectDisplayElement(value: unknown, ctx: ProjectCtx, depth: number): AcDisplayElement {
  const o = asRecord(value, "body");
  const children = (items: unknown, field: string, childDepth: number): AcDisplayElement[] =>
    boundedArray(items, field, ctx, childDepth, (v) => projectDisplayElement(v, ctx, childDepth), { nonEmpty: true });
  switch (o.type) {
    case "TextBlock":
      return projectTextBlock(o);
    case "RichTextBlock":
      return { type: "RichTextBlock", inlines: boundedArray(o.inlines, "RichTextBlock.inlines", ctx, depth + 1, projectTextRun, { nonEmpty: true }) };
    case "FactSet":
      return projectFacts(o, ctx, depth);
    case "ActionSet":
      return compact({
        type: "ActionSet" as const,
        id: optionalId(o.id, "ActionSet.id"),
        isVisible: optionalBool(o.isVisible, "ActionSet.isVisible"),
        actions: boundedArray(o.actions, "ActionSet.actions", ctx, depth + 1, (a) => projectLocalAction(a, ctx, depth + 1), { nonEmpty: true }),
      });
    case "Container":
      return compact({
        type: "Container" as const,
        id: optionalId(o.id, "Container.id"),
        isVisible: optionalBool(o.isVisible, "Container.isVisible"),
        style: o.style === undefined ? undefined
          : oneOf(o.style, ["good", "warning", "attention", "emphasis"] as const, "Container.style"),
        spacing: o.spacing === undefined ? undefined : oneOf(o.spacing, ["None", "Small", "Medium"] as const, "Container.spacing"),
        items: children(o.items, "Container.items", depth + 1),
      });
    case "ColumnSet":
      return {
        type: "ColumnSet",
        columns: boundedArray(o.columns, "ColumnSet.columns", ctx, depth + 1, (c) => {
          const col = asRecord(c, "Column");
          if (col.type !== "Column") reject("invalid_card", "Column");
          return {
            type: "Column" as const,
            width: oneOf(col.width, ["stretch", "auto"] as const, "Column.width"),
            items: children(col.items, "Column.items", depth + 2),
          };
        }, { nonEmpty: true }),
      };
    case "Table": {
      if (typeof o.firstRowAsHeader !== "boolean") reject("invalid_card", "Table.firstRowAsHeader");
      const columns = o.columns;
      if (!Array.isArray(columns) || columns.length === 0 || columns.length > CARD_MAX_NODES) reject("invalid_card", "Table.columns");
      return {
        type: "Table",
        firstRowAsHeader: o.firstRowAsHeader as boolean,
        columns: (columns as unknown[]).map((c) => {
          const width = asRecord(c, "Table.columns").width;
          if (typeof width !== "number" || !Number.isFinite(width) || width <= 0) reject("invalid_card", "Table.columns.width");
          return { width: width as number };
        }),
        rows: boundedArray(o.rows, "Table.rows", ctx, depth + 1, (r) => {
          const row = asRecord(r, "TableRow");
          if (row.type !== "TableRow") reject("invalid_card", "TableRow");
          return {
            type: "TableRow" as const,
            cells: boundedArray(row.cells, "TableRow.cells", ctx, depth + 2, (cell) => {
              const c = asRecord(cell, "TableCell");
              if (c.type !== "TableCell") reject("invalid_card", "TableCell");
              return { type: "TableCell" as const, items: children(c.items, "TableCell.items", depth + 3) };
            }, { nonEmpty: true }),
          };
        }, { nonEmpty: true }),
      };
    }
    default:
      return reject("invalid_card", "body.type");
  }
}

function finiteNumber(value: unknown, field: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) reject("invalid_card", field);
  return value as number;
}

function projectInput(o: Record<string, unknown>, ctx: ProjectCtx, depth: number): AcInput {
  const base = {
    id: nonEmptyWireString(o.id, "Input.id"),
    label: o.label === undefined ? undefined : wireString(o.label, "Input.label"),
    isRequired: optionalBool(o.isRequired, "Input.isRequired"),
  };
  const placeholder = o.placeholder === undefined ? undefined : wireString(o.placeholder, "Input.placeholder");
  switch (o.type) {
    case "Input.Text": {
      const maxLength = finiteNumber(o.maxLength, "Input.Text.maxLength");
      if (maxLength !== undefined && (!Number.isSafeInteger(maxLength) || maxLength < 1)) reject("invalid_card", "Input.Text.maxLength");
      return compact({ type: "Input.Text" as const, ...base, placeholder, maxLength });
    }
    case "Input.Number":
      return compact({
        type: "Input.Number" as const, ...base, placeholder,
        min: finiteNumber(o.min, "Input.Number.min"), max: finiteNumber(o.max, "Input.Number.max"),
      });
    case "Input.Date":
      return compact({ type: "Input.Date" as const, ...base, placeholder });
    case "Input.Time":
      return compact({ type: "Input.Time" as const, ...base, placeholder });
    case "Input.Toggle":
      return compact({ type: "Input.Toggle" as const, ...base, title: o.title === undefined ? undefined : wireString(o.title, "Input.Toggle.title") });
    case "Input.ChoiceSet":
      return compact({
        type: "Input.ChoiceSet" as const, ...base,
        choices: boundedArray(o.choices, "Input.ChoiceSet.choices", ctx, depth + 1, (c) => {
          const choice = asRecord(c, "Input.ChoiceSet.choices");
          return { title: wireString(choice.title, "Choice.title"), value: nonEmptyWireString(choice.value, "Choice.value") };
        }, { nonEmpty: true }),
        style: o.style === undefined ? undefined : oneOf(o.style, ["expanded", "compact"] as const, "Input.ChoiceSet.style"),
        isMultiSelect: optionalBool(o.isMultiSelect, "Input.ChoiceSet.isMultiSelect"),
      });
    default:
      return reject("invalid_card", "body.type");
  }
}

function projectInteractiveElement(value: unknown, ctx: ProjectCtx, depth: number): AcInteractiveElement {
  const o = asRecord(value, "body");
  if (o.type === "TextBlock") return projectTextBlock(o);
  if (o.type === "FactSet") return projectFacts(o, ctx, depth);
  if (o.type === "Container") {
    return compact({
      type: "Container" as const,
      spacing: o.spacing === undefined ? undefined : oneOf(o.spacing, ["None", "Small", "Medium"] as const, "Container.spacing"),
      items: boundedArray(o.items, "Container.items", ctx, depth + 1,
        (v) => projectInteractiveElement(v, ctx, depth + 1), { nonEmpty: true }),
    });
  }
  if (typeof o.type === "string" && o.type.startsWith("Input.")) return projectInput(o, ctx, depth);
  return reject("invalid_card", "body.type");
}

/** Button data: plain JSON with C.1 depth/entry/aggregate-byte bounds and no reserved keys. */
function projectButtonData(value: unknown, ctx: ProjectCtx): JsonObject {
  // Same depth convention as the protocol grammar: the data object is depth 1
  // and every value nested deeper than BUTTON_DATA_MAX_DEPTH rejects.
  const walk = (v: unknown, depth: number): JsonValue => {
    if (depth > BUTTON_DATA_MAX_DEPTH) reject("invalid_card", "Action.Submit.data.depth");
    if (v === null || typeof v === "boolean") return v;
    if (typeof v === "string") return wireString(v, "Action.Submit.data");
    if (typeof v === "number") {
      if (!Number.isFinite(v)) reject("invalid_card", "Action.Submit.data");
      return v;
    }
    if (Array.isArray(v)) {
      ctx.dataEntries += v.length;
      if (ctx.dataEntries > BUTTON_DATA_MAX_ENTRIES) reject("invalid_card", "Action.Submit.data.entries");
      return v.map((item) => walk(item, depth + 1));
    }
    const o = asRecord(v, "Action.Submit.data");
    const proto = Object.getPrototypeOf(o);
    if (proto !== Object.prototype && proto !== null) reject("invalid_card", "Action.Submit.data");
    const keys = Object.keys(o);
    ctx.dataEntries += keys.length;
    if (ctx.dataEntries > BUTTON_DATA_MAX_ENTRIES) reject("invalid_card", "Action.Submit.data.entries");
    const out: Record<string, JsonValue> = {};
    for (const key of keys) {
      if (key === "__proto__" || key === "constructor" || key === "prototype") reject("invalid_card", "Action.Submit.data");
      if (isReservedAuthorKey(key)) reject("invalid_card", "Action.Submit.data.reserved_key");
      wireString(key, "Action.Submit.data");
      out[key] = walk(o[key], depth + 1);
    }
    return out;
  };
  const data = walk(asRecord(value, "Action.Submit.data"), 1) as JsonObject;
  ctx.dataBytes += byteLength(JSON.stringify(data));
  if (ctx.dataBytes > BUTTON_DATA_MAX_BYTES) reject("invalid_card", "Action.Submit.data.bytes");
  return data;
}

function projectSubmit(value: unknown, ctx: ProjectCtx): AcSubmitAction {
  const o = asRecord(value, "actions");
  if (o.type !== "Action.Submit") reject("invalid_card", "actions.type");
  return compact({
    type: "Action.Submit" as const,
    id: nonEmptyWireString(o.id, "Action.Submit.id"),
    title: nonEmptyWireString(o.title, "Action.Submit.title"),
    data: o.data === undefined ? undefined : projectButtonData(o.data, ctx),
    style: o.style === undefined ? undefined : oneOf(o.style, ["positive", "destructive"] as const, "Action.Submit.style"),
  });
}

function projectCardHeader(o: Record<string, unknown>): void {
  if (o.type !== "AdaptiveCard") reject("invalid_card", "AdaptiveCard.type");
  if (o.version !== CARD_VERSION) reject("invalid_card", "AdaptiveCard.version");
  if (o.$schema !== AC_SCHEMA_URL) reject("invalid_card", "AdaptiveCard.$schema");
}

/** Closed serialization of an authored card bound to its profile. */
export function projectAuthoredCard(authored: AuthoredCard): DisplayAdaptiveCard | InteractiveAdaptiveCard {
  const o = asRecord(authored?.card, "card");
  projectCardHeader(o);
  const ctx: ProjectCtx = { nodes: 0, dataEntries: 0, dataBytes: 0 };
  if (authored.profile === "octo/v1") {
    if (o.actions !== undefined) reject("invalid_card", "AdaptiveCard.actions");
    return {
      type: "AdaptiveCard", version: CARD_VERSION, $schema: AC_SCHEMA_URL,
      body: boundedArray(o.body, "AdaptiveCard.body", ctx, 1, (v) => projectDisplayElement(v, ctx, 1), { nonEmpty: true }),
    };
  }
  if (authored.profile === "octo/v2") {
    return compact({
      type: "AdaptiveCard" as const, version: CARD_VERSION, $schema: AC_SCHEMA_URL,
      body: boundedArray(o.body, "AdaptiveCard.body", ctx, 1, (v) => projectInteractiveElement(v, ctx, 1), { nonEmpty: true }),
      actions: o.actions === undefined ? undefined
        : boundedArray(o.actions, "AdaptiveCard.actions", ctx, 1, (a) => projectSubmit(a, ctx)),
    }) as InteractiveAdaptiveCard;
  }
  return reject("invalid_card", "profile");
}

// Template data contract bounds (reference `src/reasoning-process.ts`, E.2,
// and the server `ai.reasoning-process@0.4.1` data schema): thought nonempty
// and ≤280 scalars (no 0.4.0 widening), actions nonempty, tool ≤81, detail
// nonempty and ≤192, statusGlyph ≤2, title ≤64, statusLabel ≤32,
// collapsedSummary and progressText ≤160, timerText ≤128, errorTitle ≤64,
// errorMessage ≤121, reasoningId ≤512; newest 6 phases and 12 actions.
// `reasoning`/`answering` require progressText, `error` requires errorTitle
// and errorMessage, and exactly one of traceExpanded/traceCollapsed is true.
export const REGISTRY_MAX_PHASES = 6;
export const REGISTRY_MAX_ACTIONS = 12;
export const REGISTRY_THOUGHT_MAX = 280;

function bounded(value: unknown, field: string, maxRunes: number): string {
  const s = nonEmptyWireString(value, field);
  if (runeLength(s) > maxRunes) reject("invalid_card", field);
  return s;
}

/** Closed serialization of `ai.reasoning-process` data; `state` must equal `data.state`. */
export function projectRegistryData(state: WireState, data: RegistryData): RegistryData {
  if (!WIRE_STATES.has(state)) reject("invalid_card", "state");
  const o = asRecord(data, "data");
  if (o.state !== state) reject("invalid_card", "data.state");
  const rawPhases = o.phases;
  if (!Array.isArray(rawPhases) || rawPhases.length === 0 || rawPhases.length > REGISTRY_MAX_PHASES) {
    reject("invalid_card", "data.phases");
  }
  let actionCount = 0;
  const phases = (rawPhases as unknown[]).map((p) => {
    const phase = asRecord(p, "data.phases");
    const rawActions = phase.actions;
    if (!Array.isArray(rawActions) || rawActions.length === 0) reject("invalid_card", "data.phases.actions");
    actionCount += (rawActions as unknown[]).length;
    if (actionCount > REGISTRY_MAX_ACTIONS) reject("invalid_card", "data.phases.actions");
    const actions = (rawActions as unknown[]).map((a) => {
      const action = asRecord(a, "data.phases.actions");
      return {
        tool: bounded(action.tool, "action.tool", 81),
        detail: bounded(action.detail, "action.detail", 192),
        statusGlyph: bounded(action.statusGlyph, "action.statusGlyph", 2),
        statusTone: oneOf(action.statusTone, ["Accent", "Good", "Attention"] as const, "action.statusTone"),
      };
    });
    return { thought: bounded(phase.thought, "phase.thought", REGISTRY_THOUGHT_MAX), actions };
  });
  if (typeof o.traceExpanded !== "boolean" || typeof o.traceCollapsed !== "boolean"
    || o.traceExpanded === o.traceCollapsed) reject("invalid_card", "data.trace");
  if ((state === "reasoning" || state === "answering") && o.progressText === undefined) reject("invalid_card", "data.progressText");
  if (state === "error" && (o.errorTitle === undefined || o.errorMessage === undefined)) reject("invalid_card", "data.error");
  return compact({
    reasoningId: bounded(o.reasoningId, "data.reasoningId", 512),
    state,
    title: bounded(o.title, "data.title", 64),
    statusLabel: bounded(o.statusLabel, "data.statusLabel", 32),
    statusTone: oneOf(o.statusTone, ["Accent", "Good", "Warning", "Attention"] as const, "data.statusTone"),
    timerText: bounded(o.timerText, "data.timerText", 128),
    traceExpanded: o.traceExpanded as boolean,
    traceCollapsed: o.traceCollapsed as boolean,
    collapsedSummary: bounded(o.collapsedSummary, "data.collapsedSummary", 160),
    progressText: o.progressText === undefined ? undefined : bounded(o.progressText, "data.progressText", 160),
    phases,
    errorTitle: o.errorTitle === undefined ? undefined : bounded(o.errorTitle, "data.errorTitle", 64),
    errorMessage: o.errorMessage === undefined ? undefined : bounded(o.errorMessage, "data.errorMessage", 121),
  });
}

// ─── Profile projection (reference getCardProfile / parseBotCardConfig) ─────
//
// Structural only. `config` must be exactly the five typed keys with an
// exact `{id, version}` (or null) ref; any deviation is `malformed_config`,
// which the policy layer caches as resolved disabled(malformed). Other
// type faults are `malformed_response` (unavailable, uncached). Unknown
// top-level, limit and template extension keys are dropped by projection.

const PROFILE_LIST_MAX = 256;
const PROFILE_STRING_MAX = 128;
const CONFIG_KEYS = ["card_enabled", "reasoning_enabled", "reasoning_template_ref", "display_enabled", "interaction_enabled"] as const;
const LIMIT_KEYS = ["max_nodes", "max_depth", "max_payload_bytes", "max_input_text_bytes", "max_inputs_bytes"] as const;

class ProfileReject {
  constructor(readonly code: "malformed_response" | "malformed_config", readonly detail: ProfileDiagnostic) {}
}

function profileFail(code: "malformed_response" | "malformed_config", detail: ProfileDiagnostic): never {
  throw new ProfileReject(code, detail);
}

function profileString(value: JsonValue | undefined, detail: ProfileDiagnostic): string {
  if (typeof value !== "string" || value.length > PROFILE_STRING_MAX || CONTROL_CHARS.test(value)) {
    profileFail("malformed_response", detail);
  }
  return value as string;
}

function profileStringList(value: JsonValue | undefined, detail: ProfileDiagnostic): readonly string[] {
  if (!Array.isArray(value) || value.length > PROFILE_LIST_MAX) profileFail("malformed_response", detail);
  return Object.freeze((value as readonly JsonValue[]).map((v) => profileString(v, detail)));
}

/** Compatibility flags: boolean, or the reference's tolerated 1/0 serialization. */
function compatFlag(value: JsonValue | undefined): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "boolean") return value;
  if (value === 1 || value === 0) return value === 1;
  return profileFail("malformed_response", "compat_type");
}

function projectConfig(value: JsonValue): WireCardConfig {
  if (!isJsonObject(value)) profileFail("malformed_config", "config_shape");
  const config = value as JsonObject;
  for (const key of Object.keys(config)) {
    if (!(CONFIG_KEYS as readonly string[]).includes(key)) profileFail("malformed_config", "config_unknown_key");
  }
  for (const key of CONFIG_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(config, key)) profileFail("malformed_config", "config_shape");
  }
  const flags = [config.card_enabled, config.reasoning_enabled, config.display_enabled, config.interaction_enabled];
  if (flags.some((f) => typeof f !== "boolean")) profileFail("malformed_config", "config_type");
  const rawRef = config.reasoning_template_ref;
  let ref: WireTemplateRef | null = null;
  if (rawRef !== null) {
    if (!isJsonObject(rawRef)) profileFail("malformed_config", "template_ref_shape");
    const r = rawRef as JsonObject;
    const keys = Object.keys(r);
    const ok = keys.length === 2 && keys.includes("id") && keys.includes("version")
      && typeof r.id === "string" && r.id !== "" && r.id.trim() === r.id && r.id.length <= PROFILE_STRING_MAX
      && typeof r.version === "string" && r.version !== "" && r.version.trim() === r.version && r.version.length <= PROFILE_STRING_MAX;
    if (!ok) profileFail("malformed_config", "template_ref_shape");
    ref = Object.freeze({ id: r.id as string, version: r.version as string });
  }
  return Object.freeze({
    card_enabled: config.card_enabled as boolean,
    reasoning_enabled: config.reasoning_enabled as boolean,
    reasoning_template_ref: ref,
    display_enabled: config.display_enabled as boolean,
    interaction_enabled: config.interaction_enabled as boolean,
  });
}

function projectLimits(value: JsonValue): WireProfileLimits {
  if (!isJsonObject(value)) profileFail("malformed_response", "limits_type");
  const limits = value as JsonObject;
  const out: Record<string, number> = {};
  for (const key of LIMIT_KEYS) {
    const v = limits[key];
    if (v === undefined) continue;
    if (typeof v !== "number" || !Number.isFinite(v)) profileFail("malformed_response", "limits_type");
    out[key] = v as number;
  }
  return Object.freeze(out) as WireProfileLimits;
}

function projectTemplating(value: JsonValue): WireTemplating {
  if (!isJsonObject(value)) profileFail("malformed_response", "templating_type");
  const t = value as JsonObject;
  const supported = t.supported;
  if (supported !== undefined && typeof supported !== "boolean") profileFail("malformed_response", "templating_type");
  const wire = t.wire === undefined ? undefined : profileString(t.wire, "templating_type");
  let templates: readonly WireTemplate[] | undefined;
  if (t.templates !== undefined) {
    if (!Array.isArray(t.templates) || t.templates.length > PROFILE_LIST_MAX) profileFail("malformed_response", "templating_type");
    templates = Object.freeze((t.templates as readonly JsonValue[]).map((candidate): WireTemplate => {
      if (!isJsonObject(candidate)) profileFail("malformed_response", "templating_type");
      const tpl = candidate as JsonObject;
      if (!Array.isArray(tpl.views) || tpl.views.length > PROFILE_LIST_MAX) profileFail("malformed_response", "templating_type");
      return Object.freeze({
        id: profileString(tpl.id, "templating_type"),
        version: profileString(tpl.version, "templating_type"),
        views: Object.freeze((tpl.views as readonly JsonValue[]).map((candidateView): WireTemplateView => {
          if (!isJsonObject(candidateView)) profileFail("malformed_response", "templating_type");
          const view = candidateView as JsonObject;
          return Object.freeze({
            name: profileString(view.name, "templating_type"),
            states: view.states === undefined ? Object.freeze([]) : profileStringList(view.states, "templating_type"),
            wire_profile: profileString(view.wire_profile, "templating_type"),
            submit_actions: view.submit_actions === undefined ? Object.freeze([]) : profileStringList(view.submit_actions, "templating_type"),
          });
        })),
      });
    }));
  }
  return Object.freeze({
    ...(supported !== undefined ? { supported } : {}),
    ...(wire !== undefined ? { wire } : {}),
    ...(templates !== undefined ? { templates } : {}),
  });
}

/** Typed closed profile projection; throws `OctoApiError` with a closed detail on rejection. */
export function projectCardProfile(value: JsonValue, status = 200): CardProfileWire {
  try {
    if (!isJsonObject(value)) profileFail("malformed_response", "profile_shape");
    const p = value as JsonObject;
    const available = compatFlag(p.available);
    const enabled = compatFlag(p.enabled);
    const lists = (["profiles", "elements", "inputs", "actions"] as const).map((key) =>
      p[key] === undefined ? undefined : profileStringList(p[key], "capability_list"));
    return Object.freeze({
      ...(available !== undefined ? { available } : {}),
      ...(enabled !== undefined ? { enabled } : {}),
      ...(lists[0] !== undefined ? { profiles: lists[0] } : {}),
      ...(p.card_version !== undefined ? { card_version: profileString(p.card_version, "capability_list") } : {}),
      ...(lists[1] !== undefined ? { elements: lists[1] } : {}),
      ...(lists[2] !== undefined ? { inputs: lists[2] } : {}),
      ...(lists[3] !== undefined ? { actions: lists[3] } : {}),
      ...(p.limits !== undefined ? { limits: projectLimits(p.limits) } : {}),
      ...(p.templating !== undefined ? { templating: projectTemplating(p.templating) } : {}),
      ...(p.config !== undefined ? { config: projectConfig(p.config) } : {}),
    });
  } catch (err) {
    if (err instanceof ProfileReject) throw new OctoApiError("get_profile", "response", status, err.code, undefined, err.detail);
    throw err;
  }
}

// ─── Wire envelopes (exact key order of the reference client) ───────────────

export interface FrozenRequest {
  readonly path: string;
  /** Exact serialized body; retries of the same logical write must reuse it. */
  readonly body: string;
  readonly bytes: number;
}

function freeze(path: string, wire: unknown, maxEnvelopeBytes: number | undefined): FrozenRequest {
  const cap = Math.min(CARD_ENVELOPE_MAX_BYTES, maxEnvelopeBytes ?? CARD_ENVELOPE_MAX_BYTES);
  if (!Number.isSafeInteger(cap) || cap <= 0) reject("invalid_request", "max_envelope_bytes");
  const body = JSON.stringify(wire);
  const bytes = byteLength(body);
  if (bytes > cap) reject("envelope_too_large", "envelope");
  return Object.freeze({ path, body, bytes });
}

export interface SendRegistryRequest {
  readonly route: CardRoute;
  readonly clientMsgNo: string;
  readonly ref: TemplateRef;
  readonly state: WireState;
  readonly data: RegistryData;
  readonly maxEnvelopeBytes?: number;
}

export interface EditRegistryRequest {
  readonly route: CardRoute;
  readonly messageId: string;
  readonly ref: TemplateRef;
  readonly state: WireState;
  readonly data: RegistryData;
  readonly seq: number;
  readonly transient: boolean;
  readonly maxEnvelopeBytes?: number;
}

export type SendAuthoredRequest = AuthoredCard & {
  readonly route: CardRoute;
  readonly clientMsgNo: string;
  readonly plain: string;
  readonly maxEnvelopeBytes?: number;
};

export type EditAuthoredRequest = AuthoredCard & {
  readonly route: CardRoute;
  readonly messageId: string;
  readonly plain: string;
  readonly seq: number;
  readonly transient: boolean;
  readonly maxEnvelopeBytes?: number;
};

function checkPlain(plain: string): string {
  return wireString(plain, "plain", "invalid_request");
}

export function serializeSendRegistry(req: SendRegistryRequest): FrozenRequest {
  const route = checkRoute(req.route);
  return freeze(ENDPOINTS.send, {
    channel_id: route.channel_id,
    channel_type: route.channel_type,
    payload: {
      type: CARD_MESSAGE_TYPE,
      template_ref: checkTemplateRef(req.ref),
      state: req.state,
      data: projectRegistryData(req.state, req.data),
    },
    client_msg_no: checkClientMsgNo(req.clientMsgNo),
  }, req.maxEnvelopeBytes);
}

export function serializeEditRegistry(req: EditRegistryRequest): FrozenRequest {
  const route = checkRoute(req.route);
  return freeze(ENDPOINTS.edit, {
    message_id: checkMessageId(req.messageId),
    channel_id: route.channel_id,
    channel_type: route.channel_type,
    template_ref: checkTemplateRef(req.ref),
    state: req.state,
    data: projectRegistryData(req.state, req.data),
    card_seq: checkSeq(req.seq),
    ...(req.transient === true ? { transient: true } : {}),
  }, req.maxEnvelopeBytes);
}

export function serializeSendAuthored(req: SendAuthoredRequest): FrozenRequest {
  const route = checkRoute(req.route);
  return freeze(ENDPOINTS.send, {
    channel_id: route.channel_id,
    channel_type: route.channel_type,
    payload: {
      type: CARD_MESSAGE_TYPE,
      card: projectAuthoredCard(req),
      profile: req.profile,
      card_version: CARD_VERSION,
      plain: checkPlain(req.plain),
    },
    client_msg_no: checkClientMsgNo(req.clientMsgNo),
  }, req.maxEnvelopeBytes);
}

/** `content_edit` is the serialized complete type-17 envelope; profile/card_seq live inside it. */
export function serializeEditAuthored(req: EditAuthoredRequest): FrozenRequest {
  const route = checkRoute(req.route);
  const contentEdit = JSON.stringify({
    type: CARD_MESSAGE_TYPE,
    card: projectAuthoredCard(req),
    profile: req.profile,
    card_version: CARD_VERSION,
    plain: checkPlain(req.plain),
    card_seq: checkSeq(req.seq),
    ...(req.transient === true ? { transient: true } : {}),
  });
  return freeze(ENDPOINTS.edit, {
    message_id: checkMessageId(req.messageId),
    channel_id: route.channel_id,
    channel_type: route.channel_type,
    content_edit: contentEdit,
  }, req.maxEnvelopeBytes);
}

// ─── Responses ──────────────────────────────────────────────────────────────

export interface SendAck {
  readonly messageId: string;
  readonly clientMsgNo: string;
  readonly messageSeq?: number;
  readonly request: FrozenRequest;
}

export interface EditAck {
  readonly messageId: string;
  readonly seq: number;
  readonly request: FrozenRequest;
}

/** Untrusted raw event envelope (`BotEvent`); owned-event parsing is a later package. */
export interface PolledEvent {
  readonly eventId: number;
  readonly eventType?: string;
  readonly eventData?: JsonObject;
  readonly message?: JsonObject;
}

export interface GroupMemberRef {
  readonly uid: string;
}

export interface PollOptions {
  /** Strictly-after cursor; defaults to 0. */
  readonly afterEventId?: number;
  readonly limit?: number;
  /** Long-poll hold in whole seconds; omitted from the wire when 0. */
  readonly waitSeconds?: number;
}

const RESPONSE_LIMITS: StrictJsonLimits = { maxDepth: 64, maxNodes: 200_000, unsafeIntegers: "preserve" };
const EVENT_TYPE = /^[A-Za-z0-9_.:-]{1,64}$/;

// ─── Client ─────────────────────────────────────────────────────────────────

/** Proven stale-sequence rejection recorded by P05a; absent means never classify `stale`. */
export interface StaleSequenceMatcher {
  readonly status: number;
  /** Top-level JSON field of the error body. */
  readonly field: string;
  readonly value: string | number;
}

export interface CardApiConfig {
  /** Trusted configured API base (existing allowed-origin policy applies). */
  readonly apiUrl: string;
  /** Bot credential; used only as the bearer for this base. */
  readonly credential: string;
  readonly fetchImpl?: typeof fetch;
  /** Wall clock for HTTP-date Retry-After values. */
  readonly nowUtcMs?: () => number;
  readonly staleSequence?: StaleSequenceMatcher;
}

export interface ApiCallOptions {
  readonly signal?: AbortSignal;
  /** Effective deadline; clamped to the 30 s ceiling. */
  readonly deadlineMs?: number;
}

export interface CardApi {
  readonly origin: NormalizedOrigin;
  getProfile(opts?: ApiCallOptions): Promise<CardProfileWire>;
  sendRegistry(req: SendRegistryRequest, opts?: ApiCallOptions): Promise<SendAck>;
  sendAuthored(req: SendAuthoredRequest, opts?: ApiCallOptions): Promise<SendAck>;
  editRegistry(req: EditRegistryRequest, opts?: ApiCallOptions): Promise<EditAck>;
  editAuthored(req: EditAuthoredRequest, opts?: ApiCallOptions): Promise<EditAck>;
  pollOwned(poll?: PollOptions, opts?: ApiCallOptions): Promise<readonly PolledEvent[]>;
  ack(eventId: number, opts?: ApiCallOptions): Promise<void>;
  getFreshMembers(groupNo: string, opts?: ApiCallOptions): Promise<readonly GroupMemberRef[]>;
}

/** Parse Retry-After (delta-seconds or IMF-fixdate) into a non-negative delay. */
export function parseRetryAfter(raw: string | null, nowUtcMs: number): number | undefined {
  if (raw === null) return undefined;
  const value = raw.trim();
  if (/^\d{1,10}$/.test(value)) return Number(value) * 1000;
  if (/^[A-Z][a-z]{2}, \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(value)) {
    const at = Date.parse(value);
    if (Number.isFinite(at)) return Math.max(0, at - nowUtcMs);
  }
  return undefined;
}

interface RawResponse {
  readonly status: number;
  readonly text: string;
}

export function createCardApi(config: CardApiConfig): CardApi {
  const base: ApiBase = parseApiBase(config.apiUrl);
  const baseUrl = apiBaseUrl(base);
  const credential = config.credential;
  if (typeof credential !== "string" || credential.length === 0 || credential.length > 4096
    || CONTROL_CHARS.test(credential) || /\s/.test(credential)) {
    throw new CardRequestError("invalid_request", "credential");
  }
  const fetchImpl = config.fetchImpl ?? fetch;
  const nowUtcMs = config.nowUtcMs ?? Date.now;
  const stale = config.staleSequence;

  async function readBounded(response: Response, maxBytes: number, op: ApiOperation, state: AbortState): Promise<string> {
    const declared = response.headers.get("content-length");
    if (declared !== null && /^\d+$/.test(declared) && Number(declared) > maxBytes) {
      await cancelBody(response);
      throw new OctoApiError(op, "response", response.status, "response_too_large");
    }
    if (response.body === null) return "";
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > maxBytes) {
          await reader.cancel().catch(() => undefined);
          throw new OctoApiError(op, "response", response.status, "response_too_large");
        }
        chunks.push(value);
      }
    } catch (err) {
      if (err instanceof OctoApiError) throw err;
      throw transportError(op, state);
    } finally {
      reader.releaseLock();
    }
    const joined = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) { joined.set(chunk, offset); offset += chunk.byteLength; }
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(joined);
    } catch {
      throw new OctoApiError(op, "response", response.status, "malformed_response");
    }
  }

  async function call(
    op: ApiOperation, method: "GET" | "POST", path: string, body: string | undefined,
    maxBytes: number, opts: ApiCallOptions | undefined,
  ): Promise<RawResponse> {
    const deadline = opts?.deadlineMs ?? CARD_API_DEADLINE_MS;
    if (typeof deadline !== "number" || !Number.isFinite(deadline) || deadline <= 0) {
      throw new CardRequestError("invalid_deadline", "deadline_ms");
    }
    const external = opts?.signal;
    if (external?.aborted) throw new OctoApiError(op, "abort", 0, "aborted");

    const controller = new AbortController();
    const state: AbortState = { timedOut: false, externallyAborted: false };
    const timer = setTimeout(() => { state.timedOut = true; controller.abort(); }, Math.min(deadline, CARD_API_DEADLINE_MS));
    const onAbort = (): void => { state.externallyAborted = true; controller.abort(); };
    external?.addEventListener("abort", onAbort, { once: true });
    try {
      const headers: Record<string, string> = {
        Authorization: `Bearer ${credential}`,
        Accept: "application/json",
      };
      if (body !== undefined) headers["Content-Type"] = "application/json";
      let response: Response;
      try {
        response = await fetchImpl(`${baseUrl}${path}`, {
          method, headers, body, redirect: "manual", signal: controller.signal, credentials: "omit",
        });
      } catch {
        throw transportError(op, state);
      }

      if (response.type === "opaqueredirect" || is3xx(response.status) || response.redirected
        || (response.url !== "" && !sameOriginUrl(response.url, base.origin))) {
        await cancelBody(response);
        throw new OctoApiError(op, "response", response.status, "redirect_refused");
      }
      const retryAfterMs = parseRetryAfter(response.headers.get("retry-after"), nowUtcMs());

      if (!is2xx(response.status)) {
        let code: OctoApiErrorCode = "http_status";
        if (stale !== undefined && (op === "edit_registry" || op === "edit_authored") && response.status === stale.status) {
          const errorText = await readBounded(response, ERROR_BODY_MAX_BYTES, op, state).catch(() => "");
          const parsed = parseStrictJson(errorText, { maxDepth: 8, maxNodes: 512, unsafeIntegers: "preserve" });
          if (parsed.ok && isJsonObject(parsed.value) && parsed.value[stale.field] === stale.value) code = "stale_sequence";
        } else {
          await cancelBody(response);
        }
        throw new OctoApiError(op, "response", response.status, code, retryAfterMs);
      }
      const text = await readBounded(response, maxBytes, op, state);
      return { status: response.status, text };
    } finally {
      clearTimeout(timer);
      external?.removeEventListener("abort", onAbort);
    }
  }

  function parseBody(op: ApiOperation, raw: RawResponse, allowEmpty: boolean): JsonValue | undefined {
    if (raw.text === "") {
      if (allowEmpty) return undefined;
      throw new OctoApiError(op, "response", raw.status, "malformed_response");
    }
    const parsed = parseStrictJson(raw.text, RESPONSE_LIMITS);
    if (!parsed.ok) throw new OctoApiError(op, "response", raw.status, "malformed_response");
    return parsed.value;
  }

  async function send(op: ApiOperation, request: FrozenRequest, clientMsgNo: string, opts?: ApiCallOptions): Promise<SendAck> {
    const raw = await call(op, "POST", request.path, request.body, ACK_BODY_MAX_BYTES, opts);
    const value = parseBody(op, raw, true);
    if (value === undefined || !isJsonObject(value)) throw new OctoApiError(op, "response", raw.status, "missing_identity");
    const messageId = parseMessageIdentity(value.message_id);
    if (messageId === null) throw new OctoApiError(op, "response", raw.status, "missing_identity");
    if (value.client_msg_no !== undefined && value.client_msg_no !== clientMsgNo) {
      throw new OctoApiError(op, "response", raw.status, "identity_mismatch");
    }
    const seq = value.message_seq;
    if (seq !== undefined && !(typeof seq === "number" && Number.isSafeInteger(seq) && seq >= 0)) {
      throw new OctoApiError(op, "response", raw.status, "malformed_response");
    }
    return Object.freeze({ messageId, clientMsgNo, ...(typeof seq === "number" ? { messageSeq: seq } : {}), request });
  }

  /**
   * §5.3: an edit is acknowledged only by a 2xx carrying the edited
   * `message_id` (and, if echoed, the same `card_seq`).
   */
  async function edit(op: ApiOperation, request: FrozenRequest, messageId: string, seq: number, opts?: ApiCallOptions): Promise<EditAck> {
    const raw = await call(op, "POST", request.path, request.body, ACK_BODY_MAX_BYTES, opts);
    const value = parseBody(op, raw, true);
    if (value === undefined || !isJsonObject(value)) throw new OctoApiError(op, "response", raw.status, "missing_identity");
    const echoed = parseMessageIdentity(value.message_id);
    if (echoed === null) throw new OctoApiError(op, "response", raw.status, "missing_identity");
    if (echoed !== messageId) throw new OctoApiError(op, "response", raw.status, "identity_mismatch");
    if (value.card_seq !== undefined && value.card_seq !== seq) {
      throw new OctoApiError(op, "response", raw.status, "identity_mismatch");
    }
    return Object.freeze({ messageId, seq, request });
  }

  const api: CardApi = {
    origin: base.origin,

    async getProfile(opts?: ApiCallOptions): Promise<CardProfileWire> {
      const raw = await call("get_profile", "GET", ENDPOINTS.profile, undefined, PROFILE_BODY_MAX_BYTES, opts);
      const parsed = parseStrictJson(raw.text, { maxDepth: 16, maxNodes: 10_000, unsafeIntegers: "reject" });
      if (!parsed.ok) throw new OctoApiError("get_profile", "response", raw.status, "malformed_response", undefined, "profile_shape");
      return projectCardProfile(parsed.value, raw.status);
    },

    sendRegistry(req, opts) {
      const request = serializeSendRegistry(req);
      return send("send_registry", request, req.clientMsgNo, opts);
    },

    sendAuthored(req, opts) {
      const request = serializeSendAuthored(req);
      return send("send_authored", request, req.clientMsgNo, opts);
    },

    editRegistry(req, opts) {
      const request = serializeEditRegistry(req);
      return edit("edit_registry", request, req.messageId, req.seq, opts);
    },

    editAuthored(req, opts) {
      const request = serializeEditAuthored(req);
      return edit("edit_authored", request, req.messageId, req.seq, opts);
    },

    async pollOwned(poll: PollOptions = {}, opts?: ApiCallOptions): Promise<readonly PolledEvent[]> {
      const after = poll.afterEventId ?? 0;
      const limit = poll.limit ?? 20;
      const wait = poll.waitSeconds ?? 0;
      if (!Number.isSafeInteger(after) || after < 0) throw new CardRequestError("invalid_request", "event_id");
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_EVENT_LIMIT) throw new CardRequestError("invalid_request", "limit");
      if (!Number.isSafeInteger(wait) || wait < 0 || wait > MAX_EVENT_WAIT_SECONDS) throw new CardRequestError("invalid_request", "wait");
      const deadline = Math.min(opts?.deadlineMs ?? CARD_API_DEADLINE_MS, CARD_API_DEADLINE_MS);
      if (wait > 0 && wait * 1000 >= deadline) throw new CardRequestError("invalid_deadline", "wait");
      const body = JSON.stringify({ event_id: after, limit, ...(wait > 0 ? { wait } : {}) });
      const raw = await call("poll_owned", "POST", ENDPOINTS.events, body, EVENTS_BODY_MAX_BYTES, opts);
      const value = parseBody("poll_owned", raw, false);
      if (!isJsonObject(value)) throw new OctoApiError("poll_owned", "response", raw.status, "malformed_response");
      if (value.results === undefined) return Object.freeze([]);
      if (!Array.isArray(value.results) || value.results.length > limit) {
        throw new OctoApiError("poll_owned", "response", raw.status, "malformed_response");
      }
      const events: PolledEvent[] = [];
      for (const item of value.results as readonly JsonValue[]) {
        if (!isJsonObject(item)) throw new OctoApiError("poll_owned", "response", raw.status, "malformed_response");
        const id = item.event_id;
        const type = item.event_type;
        const data = item.event_data;
        const message = item.message;
        if (typeof id !== "number" || !Number.isSafeInteger(id) || id < 0
          || (type !== undefined && (typeof type !== "string" || !EVENT_TYPE.test(type)))
          || (data !== undefined && !isJsonObject(data))
          || (message !== undefined && !isJsonObject(message))) {
          throw new OctoApiError("poll_owned", "response", raw.status, "malformed_response");
        }
        events.push(Object.freeze({
          eventId: id,
          ...(type !== undefined ? { eventType: type as string } : {}),
          ...(data !== undefined ? { eventData: data as JsonObject } : {}),
          ...(message !== undefined ? { message: message as JsonObject } : {}),
        }));
      }
      return Object.freeze(events);
    },

    async ack(eventId: number, opts?: ApiCallOptions): Promise<void> {
      if (!Number.isSafeInteger(eventId) || eventId < 0) throw new CardRequestError("invalid_request", "event_id");
      await call("ack", "POST", `${ENDPOINTS.events}/${eventId}/ack`, "{}", ACK_BODY_MAX_BYTES, opts);
    },

    async getFreshMembers(groupNo: string, opts?: ApiCallOptions): Promise<readonly GroupMemberRef[]> {
      // `.` and `..` survive encodeURIComponent and would be normalized away as dot segments.
      if (typeof groupNo !== "string" || groupNo.trim() === "" || groupNo.length > 256
        || groupNo === "." || groupNo === ".."
        || CONTROL_CHARS.test(groupNo) || LONE_SURROGATE.test(groupNo)) {
        throw new CardRequestError("invalid_request", "group_no");
      }
      const raw = await call("get_fresh_members", "GET", `/v1/bot/groups/${encodeURIComponent(groupNo)}/members`,
        undefined, MEMBERS_BODY_MAX_BYTES, opts);
      const value = parseBody("get_fresh_members", raw, false);
      const list = Array.isArray(value) ? value
        : isJsonObject(value) && Array.isArray(value.members) ? value.members : null;
      if (list === null || list.length > MAX_MEMBERS) {
        throw new OctoApiError("get_fresh_members", "response", raw.status, "malformed_response");
      }
      const members: GroupMemberRef[] = [];
      for (const item of list as readonly JsonValue[]) {
        if (!isJsonObject(item) || typeof item.uid !== "string" || item.uid.trim() === "" || item.uid.length > 256) {
          throw new OctoApiError("get_fresh_members", "response", raw.status, "malformed_response");
        }
        members.push(Object.freeze({ uid: item.uid }));
      }
      return Object.freeze(members);
    },
  };
  return Object.freeze(api);
}

interface AbortState {
  timedOut: boolean;
  externallyAborted: boolean;
}

function transportError(op: ApiOperation, state: AbortState): OctoApiError {
  if (state.externallyAborted) return new OctoApiError(op, "abort", 0, "aborted");
  if (state.timedOut) return new OctoApiError(op, "timeout", 0, "timeout");
  return new OctoApiError(op, "network", 0, "network");
}

async function cancelBody(response: Response): Promise<void> {
  try { await response.body?.cancel(); } catch { /* body already settled */ }
}

function sameOriginUrl(url: string, origin: NormalizedOrigin): boolean {
  try {
    return normalizeOrigin(url).key === origin.key;
  } catch {
    return false;
  }
}
