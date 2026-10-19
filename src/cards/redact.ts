/** WP-05: deterministic reduction only. No raw item strings reach the notice sink. */
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { domainToASCII, domainToUnicode } from 'node:url';
import { isIP } from 'node:net';
import { types } from 'node:util';
import type { SafeItemFacts, SafeProgram } from './contracts.js';

export interface ReducedItemFacts extends SafeItemFacts {
  readonly activity?: 'thinking' | 'planning';
  readonly durationClass?: 'short' | 'medium' | 'long' | 'unknown';
  readonly errorClass?: 'failed';
}

export const PSL_SHA256 = '2919eb9803c91a3f73a507cc6fedc934de005543c22c4016f72e3343de5dd6e7';
const MAX_INPUT = 8192;
const MAX_FILES = 10000;
const PROGRAMS = new Set(['git', 'npm', 'node', 'python', 'python3', 'ls', 'cat', 'grep', 'rg', 'sed', 'find', 'make', 'pytest', 'tsc']);
const CONTROLS = /[\p{Cc}\p{Cf}\p{Cs}]/gu;
const fallback: ReducedItemFacts = Object.freeze({ category: 'activity' });

/** Remove unpaired surrogates and controls before NFC; iterate Unicode scalars. */
function normalize(value: string): string {
  return value.replace(CONTROLS, '').normalize('NFC');
}

function entropy(value: string): number {
  const counts = new Map<string, number>();
  for (const c of value) counts.set(c, (counts.get(c) ?? 0) + 1);
  let result = 0;
  for (const n of counts.values()) {
    const p = n / value.length;
    result -= p * Math.log2(p);
  }
  return result;
}

/** Conservative secret-shape gate, including normalization-obscured tokens. */
export function hasSecretShape(value: string): boolean {
  const text = normalize(value).normalize('NFKC');
  if (/[A-Za-z_][A-Za-z0-9_]*\s*=/.test(text)
    || /\bexport\s+/i.test(text)
    || /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|rediss|amqp|amqps|mssql):\/\//i.test(text)
    || /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/.test(text)
    || /[a-z][a-z0-9+.-]*:\/\/[^\s/]*@/i.test(text)
    || /\b(?:gh[pousr]_|github_pat_|sk-(?:proj-|ant-)?|xox[baprs]-|AKIA|ASIA|AIza)[A-Za-z0-9_-]{8,}/i.test(text)
    || /-----BEGIN (?:[A-Z]+ )*PRIVATE KEY-----/.test(text)
    || /\b(?:Bearer|Basic)\s+[A-Za-z0-9+/=_-]{8,}/i.test(text)) return true;
  for (const match of text.matchAll(/[A-Fa-f0-9]{24,}/g)) if (entropy(match[0]) >= 3) return true;
  for (const match of text.matchAll(/[A-Za-z0-9+/_-]{32,}={0,2}/g)) if (entropy(match[0]) >= 3.5) return true;
  return false;
}

/** Scan the entire input before capping; never split a Unicode scalar. */
export function sanitizeText(value: string, generic: string, scalars = 192, bytes = 768): string {
  if (!Number.isSafeInteger(scalars) || !Number.isSafeInteger(bytes) || scalars < 0 || bytes < 0) return generic;
  if (hasSecretShape(value)) return generic;
  const text = normalize(value);
  if (hasSecretShape(text)) return generic;
  let out = '', usedBytes = 0, usedScalars = 0;
  for (const c of text) {
    const size = Buffer.byteLength(c, 'utf8');
    if (usedScalars >= scalars || usedBytes + size > bytes) break;
    out += c; usedScalars++; usedBytes += size;
  }
  return out;
}

// Pinned source is read once. Missing, altered or malformed data disables domains.
const suffixes = new Set<string>(), wildcards = new Set<string>(), exceptions = new Set<string>();
let pslAvailable = false;
try {
  const data = readFileSync(new URL(`./data/psl-${PSL_SHA256}.dat`, import.meta.url));
  if (createHash('sha256').update(data).digest('hex') === PSL_SHA256) {
    for (const line of data.toString('utf8').split('\n')) {
      const rule = line.trim();
      if (!rule || rule.startsWith('//')) continue;
      const target = rule.startsWith('!') ? exceptions : rule.startsWith('*.') ? wildcards : suffixes;
      const name = domainToASCII(rule.replace(/^!|^\*\./, ''));
      if (!name) throw new Error('invalid suffix');
      target.add(name);
    }
    pslAvailable = suffixes.has('com') && suffixes.has('blogspot.com');
  }
} catch { /* Fail closed without reporting asset or machine paths. */ }

