/** Semantic validation of the closed C.1 interactive grammar. No decision fitting. */
import type { ButtonData, CardError, Diag, InputSpec, InteractiveCardArgs, JsonValue } from './contracts.js';
import { neutralizeMentions, redactAuthored } from './display-schema.js';
import { canonicalJson, isReservedAuthorKey, parseRequestFrame } from './protocol.js';
import { SUPPORTED_TZ_VERSIONS, runtimeTzVersion, type TzVersionReader } from './tz-support.js';

export type InteractiveError = { readonly code: CardError; readonly diagnostics: readonly Diag[] };
export type InteractiveSchemaResult = { readonly ok: true; readonly value: InteractiveCardArgs } | { readonly ok: false; readonly error: InteractiveError };
export function freezeInteractive<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const v of Object.values(value)) freezeInteractive(v);
    Object.freeze(value);
  }
  return value;
}
export function interactiveFailure(code: CardError, path: string, rule: string): { readonly ok: false; readonly error: InteractiveError } {
  return freezeInteractive({ ok: false as const, error: { code, diagnostics: [{ path, rule }] } });
}
const ID = /^[A-Za-z0-9_.:-]{1,64}$/;
const LONE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
const CONTROL = /\p{Cf}|(?!\n)\p{Cc}/gu;
const reserved = (s: string): boolean => isReservedAuthorKey(s) || ['__proto__', 'constructor', 'prototype'].includes(s)
  || /^reasoning[_.:-]?(?:stop|retry)$/i.test(s) || /^(?:stop|retry|cancel)$/i.test(s);

/** A zone is validated independently; date and time fields are never paired. */
export function timezoneRule(zone: string, reader: TzVersionReader): string | undefined {
  let version: unknown;
  try { version = reader(); } catch { return 'timezone_db_unavailable'; }
  if (typeof version !== 'string' || version === '') return 'timezone_db_unavailable';
  if (!SUPPORTED_TZ_VERSIONS.has(version)) return 'timezone_db_unsupported';
  // Exclude numeric offsets accepted by newer Intl implementations. UTC is a tzdb name.
  if (!/^(?:[A-Za-z][A-Za-z0-9_+-]*)(?:\/[A-Za-z0-9_+-]+)*$/.test(zone)) return 'timezone_invalid';
  try { new Intl.DateTimeFormat('en-US', { timeZone: zone }).format(0); } catch { return 'timezone_invalid'; }
  return undefined;
}

