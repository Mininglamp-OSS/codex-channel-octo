/** Typed callback validation only; this module never admits or dispatches work. */
import type { InputSpec, JsonObject, JsonValue, Limits } from './contracts.js';
import { hasSecretShape } from './redact.js';
import { freezeInteractive, interactiveFailure, timezoneRule } from './interactive-schema.js';
import { normalizeLimits } from './limits.js';
import { runtimeTzVersion, type TzVersionReader } from './tz-support.js';

function validDate(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [y, m, d] = s.split('-').map(Number);
  const leap = y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0);
  return y >= 1 && m >= 1 && m <= 12 && d >= 1 && d <= [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1];
}
export function createInputNormalizer(options: { readonly tzVersion?: TzVersionReader; readonly limits?: Limits } = {}) {
  const reader = options.tzVersion ?? runtimeTzVersion;
  const defaults = normalizeLimits(undefined).limits;
  const maxText = Math.min(defaults.maxInputTextBytes, options.limits?.maxInputTextBytes ?? defaults.maxInputTextBytes);
  const maxBytes = Math.min(defaults.maxInputsBytes, options.limits?.maxInputsBytes ?? defaults.maxInputsBytes);
  return (specs: readonly InputSpec[], raw: unknown): { readonly ok: true; readonly value: JsonObject } | ReturnType<typeof interactiveFailure> => {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw) || ![null, Object.prototype].includes(Object.getPrototypeOf(raw))) return interactiveFailure('validation_failed', '$', 'inputs_object');
    const values = raw as Record<string, unknown>;
    if (Object.keys(values).some(id => !specs.some(s => s.id === id))) return interactiveFailure('validation_failed', '$', 'unknown_input');
    let serialized: string;
    try { serialized = JSON.stringify(values); } catch { return interactiveFailure('validation_failed', '$', 'inputs_object'); }
    if (Buffer.byteLength(serialized) > maxBytes) return interactiveFailure('limit_exceeded', '$', 'inputs_bytes');
    const out: Record<string, JsonValue> = {};
    for (const [i, s] of specs.entries()) {
      const p = `$.inputs[${i}]`;
      if ((s.kind === 'date' || s.kind === 'time') && s.timezone !== undefined) {
        const rule = timezoneRule(s.timezone, reader);
        if (rule) return interactiveFailure('validation_failed', p, rule);
      }
      if (!Object.hasOwn(values, s.id)) {
        if (s.required) return interactiveFailure('validation_failed', p, 'input_required');
        continue;
      }
      const value = values[s.id];
      const strings = typeof value === 'string' ? [value] : Array.isArray(value) ? value.filter(v => typeof v === 'string') as string[] : [];
      if (strings.some(v => Buffer.byteLength(v) > maxText)) return interactiveFailure('limit_exceeded', p, 'input_text_bytes');
      if (strings.some(v => /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]|\p{Cf}|(?!\n)\p{Cc}/u.test(v) || hasSecretShape(v))) return interactiveFailure('validation_failed', p, 'input_unsafe');
      let valid = false;
      switch (s.kind) {
        case 'text': valid = typeof value === 'string' && (!s.required || value.trim() !== '') && [...value].length >= Math.max(s.required ? 1 : 0, s.minLength ?? 0) && [...value].length <= (s.maxLength ?? 4096); break;
        case 'number': valid = typeof value === 'number' && Number.isFinite(value) && value >= s.min && value <= s.max; break;
        case 'date': valid = typeof value === 'string' && validDate(value); break;
        case 'time': valid = typeof value === 'string' && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value); break;
        case 'toggle': valid = typeof value === 'boolean'; break;
        case 'choice': {
          const ids = s.multiple ? value : [value];
          valid = Array.isArray(ids) && ids.length >= s.min && ids.length <= s.max && new Set(ids).size === ids.length && ids.every(id => typeof id === 'string' && s.options.some(o => o.id === id));
          break;
        }
      }
      if (!valid) return interactiveFailure('validation_failed', p, s.kind === 'choice' ? 'choice_membership' : 'input_value');
      out[s.id] = (Array.isArray(value) ? [...value] : value) as JsonValue;
    }
    return freezeInteractive({ ok: true, value: out });
  };
}
