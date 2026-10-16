/**
 * `EvidenceRecord` / `SourceAttestation` validators and evidence binding
 * (§4.1–§4.3, §4.5, §4.6).
 *
 * Records are closed, bounded and content-free. Diagnostics carry a path of
 * `/` or `/<known field>` and a closed rule only — never input bytes, key
 * spellings or values. At most 16 diagnostics are returned.
 */

import type { Diag } from "./contracts.js";
import { normalizeOrigin, OriginPolicyError } from "./origin.js";
import { MAX_DIAGNOSTICS } from "./protocol.js";
import type { JsonObject, JsonValue } from "./contracts.js";
import {
  ATTESTABLE_LEVELS, RECORDABLE_LEVELS, acceptanceRow, type AcceptanceLevel,
} from "./telemetry-acceptance.js";
import {
  ARTIFACT_REF_PATTERN, CHANNEL_REF_PATTERN, COMMENT_REF_PATTERN, SHA40_PATTERN, SHA256_HEX_PATTERN, isIsoUtc,
  utf8Bytes,
} from "./telemetry-grammar.js";
import { BOT_REF_PATTERN, ROUTE_TYPES } from "./telemetry-registry.js";
import { parseRecordText, type EvidenceRule } from "./telemetry-records.js";

// ─── Field grammars (§4.3) ──────────────────────────────────────────────────

const N = "(?:0|[1-9][0-9]*)";
const PR = "(?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*)";
const BLD = "[0-9A-Za-z-]+";
const SV = `${N}\\.${N}\\.${N}(?:-${PR}(?:\\.${PR})*)?(?:\\+${BLD}(?:\\.${BLD})*)?`;

export const SEMVER_PATTERN = new RegExp(`^${SV}$`);
export const SUB_ID_PATTERN = /^AC-0(0[1-9]|1[0-9]|2[0-5])\.[0-9]{1,2}$/;
export const PROBE_PATTERN = /^P(0[1-9]|10)$/;
export const NODE_VERSION_PATTERN = /^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;
export const TEMPLATE_FINGERPRINT_PATTERN = /^ai\.reasoning-process@([0-9A-Za-z][0-9A-Za-z._+-]{0,63})#[0-9a-f]{64}$/;
export const FIXTURE_REVISION_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}@([0-9a-f]{40}|v[1-9][0-9]{0,5})$/;
export const HARNESS_IDENTITY_PATTERN = new RegExp(`^[a-z0-9][a-z0-9._-]{0,63}@(?:[0-9a-f]{40}|${SV})$`);
const EVIDENCE_REF_PATTERN = new RegExp(`${ARTIFACT_REF_PATTERN.source}|${COMMENT_REF_PATTERN.source}`);

const SPAN_MAX_MS = 2_592_000_000;
const SAFE_TEXT_MAX_BYTES = 512;

// ─── SafeText (§4.3) ────────────────────────────────────────────────────────

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
const FORBIDDEN_CHARS = /[\p{Cc}\p{Cf}\p{Co}\p{Cn}\u2028\u2029]/u;
const EDGE_WHITESPACE = /^\s|\s$/;

/** Defense-in-depth secret/locator shapes; email addresses and lowercase `password=…` deliberately pass. */
export const SECRET_SHAPES: readonly RegExp[] = Object.freeze([
  /:\/\//,
  /\b[A-Za-z0-9._%+-]+:[^\s@]+@/,
  /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\./,
  /\b[A-Z][A-Z0-9_]{1,}=\S/,
  /sk-/, /ghp_/, /gho_/, /github_pat_/, /xox[abprs]-/, /AKIA[0-9A-Z]{16}/, /-----BEGIN/,
  /[0-9a-fA-F]{32,}/,
  /[A-Za-z0-9+/_-]{32,}={0,2}/,
  /(^|\s)(\/|~\/|\.\.?\/|[A-Za-z]:\\|\\\\)/,
]);

export const hasSecretShape = (s: string): boolean => SECRET_SHAPES.some((re) => re.test(s));