export function validateInteractiveArgs(args: InteractiveCardArgs, options: { readonly tzVersion?: TzVersionReader } = {}): InteractiveSchemaResult {
  // Reuse the structural grammar at the handler boundary as well as the IPC boundary.
  let parsed: ReturnType<typeof parseRequestFrame>;
  try {
    parsed = parseRequestFrame(Buffer.from(JSON.stringify({ v: 1, request_id: '0'.repeat(32), authority: '0'.repeat(64), op: 'interactive', args })));
  } catch { return interactiveFailure('validation_failed', '$', 'invalid'); }
  if (!parsed.ok) return parsed.stage === 'args' ? freezeInteractive({ ok: false, error: { code: parsed.code, diagnostics: parsed.diagnostics } }) : interactiveFailure('validation_failed', '$', 'invalid');
  const source = parsed.frame.args as InteractiveCardArgs;
  let fault: ReturnType<typeof interactiveFailure> | undefined;
  const fail = (path: string, rule: string, limit = false): void => { fault ??= interactiveFailure(limit ? 'limit_exceeded' : 'validation_failed', path, rule); };
  const text = (s: string, path: string, label = false, nonempty = true): string => {
    if (LONE.test(s)) fail(path, 'invalid_unicode');
    const literal = neutralizeMentions(redactAuthored(s.replace(CONTROL, '').normalize('NFC')));
    const normalized = label ? literal.trim() : literal;
    if (nonempty && normalized.trim() === '') fail(path, label ? 'label_nonempty' : 'text_nonempty');
    if (label && ([...normalized].length > 80 || Buffer.byteLength(normalized) > 320)) fail(path, 'label_length');
    return normalized;
  };
  const id = (s: string, path: string, ids: Set<string>): void => {
    if (!ID.test(s)) fail(path, 'id_invalid');
    if (redactAuthored(s) !== s) fail(path, 'id_unsafe');
    if (reserved(s)) fail(path, 'id_reserved');
    if (ids.has(s)) fail(path, 'id_duplicate');
    ids.add(s);
  };
  const title = text(source.title, '$.title', true);
  const request = source.text === undefined ? undefined : text(source.text, '$.text');
  const sections = source.sections?.map((s, i) => ({ text: text(s.text, `$.sections[${i}].text`) }));
  const inputIds = new Set<string>();
  let blocks = sections?.length ?? 0;
  const inputs = source.inputs?.map((spec, i): InputSpec => {
    const p = `$.inputs[${i}]`;
    id(spec.id, `${p}.id`, inputIds);
    const label = text(spec.label, `${p}.label`, true);
    switch (spec.kind) {
      case 'text': {
        const min = Math.max(spec.required ? 1 : 0, spec.minLength ?? 0), max = Math.min(spec.maxLength ?? 4096, 4096);
        if ((spec.minLength ?? 0) < 0 || max < min) fail(p, 'range_order');
        return { ...spec, label, minLength: min, maxLength: max };
      }
      case 'number': if (spec.min > spec.max) fail(p, 'range_order'); break;
      case 'date': case 'time': {
        if (spec.timezone !== undefined) {
          const rule = timezoneRule(spec.timezone, options.tzVersion ?? runtimeTzVersion);
          if (rule) fail(`${p}.timezone`, rule);
        }
        break;
      }
      case 'choice': {
        blocks += spec.options.length;
        if (spec.options.length < 1 || spec.options.length > 20) fail(`${p}.options`, 'choice_count', true);
        if (spec.min < 0 || spec.min > spec.max || spec.max > spec.options.length || (!spec.multiple && spec.max !== 1)
          || (spec.required ? spec.min < 1 : spec.min !== 0)) fail(p, 'range_order');
        const ids = new Set<string>(), labels = new Set<string>();
        const options = spec.options.map((o, j) => {
          const q = `${p}.options[${j}]`;
          id(o.id, `${q}.id`, ids);
          const label = text(o.label, `${q}.label`, true);
          if (labels.has(label)) fail(`${q}.label`, 'label_duplicate');
          labels.add(label);
          return { id: o.id, label };
        });
        return { ...spec, label, options };
      }
    }
    return { ...spec, label };
  });
  const buttonIds = new Set<string>();
  const cleanData = (v: JsonValue, p: string): JsonValue => {
    if (typeof v === 'string') return text(v, p, false, false);
    if (Array.isArray(v)) return v.map(item => cleanData(item, p));
    if (v !== null && typeof v === 'object') {
      const out: Record<string, JsonValue> = {};
      for (const [key, value] of Object.entries(v)) {
        // Keys are application data, never diagnostics. Reject unsafe keys rather than rewrite them.
        if (reserved(key) || LONE.test(key) || key.normalize('NFC') !== key || /[\p{Cc}\p{Cf}@]/u.test(key) || redactAuthored(key) !== key) fail(p, 'data_key_invalid');
        out[key] = cleanData(value, p);
      }
      return out;
    }
    return v;
  };
  const buttons = source.buttons.map((b, i) => {
    const p = `$.buttons[${i}]`;
    id(b.id, `${p}.id`, buttonIds);
    return { id: b.id, label: text(b.label, `${p}.label`, true), ...(b.data !== undefined ? { data: cleanData(b.data, `${p}.data`) as ButtonData } : {}) };
  });
  if (buttons.length < 1 || buttons.length > 6) fail('$.buttons', 'button_count', true);
  if ((inputs?.length ?? 0) > 5) fail('$.inputs', 'input_count', true);
  if (blocks > 20) fail('$', 'section_option_count', true);
  if (buttons.reduce((n, b) => n + (b.data === undefined ? 0 : Buffer.byteLength(canonicalJson(b.data))), 0) > 2048) fail('$.buttons', 'data_bytes', true);
  if (fault) return fault;
  return freezeInteractive({ ok: true, value: { title, ...(request !== undefined ? { text: request } : {}), ...(sections ? { sections } : {}), ...(inputs ? { inputs } : {}), buttons } });
}
