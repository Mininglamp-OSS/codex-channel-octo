import { types } from 'node:util';
import { nativeErrorMessage } from './native-error.js';
import { redactErrorText, isCredentialField } from './error-redaction.js';

export const ERROR_LIMITS = { message: 1000, details: 3000, notice: 4500, depth: 3, nodes: 64, properties: 16 } as const;
const MARK = '［已截断］';
export type ThreadProblem = 'not_found' | 'expired' | 'invalid_encrypted_content';
export interface ErrorDetails { message: string; details: string; threadProblem?: ThreadProblem; }
const captured = new WeakMap<object, Readonly<ErrorDetails>>();

/** Counts Unicode code points, and stops scanning once the output is full. */
export function limitText(value: string, max: number): string {
  let prefix = '', count = 0;
  for (const c of value) {
    if (count++ === max) {
      let result = '', n = 0;
      for (const p of prefix) { if (n++ >= max - MARK.length) break; result += p; }
      return result + MARK.slice(0, max);
    }
    prefix += c;
  }
  return prefix;
}

function ordinary(value: unknown): value is object {
  if (!value || typeof value !== 'object') return false;
  let current: object | null = value;
  for (let n = 0; current; n++) {
    if (n >= 32 || types.isProxy(current)) return false;
    current = Object.getPrototypeOf(current);
  }
  return true;
}
function own(value: unknown, key: string): unknown {
  if (!ordinary(value)) return undefined;
  const d = Object.getOwnPropertyDescriptor(value, key);
  return d && 'value' in d ? d.value : undefined;
}

/** No getters, custom serializers, stderr reads, or unbounded JSON construction.
 * Common credential patterns are masked before truncation/retention. */
export function snapshotError(value: unknown, sdk = false): Readonly<ErrorDetails> {
  let message = '';
  let details = '';
  const seen = new WeakSet<object>();
  let nodes = 0, full = false;
  function append(text: string): void {
    if (full) return;
    // At most 3000 code points have already been retained.
    const available = ERROR_LIMITS.details - Array.from(details).length;
    if (available === 0 && text.length > 0) {
      details = limitText(details + MARK, ERROR_LIMITS.details); full = true; return;
    }
    const sanitized = redactErrorText(text);
    const bounded = limitText(sanitized, available);
    details += bounded;
    full = bounded !== sanitized || available === 0;
  }
  function visit(v: unknown, path: string, depth: number): void {
    if (full) return;
    if (++nodes > ERROR_LIMITS.nodes || depth > ERROR_LIMITS.depth) { append(`${path}: ${MARK}\n`); return; }
    if (typeof v === 'string') { append(`${path}: ${redactErrorText(v)}\n`); return; }
    if (v === null || ['number','boolean','bigint','undefined'].includes(typeof v)) {
      const huge = typeof v === 'bigint' && (v > 10n ** 100n || v < -(10n ** 100n));
      append(`${path}: ${huge ? MARK : String(v)}\n`); return;
    }
    if (!ordinary(v)) { append(`${path}: [unreadable]\n`); return; }
    if (seen.has(v)) { append(`${path}: [circular]\n`); return; }
    seen.add(v);
    const priority = ['code','status','statusCode','httpStatus','exitCode','signal','name','message','stack','cause','stderr'];
    const processed = new Set<string>();
    let count = 0;
    const field = (key: string): void => {
      if (full || processed.has(key)) return;
      const d = Object.getOwnPropertyDescriptor(v, key);
      if (!d) return;
      processed.add(key);
      if (++count > ERROR_LIMITS.properties) { append(`${path}: ${MARK}\n`); full = true; return; }
      const label = `${path}.${limitText(key, 80)}`;
      if (!('value' in d)) { append(`${label}: [accessor skipped]\n`); return; }
      if (isCredentialField(key)) { append(`${label}: [REDACTED]\n`); return; }
      if (depth === 0 && key === 'message') return;
      visit(d.value, label, depth + (key === 'cause' ? 1 : 0) + (typeof d.value === 'object' && key !== 'cause' ? 1 : 0));
    };
    for (const key of priority) field(key);
    let enumerated = 0;
    for (const key in v) {
      if (full) break;
      if (++enumerated > ERROR_LIMITS.properties) { append(`${path}: ${MARK}\n`); break; }
      field(key);
    }
  }
  try {
    const raw = own(value, 'message') ?? nativeErrorMessage(value);
    message = limitText(redactErrorText(typeof raw === 'string' ? raw : typeof value === 'string' ? value : ''), ERROR_LIMITS.message);
    visit(value, 'error', 0);
    const code = own(value, 'code');
    const invalid = sdk && (code === 'invalid_encrypted_content' || raw === 'invalid encrypted content');
    const missing = sdk && (code === 'thread_not_found' || code === 'session_not_found' || /^(?:thread|session) not found$/i.test(typeof raw === 'string' ? raw : ''));
    const expired = sdk && (code === 'thread_expired' || code === 'session_expired' || /^(?:thread|session) (?:has )?expired$/i.test(typeof raw === 'string' ? raw : ''));
    return Object.freeze({message, details, ...(invalid ? {threadProblem:'invalid_encrypted_content' as const} : missing ? {threadProblem:'not_found' as const} : expired ? {threadProblem:'expired' as const} : {})});
  } catch { return Object.freeze({message, details:limitText(details + '\n[unreadable]', ERROR_LIMITS.details)}); }
}

export function attachErrorDetails<T extends object>(error: T, original: unknown, sdk = false): T {
  if (!captured.has(error)) captured.set(error, snapshotError(original, sdk)); return error;
}
export function errorDetails(error: unknown): Readonly<ErrorDetails> {
  if (error !== null && typeof error === 'object' && !types.isProxy(error)) {
    const saved = captured.get(error); if (saved) return saved;
  }
  return snapshotError(error);
}