/** Returns the first SafeText rule violated, or null when `s` is SafeText. */
export function safeTextRule(s: unknown): EvidenceRule | null {
  if (s === null) return "null_value";
  if (typeof s !== "string") return "wrong_type";
  if (LONE_SURROGATE.test(s)) return "forbidden_char";
  const bytes = utf8Bytes(s);
  if (bytes > SAFE_TEXT_MAX_BYTES) return "too_long";
  if (bytes < 1) return "grammar";
  if (s !== s.normalize("NFC")) return "not_nfc";
  if (FORBIDDEN_CHARS.test(s)) return "forbidden_char";
  if (EDGE_WHITESPACE.test(s)) return "grammar";
  if (hasSecretShape(s)) return "secret_shape";
  return null;
}

export function isSafeText(s: unknown): s is string {
  return safeTextRule(s) === null;
}

// ─── Record shapes (A6, §4.1) ───────────────────────────────────────────────

export type EvidenceResult = "pass" | "fail" | "unverified" | "n/a";
export type RecordableLevel = (typeof RECORDABLE_LEVELS)[number];
export type AttestableLevel = (typeof ATTESTABLE_LEVELS)[number];

export interface EvidenceRecord {
  readonly subId: string;
  readonly level: RecordableLevel;
  readonly probe?: string;
  readonly candidateSha: string;
  readonly frozenBaselineSha: string;
  readonly codexSdkVersion: string;
  readonly codexCliVersion: string;
  readonly nodeVersion: string;
  readonly apiOrigin: string;
  readonly profileHash: string;
  readonly templateFingerprint?: string;
  readonly botRef: string;
  readonly channelRef: string;
  readonly routeType: "dm" | "group" | "topic";
  readonly startUtc: string;
  readonly endUtc: string;
  readonly fixtureRevision: string;
  readonly harnessIdentity: string;
  readonly topologyRef?: string;
  readonly clockRef?: string;
  readonly faultRef?: string;
  readonly result: EvidenceResult;
  readonly rationale?: string;
  readonly ownerApprovalRef?: string;
}

export interface SourceAttestation {
  readonly subId: string;
  readonly level: AttestableLevel;
  readonly candidateSha: string;
  readonly frozenBaselineSha: string;
  readonly codexSdkVersion: string;
  readonly codexCliVersion: string;
  readonly nodeVersion: string;
  readonly suiteRef: string;
  readonly startUtc: string;
  readonly endUtc: string;
  readonly harnessIdentity: string;
  readonly fixtureRevision: string;
  readonly result: EvidenceResult;
  readonly rationale?: string;
  readonly ownerApprovalRef?: string;
}

// ─── Binding (§4.6) ─────────────────────────────────────────────────────────

export interface RuntimeTuple {
  readonly codexSdkVersion: string;
  readonly codexCliVersion: string;
  readonly nodeVersion: string;
}
export interface EnvironmentTuple {
  readonly runtime: RuntimeTuple;
  readonly apiOrigin: string;
  readonly profileHash: string;
  readonly templateFingerprint?: string;
}
export interface EvidenceBinding {
  readonly candidateSha: string;
  readonly frozenBaselineSha: string;
  readonly sourceRuntimes: readonly RuntimeTuple[];
  /** Keyed by the per-incarnation `botRef`. */
  readonly environments: ReadonlyMap<string, EnvironmentTuple>;
}

const runtimeValid = (r: unknown): r is RuntimeTuple => {
  if (r === null || typeof r !== "object") return false;
  const t = r as Record<string, unknown>;
  return typeof t.codexSdkVersion === "string" && utf8Bytes(t.codexSdkVersion) <= 64 && SEMVER_PATTERN.test(t.codexSdkVersion)
    && typeof t.codexCliVersion === "string" && utf8Bytes(t.codexCliVersion) <= 64 && SEMVER_PATTERN.test(t.codexCliVersion)
    && typeof t.nodeVersion === "string" && utf8Bytes(t.nodeVersion) <= 24 && NODE_VERSION_PATTERN.test(t.nodeVersion);
};

