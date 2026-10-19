import { createHash } from 'node:crypto';
import { closeSync, constants, fchmodSync, fstatSync, lstatSync, mkdirSync, openSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, parse, resolve } from 'node:path';
import { getSystemErrorMap, types as utilTypes } from 'node:util';
import { constants as osConstants } from 'node:os';
import type { FailureReport, FailureSnapshot, FailureStage, FailureCategory } from './agent-failure.js';

export type DiagnosticEvent = 'item.error' | 'turn.failed' | 'error' | 'exception';
interface SdkContext { detail?: Readonly<SdkDetail>; event: DiagnosticEvent; fingerprint: string; messageBytes: number; fingerprintTruncated: boolean; code?: string; }
const contexts = new WeakMap<Error, SdkContext>();
const systemCodes = new Set([...getSystemErrorMap().values()].map(([code]) => code));
const stages: Record<FailureStage, true> = { prepare:true, spawn:true, inference:true, jsonl_parse:true, process_exit:true, delivery:true, history_commit:true, cleanup:true };
const categories: Record<FailureCategory, true> = { network_transient:true, stream_interrupted:true, rate_limited:true, quota_exhausted:true, provider_unavailable:true, auth:true, permission:true, context_limit:true, invalid_encrypted_content:true, invalid_config:true, jsonl_incomplete:true, jsonl_invalid:true, proxy_bootstrap:true, process_exit:true, cancelled:true, timeout:true, delivery_failed:true, api_failed:true, history_failed:true, unknown:true };
const sources: Record<FailureSnapshot['source'], true> = { sdk_event:true, sdk_exception:true, octo_api:true, local:true };
const evidence: Record<FailureSnapshot['evidence'], true> = { structured:true, recognized_text:true, unknown:true };

/** Only own data properties: never execute SDK getters or walk a payload/prototype. */
function own(value: unknown, key: string): unknown {
  if (!value || (typeof value !== 'object' && typeof value !== 'function') || utilTypes.isProxy(value)) return;
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor && 'value' in descriptor ? descriptor.value : undefined;
}
const safeCodes = new Set([...systemCodes, 'context_length_exceeded', 'invalid_encrypted_content',
  'rate_limit_exceeded', 'insufficient_quota', 'server_error', 'invalid_api_key', 'model_not_found']);