// Domain labels can join a prefix to ASCII text during UTS-46 conversion.
// Inspect vendor shapes anywhere within these bounded hostname facts, rather
// than relying on the word boundary used for ordinary text. No URL components
// other than the hostname are decoded or scanned here.
function domainHasSecret(host: string): boolean {
  const labels = normalize(host).normalize('NFKC').split('.');
  return hasSecretShape(host)
    // Encoded A-label payload bytes do not describe plaintext adjacency.
    // Their decoded U-labels receive this joining-aware check separately.
    || labels.some(label => !/^xn--/i.test(label)
      && /(?:gh[pousr]_|github_pat_|sk-(?:proj-|ant-)?|xox[baprs]-|AKIA|ASIA|AIza)[A-Za-z0-9_-]{8,}/i.test(label));
}

function domainRepresentations(host: string): string | null {
  if (!host || host.length > 253 || /[\p{Cc}\p{Cf}\p{Cs}\s:/@]/u.test(host)) return null;
  const ascii = domainToASCII(host.normalize('NFC')).toLowerCase().replace(/\.$/, '');
  if (!ascii || ascii.length > 253) return null;
  const unicode = domainToUnicode(ascii);
  if (!unicode || unicode.length > 253 || domainToASCII(unicode).toLowerCase() !== ascii
    || domainHasSecret(host) || domainHasSecret(ascii) || domainHasSecret(unicode)) return null;
  return ascii;
}

/** ICANN+PRIVATE longest-match rules; unknown suffixes intentionally fail closed. */
export function registrableDomain(host: string): string {
  if (!pslAvailable) return 'link';
  const ascii = domainRepresentations(host);
  if (!ascii || isIP(ascii)) return 'link';
  const labels = ascii.split('.');
  if (labels.length < 2 || labels.some(l => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(l))) return 'link';
  if (/^(?:localhost|local|internal|lan|home|test|invalid|onion)$/.test(labels.at(-1) ?? '')) return 'link';
  // IP spellings and numeric pseudo-hosts must never become registrable labels.
  if (/^\d+(?:\.\d+)*$/.test(ascii)) return 'link';
  let suffixLength = 0;
  for (let i = 0; i < labels.length; i++) {
    const name = labels.slice(i).join('.');
    if (exceptions.has(name)) { suffixLength = labels.length - i - 1; break; }
    if (suffixes.has(name)) suffixLength = Math.max(suffixLength, labels.length - i);
    if (i > 0 && wildcards.has(name)) suffixLength = Math.max(suffixLength, labels.length - i + 1);
  }
  if (!suffixLength || labels.length <= suffixLength) return 'link';
  const domain = labels.slice(-suffixLength - 1).join('.');
  // Never truncate a domain: an altered suffix could identify another host.
  const safe = sanitizeText(domain, 'link');
  return safe === domain ? safe : 'link';
}