/** Structural check of a trusted binding; an invalid binding binds nothing. */
export function evidenceBindingValid(binding: unknown): binding is EvidenceBinding {
  try {
    if (binding === null || typeof binding !== "object") return false;
    const b = binding as Record<string, unknown>;
    if (typeof b.candidateSha !== "string" || !SHA40_PATTERN.test(b.candidateSha)) return false;
    if (typeof b.frozenBaselineSha !== "string" || !SHA40_PATTERN.test(b.frozenBaselineSha)) return false;
    if (!Array.isArray(b.sourceRuntimes) || !b.sourceRuntimes.every(runtimeValid)) return false;
    if (!(b.environments instanceof Map)) return false;
    for (const [botRef, env] of b.environments as Map<unknown, unknown>) {
      if (typeof botRef !== "string" || !BOT_REF_PATTERN.test(botRef)) return false;
      if (env === null || typeof env !== "object") return false;
      const e = env as Record<string, unknown>;
      if (!runtimeValid(e.runtime) || typeof e.apiOrigin !== "string" || canonicalOriginRule(e.apiOrigin) !== null) return false;
      if (typeof e.profileHash !== "string" || !SHA256_HEX_PATTERN.test(e.profileHash)) return false;
      if (e.templateFingerprint !== undefined && (typeof e.templateFingerprint !== "string"
        || !TEMPLATE_FINGERPRINT_PATTERN.test(e.templateFingerprint))) return false;
    }
    return true;
  } catch {
    return false;
  }
}

export const sameRuntime = (a: RuntimeTuple, b: RuntimeTuple): boolean =>
  a.codexSdkVersion === b.codexSdkVersion && a.codexCliVersion === b.codexCliVersion && a.nodeVersion === b.nodeVersion;

/** Every environment runtime must be one of the source runtimes; otherwise `binding_missing`. */
export function environmentRuntimesCovered(binding: EvidenceBinding): boolean {
  for (const env of binding.environments.values()) {
    if (!binding.sourceRuntimes.some((r) => sameRuntime(r, env.runtime))) return false;
  }
  return true;
}

// ─── Validation ─────────────────────────────────────────────────────────────

export type EvidenceValidation<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly diagnostics: readonly Diag[] };

type FieldCheck = (value: JsonValue) => EvidenceRule | null;

/** `not_canonical_origin` unless `normalizeOrigin(value).key === value`; other throws propagate. */
export function canonicalOriginRule(value: string): EvidenceRule | null {
  try {
    return normalizeOrigin(value).key === value ? null : "not_canonical_origin";
  } catch (err) {
    if (err instanceof OriginPolicyError) return "not_canonical_origin";
    throw err;
  }
}

const pattern = (re: RegExp, maxBytes: number): FieldCheck => (v) => {
  if (typeof v !== "string") return "wrong_type";
  if (utf8Bytes(v) > maxBytes) return "too_long";
  return re.test(v) ? null : "grammar";
};
const oneOf = (values: readonly string[], maxBytes: number): FieldCheck => pattern(new RegExp(`^(?:${values.map((x) => x.replace(/[/.]/g, "\\$&")).join("|")})$`), maxBytes);

const templateFingerprint: FieldCheck = (v) => {
  const base = pattern(TEMPLATE_FINGERPRINT_PATTERN, 150)(v);
  if (base !== null) return base;
  const tv = TEMPLATE_FINGERPRINT_PATTERN.exec(v as string)![1];
  return hasSecretShape(tv) ? "secret_shape" : null;
};
const apiOrigin: FieldCheck = (v) => {
  if (typeof v !== "string") return "wrong_type";
  if (utf8Bytes(v) > 280) return "too_long";
  return canonicalOriginRule(v);
};
const utcField: FieldCheck = (v) => {
  if (typeof v !== "string") return "wrong_type";
  if (utf8Bytes(v) > 24) return "too_long";
  return isIsoUtc(v) ? null : "grammar";
};

const ALL_LEVELS: readonly string[] = [...RECORDABLE_LEVELS, ...ATTESTABLE_LEVELS];
const levelField: FieldCheck = (v) => {
  if (typeof v !== "string") return "wrong_type";
  if (utf8Bytes(v) > 13) return "too_long";
  return ALL_LEVELS.includes(v) ? null : "grammar";
};
const subIdField: FieldCheck = (v) => {
  const base = pattern(SUB_ID_PATTERN, 9)(v);
  if (base !== null) return base;
  return acceptanceRow(v) ? null : "unknown_sub_id";
};