const signals = new Set(Object.keys(osConstants.signals));
export interface SdkDiagnosticRun {
  mode: 'start' | 'resume'; attempt: number; noticeTemplateId?: 'model_changed_notice' | 'model_metadata_notice'; resumeId?: unknown; threadId?: unknown; turnId?: unknown;
}
interface SdkDetail {
  code?: string; status?: number; exitCode?: number; signal?: string;
  exitSource?: 'own_field' | 'sdk_message_template'; templateId?: string; noticeTemplateId?: string;
  eventSubtype?: string; mode?: 'start' | 'resume'; attempt?: number;
  resumeFingerprint?: string; threadFingerprint?: string; turnFingerprint?: string;
}
export interface SdkDiagnosticOptions {
  detailed?: boolean; fields?: unknown; eventSubtype?: unknown; run?: SdkDiagnosticRun;
}
/** Fixed output vocabulary; matching never copies any part of the input. */
function textTemplate(message: string): string | undefined {
  const templates: Array<[RegExp, string]> = [
    [/^(?:429 )?rate limit exceeded$/i, 'rate_limit'],
    [/^(?:429 )?(?:insufficient_quota|quota exceeded|quota exhausted)$/i, 'quota'],
    [/^(?:503 )?service unavailable$/i, 'service_unavailable'],
    [/^(?:502 )?bad gateway$/i, 'bad_gateway'],
    [/^(?:500 )?internal server error$/i, 'internal_server_error'],
    [/^(?:401 )?(?:unauthorized|authentication failed)$/i, 'authentication'],
    [/^(?:403 )?(?:forbidden|permission denied)$/i, 'permission'],
    [/^(?:context_length_exceeded|context window exceeded|maximum context length exceeded)$/i, 'context_limit'],
    [/^invalid encrypted content$/i, 'invalid_encrypted_content'],
    [/^(?:stream closed before response\.completed|stream disconnected before completion(?:: stream closed before response\.completed)?)$/i, 'stream_interrupted'],
    [/^Failed to parse item:/, 'jsonl_parse'],
    [/^CODEX_JSONL_PROXY_BOOTSTRAP_FAILURE:/, 'proxy_bootstrap'],
    [/^This session was recorded with model `([^`\r\n]+)` but is resuming with `[^`\r\n]+`\. Consider switching back to `\1` as it may affect Codex performance\.$/, 'model_changed_notice'],
    [/^Model metadata for `[^`\r\n]+` not found\. Defaulting to fallback metadata(?:[.;]|$)/i, 'model_metadata_notice'],
  ];
  return templates.find(([pattern]) => pattern.test(message))?.[1];
}
function identifierFingerprint(value: unknown): string | undefined {
  // Reject oversized IDs rather than correlate ambiguous truncated prefixes.
  if (typeof value !== 'string' || !value.length || Buffer.byteLength(value) > 256) return;
  return createHash('sha256').update(value).digest('hex');
}
function sdkDetail(message: string, options: SdkDiagnosticOptions): Readonly<SdkDetail> {
  const detail: SdkDetail = {};
  const fields = options.fields;
  const code = own(fields, 'code');
  if (typeof code === 'string' && safeCodes.has(code)) detail.code = code;
  for (const key of ['status', 'statusCode', 'httpStatus']) {
    const status = own(fields, key);
    if (typeof status === 'number' && Number.isInteger(status) && status >= 100 && status <= 599) { detail.status = status; break; }
  }
  const exitCode = own(fields, 'exitCode');
  const signal = own(fields, 'signal');
  if (typeof exitCode === 'number' && Number.isInteger(exitCode) && exitCode >= 0 && exitCode <= 255) {
    detail.exitCode = exitCode; detail.exitSource = 'own_field';
  }
  if (typeof signal === 'string' && signals.has(signal)) { detail.signal = signal; detail.exitSource = 'own_field'; }
  // SDK 0.142 wraps exit metadata and stderr in one message. Inspect only the
  // bounded header, never the stderr suffix; label this as text-derived evidence.
  const header = /^Codex Exec exited with (?:code (\d{1,3})|signal (SIG[A-Z0-9]+)):/.exec(message.slice(0, 80));
  if (header && detail.exitSource === undefined) {
    if (header[1] !== undefined && Number(header[1]) <= 255) detail.exitCode = Number(header[1]);
    if (signals.has(header[2])) detail.signal = header[2];
    if (detail.exitCode !== undefined || detail.signal !== undefined) detail.exitSource = 'sdk_message_template';
  }
  const templateId = header ? 'process_exit' : textTemplate(message.slice(0, 8192));
  if (templateId) detail.templateId = templateId;
  if (['item.started', 'item.updated', 'item.completed', 'turn.failed', 'error', 'exception'].includes(options.eventSubtype as string)) {
    detail.eventSubtype = options.eventSubtype as string;
  }
  const run = options.run;
  if (run) {
    if (run.noticeTemplateId === 'model_changed_notice' || run.noticeTemplateId === 'model_metadata_notice') detail.noticeTemplateId = run.noticeTemplateId;
    if (run.mode === 'start' || run.mode === 'resume') detail.mode = run.mode;
    if (Number.isSafeInteger(run.attempt) && run.attempt >= 0) detail.attempt = run.attempt;
    const resume = identifierFingerprint(run.resumeId), thread = identifierFingerprint(run.threadId), turn = identifierFingerprint(run.turnId);
    if (resume) detail.resumeFingerprint = resume;
    if (thread) detail.threadFingerprint = thread;
    if (turn) detail.turnFingerprint = turn;
  }
  return Object.freeze(detail);
}

/** Hash-only compatibility unless the separate detailed switch is explicit.
 * No arbitrary text is retained, even in detailed mode. Diagnostic trouble must
 * never replace an SDK failure or affect recovery decisions. */
export function rememberSdkFailure(error: Error, event: DiagnosticEvent, message: unknown, options: SdkDiagnosticOptions = {}): void {
  try {
    // Even descriptor reflection can execute a proxy trap and mutate the
    // original failure before classification. Do not inspect proxy inputs.
    if (utilTypes.isProxy(error) || utilTypes.isProxy(options)) return;
    const detailsSafe = !utilTypes.isProxy(options.fields) && !utilTypes.isProxy(options.run);
    if (contexts.has(error)) return;
    if (typeof message !== 'string' || !['item.error','turn.failed','error','exception'].includes(event)) return;
    const bounded = message.slice(0, 8192);
    const code = own(error, 'code');
    contexts.set(error, { event, fingerprint:createHash('sha256').update(bounded).digest('hex'), messageBytes:Buffer.byteLength(message), fingerprintTruncated:message.length > bounded.length,
      ...(typeof code === 'string' && systemCodes.has(code) ? {code} : {}),
      ...(options.detailed === true && detailsSafe ? {detail:sdkDetail(message, options)} : {}) });
  } catch { /* Fail closed: no partial record and no change to the actual error. */ }
}

/** WeakMap provenance is never serialized with public errors. */
export function inheritSdkDiagnostic<T extends Error>(target: T, source: unknown): T {
  if (source !== null && (typeof source === 'object' || typeof source === 'function')) {
    const context = contexts.get(source as Error); if (context) contexts.set(target, context);
  }
  return target;
}

function snapshot(value: FailureSnapshot): FailureSnapshot {
  return { stage:Object.hasOwn(stages,value.stage) ? value.stage : 'inference', category:Object.hasOwn(categories,value.category) ? value.category : 'unknown',
    source:Object.hasOwn(sources,value.source) ? value.source : 'local', evidence:Object.hasOwn(evidence,value.evidence) ? value.evidence : 'unknown',
    ...(Number.isInteger(value.httpStatus) && value.httpStatus! >= 100 && value.httpStatus! <= 599 ? {httpStatus:value.httpStatus} : {}),
    ...(Number.isSafeInteger(value.retryAfterMs) && value.retryAfterMs! >= 0 ? {retryAfterMs:value.retryAfterMs} : {}) };
}

export const PRIVATE_DIAGNOSTIC_LIMITS = { maxBytes:1_048_576, maxFiles:3 } as const;
export function privateDiagnosticRow(report: FailureReport, error: unknown): object | undefined {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(report.diagnosticId)) return;
  return { diagnosticId:report.diagnosticId, timestamp:new Date().toISOString(), first:snapshot(report.first), final:snapshot(report.final),
    attempts:Number.isSafeInteger(report.attempts) && report.attempts >= 0 ? report.attempts : 0,
    decision:['not_attempted','blocked_uncertain','exhausted','cancelled','fresh_retried'].includes(report.decision) ? report.decision : 'not_attempted',
    executionRisk:['proven_not_started','effects_observed','unknown'].includes(report.executionRisk) ? report.executionRisk : 'unknown',
    node:process.version, ...(error !== null && (typeof error === 'object' || typeof error === 'function') && contexts.has(error as Error) ? {sdk:{...contexts.get(error as Error), ...(contexts.get(error as Error)?.detail ? {detail:{...contexts.get(error as Error)!.detail}} : {})}} : {}) };
}

/** Snapshot every directory component, rejecting symlink ancestors. macOS has
 * OS-provided /tmp and /var aliases; canonicalize only those fixed aliases. */
function directoryGuard(dataDir: string): {root: string; check: () => void} {
  let root = resolve(dataDir);
  if (process.platform === 'darwin' && /^\/(?:tmp|var)(?:\/|$)/.test(root)) {
    const alias = root.split('/')[1];
    if (realpathSync(`/${alias}`) === `/private/${alias}`) root = `/private${root}`;
  }
  const chain: Array<{path:string; dev:number; ino:number}> = [];
  let path = root;
  while (true) {
    const stat = lstatSync(path);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('unsafe diagnostic directory');
    chain.push({path,dev:stat.dev,ino:stat.ino});
    if (path === parse(path).root) break;
    path = dirname(path);
  }
  return {root,check:() => {
    for (const entry of chain) {
      const stat = lstatSync(entry.path);
      if (!stat.isDirectory() || stat.isSymbolicLink() || stat.dev !== entry.dev || stat.ino !== entry.ino) throw new Error('diagnostic directory changed');
    }
  }};
}

/** Local-only bounded metadata. Same-user concurrent path mutation is outside
 * the isolation boundary: Node has no portable openat/renameat. Revalidate paths
 * around every operation and use no-follow, inode and hard-link checks. */
export function recordPrivateFailure(dataDir: string, enabled: boolean, report: FailureReport, error: unknown,
  limits: {maxBytes:number; maxFiles:number} = PRIVATE_DIAGNOSTIC_LIMITS): boolean {
  if (!enabled) return true;
  // Undefined flags are coerced to zero by bitwise OR. Refuse before *any*
  // filesystem access/mutation rather than silently dropping safety guarantees.
  if (![constants.O_DIRECTORY, constants.O_NOFOLLOW, constants.O_NONBLOCK]
    .every(flag => typeof flag === 'number' && Number.isInteger(flag) && flag > 0)) return false;
  try {
    if (!Number.isInteger(limits.maxBytes) || limits.maxBytes < 256 || limits.maxBytes > PRIVATE_DIAGNOSTIC_LIMITS.maxBytes
      || !Number.isInteger(limits.maxFiles) || limits.maxFiles < 1 || limits.maxFiles > PRIVATE_DIAGNOSTIC_LIMITS.maxFiles) return false;
    const row = privateDiagnosticRow(report,error); if (!row) return false;
    const line = JSON.stringify(row) + '\n'; if (Buffer.byteLength(line) > Math.min(limits.maxBytes,16_384)) return false;
    const parent = directoryGuard(dataDir);
    const dir = join(parent.root,'diagnostics');
    const prior = lstatSync(dir,{throwIfNoEntry:false});
    if (prior && (!prior.isDirectory() || prior.isSymbolicLink())) return false;
    if (!prior) { parent.check(); mkdirSync(dir,{mode:0o700}); }
    const guard = directoryGuard(dir);
    const directoryFd = openSync(dir, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try {
      guard.check();
      const directoryStat = fstatSync(directoryFd), pathStat = lstatSync(dir);
      if (directoryStat.dev !== pathStat.dev || directoryStat.ino !== pathStat.ino
        || (process.getuid && directoryStat.uid !== process.getuid())) return false;
      fchmodSync(directoryFd,0o700);
      const file = join(dir,'agent-failures.jsonl');
      const checkFile = (path: string) => {
        guard.check();
        const stat = lstatSync(path,{throwIfNoEntry:false});
        if (stat && (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || (stat.mode & 0o077) !== 0 || stat.size > limits.maxBytes
          || (process.getuid && stat.uid !== process.getuid()))) throw new Error('unsafe diagnostic file');
        return stat;
      };
      const checkFiles = () => {
        for (let i=0; i<limits.maxFiles; i++) checkFile(i===0 ? file : `${file}.${i}`);
      };
      checkFiles();
      if ((checkFile(file)?.size ?? 0) + Buffer.byteLength(line) > limits.maxBytes) {
        const last = limits.maxFiles===1 ? file : `${file}.${limits.maxFiles-1}`;
        if (checkFile(last)) { checkFiles(); unlinkSync(last); }
        for (let i=limits.maxFiles-2; i>=0; i--) {
          const from = i===0 ? file : `${file}.${i}`;
          if (checkFile(from)) { checkFiles(); renameSync(from,`${file}.${i+1}`); }
        }
      }
      const before = checkFile(file);
      const fd = openSync(file, constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);
      try {
        checkFiles();
        const stat = fstatSync(fd), current = checkFile(file);
        if (!stat.isFile() || stat.nlink !== 1 || !current || current.dev !== stat.dev || current.ino !== stat.ino
          || (before && (before.dev !== stat.dev || before.ino !== stat.ino))
          || stat.size + Buffer.byteLength(line) > limits.maxBytes) return false;
        fchmodSync(fd,0o600); writeFileSync(fd,line);
      } finally { closeSync(fd); }
    } finally { closeSync(directoryFd); }
    return true;
  } catch { return false; }
}