function safeDomain(value: unknown): string {
  if (typeof value !== 'string' || value.length > MAX_INPUT || /[\p{Cc}\p{Cf}\p{Cs}]/u.test(value)) return 'link';
  try {
    if (!/^https?:\/\//i.test(value)) return 'link';
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return 'link';
    // URL.hostname is already canonical ASCII. Retain only the bounded raw
    // hostname from the authority as an additional oracle input. Never decode
    // credentials, path, query or fragment. Backslash ends an HTTP authority.
    const authority = value.slice(value.indexOf('://') + 3).split(/[/\\?#]/, 1)[0];
    const hostPort = authority.slice(authority.lastIndexOf('@') + 1);
    const rawHost = hostPort.replace(/:\d*$/, '');
    const rawASCII = domainRepresentations(rawHost);
    if (!rawASCII || rawASCII !== url.hostname.toLowerCase().replace(/\.$/, '')) return 'link';
    return registrableDomain(url.hostname);
  } catch { return 'link'; }
}

// Native proxy detection avoids executing any Proxy trap. Only own data
// descriptors on plain objects/arrays are consumed; no coercion or accessor call.
function descriptors(value: unknown, array = false): PropertyDescriptorMap | null {
  if (!value || typeof value !== 'object' || types.isProxy(value)) return null;
  const proto = Object.getPrototypeOf(value);
  if (array ? !Array.isArray(value) || proto !== Array.prototype : proto !== Object.prototype && proto !== null) return null;
  const ds = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(ds).some(k => typeof k === 'symbol') || Object.values(ds).some(d => !('value' in d))) return null;
  return ds;
}
function own(ds: PropertyDescriptorMap, key: string): unknown { return Object.hasOwn(ds, key) ? ds[key].value : undefined; }

function program(value: unknown): SafeProgram {
  if (typeof value !== 'string' || value.length > MAX_INPUT) return 'command' as SafeProgram;
  // Reject obscured syntax rather than joining tokens by stripping controls.
  // A horizontal tab is an explicit separator; other controls fail closed.
  if (/[\p{Cc}\p{Cf}\p{Cs}]/u.test(value.replaceAll('\t', ''))) return 'command' as SafeProgram;
  const text = value.normalize('NFC');
  let cursor = 0, selected: SafeProgram | undefined;
  while (cursor < text.length) {
    while (text[cursor] === ' ' || text[cursor] === '\t') cursor++;
    if (cursor === text.length) break;
    const start = cursor;
    let quote = '';
    // One forward pass over complete words, including argv syntax. No shell
    // execution/expansion, backtracking, or retry from earlier positions.
    while (cursor < text.length) {
      const c = text[cursor];
      if (!quote && (c === ' ' || c === '\t')) break;
      if (/\s/u.test(c) && c !== ' ' && c !== '\t') return 'command' as SafeProgram;
      if (c === '`' || c === '$' || (!quote && /[;|&<>()[\]{}]/.test(c))) return 'command' as SafeProgram;
      if (c === '\\' && (quote || cursor + 1 === text.length || /[\s'"`$;|&<>]/u.test(text[cursor + 1]))) return 'command' as SafeProgram;
      if (c === "'" || c === '"') {
        if (!quote) quote = c;
        else if (quote === c) quote = '';
      }
      cursor++;
    }
    if (quote) return 'command' as SafeProgram;
    const token = text.slice(start, cursor);
    if (selected === undefined) {
      if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(token)) continue;
      if (!/^[A-Za-z0-9_./~:\\-]+$/.test(token)) return 'command' as SafeProgram;
      const base = token.split(/[/\\]/).at(-1) ?? '';
      selected = (PROGRAMS.has(base) ? base : 'command') as SafeProgram;
    }
  }
  return selected ?? 'command' as SafeProgram;
}

/** Fixed pipeline: type → program → count → domain → no query → status →
 * no MCP identity → scan every output string → normalize/scalar+byte cap. */
export function reduceItem(item: unknown): Readonly<ReducedItemFacts> {
  const ds = descriptors(item);
  if (!ds) return fallback;
  const type = own(ds, 'type');
  const category = type === 'command_execution' ? 'command' : type === 'file_change' ? 'file_change'
    : type === 'web_search' ? 'web_search' : type === 'mcp_tool_call' ? 'tool'
    : type === 'reasoning' || type === 'todo_list' ? 'activity' : null;
  if (!category) return fallback;
  const facts: { -readonly [K in keyof ReducedItemFacts]: ReducedItemFacts[K] } = { category };
  if (category === 'command') facts.program = program(own(ds, 'command'));
  if (category === 'file_change') {
    const changes = descriptors(own(ds, 'changes'), true);
    const count = changes ? own(changes, 'length') : undefined;
    if (changes && typeof count === 'number' && Number.isSafeInteger(count) && count <= MAX_FILES
      && Array.from({ length: count }, (_, i) => descriptors(own(changes, String(i)))).every(Boolean)) facts.fileCount = count;
  }
  if (category === 'web_search' && Object.hasOwn(ds, 'url')) facts.domain = safeDomain(own(ds, 'url'));
  // Search query and all MCP fields deliberately remain unread.
  const status = own(ds, 'status');
  if (category === 'command') {
    const exit = own(ds, 'exit_code');
    facts.exitClass = status === 'completed' && typeof exit === 'number' && Number.isSafeInteger(exit)
      ? exit === 0 ? 'ok' : 'nonzero' : 'unknown';
  }
  if (category !== 'activity' && Object.hasOwn(ds, 'duration_ms')) {
    const ms = own(ds, 'duration_ms');
    facts.durationClass = typeof ms === 'number' && Number.isFinite(ms) && ms >= 0
      ? ms < 1000 ? 'short' : ms < 60000 ? 'medium' : 'long' : 'unknown';
  }
  if (category !== 'activity' && status === 'failed') facts.errorClass = 'failed';
  if (type === 'reasoning') facts.activity = 'thinking';
  if (type === 'todo_list') facts.activity = 'planning';
  for (const key of Object.keys(facts) as (keyof ReducedItemFacts)[]) {
    const value = facts[key];
    if (typeof value === 'string') {
      const generic = key === 'domain' ? 'link' : key === 'program' ? 'command' : value;
      // All non-domain/program strings are closed literals above.
      Object.defineProperty(facts, key, { value: sanitizeText(value, generic), enumerable: true, configurable: true, writable: true });
    }
  }
  return Object.freeze(facts);
}

/** PN-01–08: closed labels only; never format arbitrary callback arguments. */
export function safeNotice(facts: ReducedItemFacts): string | null {
  const label = facts.category === 'command' ? 'Running command' : facts.category === 'file_change' ? 'Editing files'
    : facts.category === 'web_search' ? 'Searching' : facts.category === 'tool' ? 'Tool'
    : facts.activity === 'thinking' ? 'Thinking' : facts.activity === 'planning' ? 'Planning' : null;
  return label ? `🔧 ${label}…` : null;
}