const COMMON: Readonly<Record<string, FieldCheck>> = {
  subId: subIdField,
  level: levelField,
  candidateSha: pattern(SHA40_PATTERN, 40),
  frozenBaselineSha: pattern(SHA40_PATTERN, 40),
  codexSdkVersion: pattern(SEMVER_PATTERN, 64),
  codexCliVersion: pattern(SEMVER_PATTERN, 64),
  nodeVersion: pattern(NODE_VERSION_PATTERN, 24),
  startUtc: utcField,
  endUtc: utcField,
  fixtureRevision: pattern(FIXTURE_REVISION_PATTERN, 105),
  harnessIdentity: pattern(HARNESS_IDENTITY_PATTERN, 129),
  result: oneOf(["pass", "fail", "unverified", "n/a"], 10),
  rationale: safeTextRule as FieldCheck,
  ownerApprovalRef: pattern(COMMENT_REF_PATTERN, 63),
};

const RECORD_FIELDS: Readonly<Record<string, FieldCheck>> = {
  ...COMMON,
  probe: pattern(PROBE_PATTERN, 3),
  apiOrigin,
  profileHash: pattern(SHA256_HEX_PATTERN, 64),
  templateFingerprint,
  botRef: pattern(BOT_REF_PATTERN, 17),
  channelRef: pattern(CHANNEL_REF_PATTERN, 17),
  routeType: oneOf(ROUTE_TYPES, 5),
  topologyRef: pattern(EVIDENCE_REF_PATTERN, 145),
  clockRef: pattern(EVIDENCE_REF_PATTERN, 145),
  faultRef: pattern(EVIDENCE_REF_PATTERN, 145),
};
const RECORD_OPTIONAL = new Set(["probe", "templateFingerprint", "topologyRef", "clockRef", "faultRef", "rationale", "ownerApprovalRef"]);

const ATTESTATION_FIELDS: Readonly<Record<string, FieldCheck>> = {
  ...COMMON,
  suiteRef: pattern(ARTIFACT_REF_PATTERN, 145),
};
const ATTESTATION_OPTIONAL = new Set(["rationale", "ownerApprovalRef"]);

class Diagnostics {
  private readonly list: Diag[] = [];
  private readonly seen = new Set<string>();
  add(path: string, rule: EvidenceRule): void {
    const key = `${path}\0${rule}`;
    if (this.seen.has(key) || this.list.length >= MAX_DIAGNOSTICS) return;
    this.seen.add(key);
    this.list.push(Object.freeze({ path, rule }));
  }
  get size(): number { return this.list.length; }
  done(): readonly Diag[] { return Object.freeze([...this.list]); }
}

type Form = "record" | "attestation";

function validateForm(raw: unknown, form: Form, binding: EvidenceBinding | undefined): EvidenceValidation<JsonObject> {
  try {
    return checkForm(raw, form, binding);
  } catch {
    // Any unexpected throw is a closed structural rule; the thrown value is never read.
    return { ok: false, diagnostics: Object.freeze([Object.freeze({ path: "/", rule: "malformed_json" })]) };
  }
}

function checkForm(raw: unknown, form: Form, binding: EvidenceBinding | undefined): EvidenceValidation<JsonObject> {
  const diags = new Diagnostics();
  let o: JsonObject;
  try {
    o = parseRecordText(raw, 2, 64);
  } catch (err) {
    const rule = err !== null && typeof err === "object" && "rule" in err ? (err as { rule: EvidenceRule }).rule : "malformed_json";
    diags.add("/", rule);
    return { ok: false, diagnostics: diags.done() };
  }
  const fields = form === "record" ? RECORD_FIELDS : ATTESTATION_FIELDS;
  const optional = form === "record" ? RECORD_OPTIONAL : ATTESTATION_OPTIONAL;
  for (const key of Object.keys(o)) if (!Object.hasOwn(fields, key)) diags.add("/", "unknown_field");
  const valid = new Set<string>();
  for (const [key, check] of Object.entries(fields)) {
    const path = `/${key}`;
    if (!Object.hasOwn(o, key)) {
      if (!optional.has(key)) diags.add(path, "missing_field");
      continue;
    }
    const v = o[key];
    const rule = v === null ? "null_value" : check(v);
    if (rule === null) valid.add(key);
    else diags.add(path, rule);
  }

  // Level rules (§4.1).
  if (valid.has("level")) {
    const level = o.level as AcceptanceLevel;
    const own: readonly string[] = form === "record" ? RECORDABLE_LEVELS : ATTESTABLE_LEVELS;
    const wrongRule: EvidenceRule = form === "record" ? "level_not_recordable" : "level_not_attestable";
    if (!own.includes(level)) diags.add("/level", wrongRule);
    else if (valid.has("subId")) {
      const declared = acceptanceRow(o.subId)!.declaredLevel;
      if (!own.includes(declared)) diags.add("/subId", wrongRule);
      else if (declared !== level) diags.add("/level", "level_mismatch");
    }
  }
  // Time rules.
  if (valid.has("startUtc") && valid.has("endUtc")) {
    const s = Date.parse(o.startUtc as string);
    const e = Date.parse(o.endUtc as string);
    if (s > e) diags.add("/endUtc", "time_order");
    else if (e - s > SPAN_MAX_MS) diags.add("/endUtc", "span_exceeded");
  }
  // n/a needs both a rationale and an owner approval reference.
  if (o.result === "n/a" && (!valid.has("rationale") || !valid.has("ownerApprovalRef"))) diags.add("/result", "na_requires_approval");

  if (diags.size === 0 && binding !== undefined) bindForm(o, form, binding, diags);
  return diags.size === 0 ? { ok: true, value: o } : { ok: false, diagnostics: diags.done() };
}

function bindForm(o: JsonObject, form: Form, binding: EvidenceBinding, diags: Diagnostics): void {
  if (!evidenceBindingValid(binding)) { diags.add("/", "binding_missing"); return; }
  // A changed SHA invalidates evidence (A7).
  if (o.candidateSha !== binding.candidateSha) diags.add("/candidateSha", "binding_mismatch");
  if (o.frozenBaselineSha !== binding.frozenBaselineSha) diags.add("/frozenBaselineSha", "binding_mismatch");
  const runtime: RuntimeTuple = {
    codexSdkVersion: o.codexSdkVersion as string, codexCliVersion: o.codexCliVersion as string, nodeVersion: o.nodeVersion as string,
  };
  if (form === "attestation") {
    if (!binding.sourceRuntimes.some((r) => sameRuntime(r, runtime))) diags.add("/codexSdkVersion", "binding_mismatch");
    return;
  }
  const env = binding.environments.get(o.botRef as string);
  if (env === undefined) { diags.add("/botRef", "binding_missing"); return; }
  // The candidate's runtime, never the harness's.
  if (env.runtime.codexSdkVersion !== runtime.codexSdkVersion) diags.add("/codexSdkVersion", "binding_mismatch");
  if (env.runtime.codexCliVersion !== runtime.codexCliVersion) diags.add("/codexCliVersion", "binding_mismatch");
  if (env.runtime.nodeVersion !== runtime.nodeVersion) diags.add("/nodeVersion", "binding_mismatch");
  if (env.apiOrigin !== o.apiOrigin) diags.add("/apiOrigin", "binding_mismatch");
  if (env.profileHash !== o.profileHash) diags.add("/profileHash", "binding_mismatch");
  if ((env.templateFingerprint !== undefined || Object.hasOwn(o, "templateFingerprint"))
    && env.templateFingerprint !== o.templateFingerprint) diags.add("/templateFingerprint", "binding_mismatch");
  if (!environmentRuntimesCovered(binding)) diags.add("/", "binding_missing");
}

function freezeRecord<T>(o: JsonObject, keys: readonly string[]): T {
  const out: Record<string, JsonValue> = {};
  for (const key of keys) if (Object.hasOwn(o, key)) out[key] = o[key];
  return Object.freeze(out) as T;
}

/** Validates an `EvidenceRecord` (maxDepth 2, maxNodes 64, ≤ 4096 B); with a binding, also binds it (§4.6). */
export function validateEvidenceRecord(raw: unknown, binding?: EvidenceBinding): EvidenceValidation<EvidenceRecord> {
  const r = validateForm(raw, "record", binding);
  return r.ok ? { ok: true, value: freezeRecord<EvidenceRecord>(r.value, Object.keys(RECORD_FIELDS)) } : r;
}

/** Validates a `SourceAttestation` (maxDepth 2, maxNodes 64, ≤ 4096 B); with a binding, also binds it (§4.6). */
export function validateSourceAttestation(raw: unknown, binding?: EvidenceBinding): EvidenceValidation<SourceAttestation> {
  const r = validateForm(raw, "attestation", binding);
  return r.ok ? { ok: true, value: freezeRecord<SourceAttestation>(r.value, Object.keys(ATTESTATION_FIELDS)) } : r;
}
