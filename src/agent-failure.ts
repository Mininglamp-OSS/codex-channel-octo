/** Public diagnostics are closed snapshots, never exception messages or causes. */
import { randomUUID } from 'node:crypto';
import { types as utilTypes } from 'node:util';
import { isNativeDomAccessor } from './native-error.js';
export type FailureStage = 'prepare' | 'spawn' | 'inference' | 'jsonl_parse' | 'process_exit' | 'delivery' | 'history_commit' | 'cleanup';
export type FailureCategory = 'network_transient' | 'stream_interrupted' | 'rate_limited' | 'quota_exhausted' | 'provider_unavailable' | 'auth' | 'permission' | 'context_limit' | 'invalid_encrypted_content' | 'invalid_config' | 'jsonl_incomplete' | 'jsonl_invalid' | 'proxy_bootstrap' | 'process_exit' | 'cancelled' | 'timeout' | 'delivery_failed' | 'api_failed' | 'history_failed' | 'unknown';
export type ExecutionRisk = 'proven_not_started' | 'effects_observed' | 'unknown';
export type RecoveryDecision = 'not_attempted' | 'blocked_uncertain' | 'exhausted' | 'cancelled' | 'fresh_retried';
export type OctoEndpoint = '/v1/bot/sendMessage' | '/v1/bot/register' | '/v1/bot/typing'
  | '/v1/bot/heartbeat' | '/v1/bot/readReceipt' | '/v1/bot/messages/sync'
  | '/v1/bot/upload/credentials' | '/v1/bot/groups/:group/md'
  | '/v1/bot/groups/:group/threads/:thread/md' | '/v1/bot/groups/:group/mention_pref'
  | '/v1/bot/groups/:group/members' | 'other';
export interface FailureSnapshot {
  stage: FailureStage; category: FailureCategory; source: 'sdk_event' | 'sdk_exception' | 'octo_api' | 'local';
  evidence: 'structured' | 'recognized_text' | 'unknown';
  httpStatus?: number; retryAfterMs?: number;
  endpoint?: OctoEndpoint;
  detail?: 'http_status' | 'invalid_json' | 'response_read' | 'network';
}
export class AgentFailure extends Error {
  constructor(readonly snapshot: Readonly<FailureSnapshot>) {
    super(snapshot.endpoint
      ? `Octo API ${snapshot.endpoint} failed (${snapshot.httpStatus ?? 'network'}): ${snapshot.category}${snapshot.detail ? `/${snapshot.detail}` : ''}`
      : `Agent failure: ${snapshot.category}`);
    this.name = 'AgentFailure';
  }
}
export interface FailureReport {
  diagnosticId: string; attempts: number; decision: RecoveryDecision;
  executionRisk: ExecutionRisk; first: Readonly<FailureSnapshot>; final: Readonly<FailureSnapshot>;
}
export class TurnFailure extends AgentFailure {
  constructor(readonly report: Readonly<FailureReport>) { super(report.final); }
}
export const diagnosticId = (): string => randomUUID();
function safeFailureReflection(value: unknown): boolean {
  let cursor: unknown = value;
  for (let depth = 0; cursor !== null && (typeof cursor === 'object' || typeof cursor === 'function'); depth++) {
    if (depth >= 32 || utilTypes.isProxy(cursor)) return false;
    for (const key of ['message', 'name', 'code', 'syscall', 'cause', 'snapshot']) {
      const descriptor = Object.getOwnPropertyDescriptor(cursor, key);
      if (descriptor && !('value' in descriptor) && !isNativeDomAccessor(value, cursor, key, descriptor)) return false;
    }
    cursor = Object.getPrototypeOf(cursor);
  }
  return true;
}
export function classifyFailure(error: unknown, source: FailureSnapshot['source'] = 'sdk_exception'): FailureSnapshot {
  // Reject reflection hazards in both the thrown value and its parse-error cause
  // before instanceof/property reads. Diagnostics flags never change this rule.
  if (!safeFailureReflection(error) || (error instanceof Error && !safeFailureReflection(error.cause))) {
    return {stage:'inference',category:'unknown',source,evidence:'unknown'};
  }
  if (error instanceof AgentFailure) return { ...error.snapshot };
  const msg = error instanceof Error ? error.message : '';
  const code = error instanceof Error ? (error as NodeJS.ErrnoException).code : undefined;
  if (error instanceof Error && error.name === 'TimeoutError') return { stage: 'inference', category: 'timeout', source, evidence: 'structured' };
  if (error instanceof Error && error.name === 'AbortError') return { stage: 'inference', category: 'cancelled', source, evidence: 'structured' };
  if (msg.startsWith('Failed to parse item:') && error instanceof Error && error.cause instanceof SyntaxError) {
    return { stage: 'jsonl_parse', category: /Unterminated string|Unexpected end of JSON/i.test(error.cause.message) ? 'jsonl_incomplete' : 'jsonl_invalid', source, evidence: 'structured' };
  }
  if (msg.startsWith('CODEX_JSONL_PROXY_BOOTSTRAP_FAILURE:')) return { stage: 'spawn', category: 'proxy_bootstrap', source, evidence: 'recognized_text' };
  // Only OS spawn errors carry positive evidence that no CLI was started.
  if (error instanceof Error && (error as NodeJS.ErrnoException).syscall?.startsWith('spawn') && code) {
    return { stage: 'spawn', category: ['EAGAIN', 'EMFILE', 'ENFILE'].includes(code) ? 'network_transient' : 'invalid_config', source, evidence: 'structured' };
  }
  // Never inspect subprocess stderr, rejected JSONL, or arbitrary tool text.
  if (/^Codex Exec exited with (?:code \d+|signal SIG[A-Z]+):/.test(msg)) return { stage: 'process_exit', category: 'process_exit', source, evidence: 'recognized_text' };
  if (source === 'sdk_event') {
    const exact: Array<[RegExp, FailureCategory, number?]> = [
      [/^(?:429 )?(?:insufficient_quota|quota exceeded|quota exhausted)$/i, 'quota_exhausted', 429],
      [/^(?:429 )?rate limit exceeded$/i, 'rate_limited', 429],
      [/^(?:503 )?service unavailable$/i, 'provider_unavailable', 503],
      [/^(?:502 )?bad gateway$/i, 'provider_unavailable', 502],
      [/^(?:500 )?internal server error$/i, 'provider_unavailable', 500],
      [/^(?:401 )?(?:unauthorized|authentication failed)$/i, 'auth', 401],
      [/^(?:403 )?(?:forbidden|permission denied)$/i, 'permission', 403],
      [/^(?:context_length_exceeded|context window exceeded|maximum context length exceeded)$/i, 'context_limit'],
      [/^invalid encrypted content$/i, 'invalid_encrypted_content'],
    ];
    for (const [pattern, category, httpStatus] of exact) if (pattern.test(msg)) return { stage: 'inference', category, source, evidence: 'recognized_text', ...(httpStatus ? { httpStatus } : {}) };
  }
  if (/^(?:stream closed before response\.completed|stream disconnected before completion(?:: stream closed before response\.completed)?)$/i.test(msg)) return { stage: 'inference', category: 'stream_interrupted', source, evidence: 'recognized_text' };
  return { stage: 'inference', category: 'unknown', source, evidence: 'unknown' };
}
export function failureReply(report: FailureReport): string {
  const ref = `编号 ${report.diagnosticId}`;
  if (report.final.stage === 'delivery') return `回答已生成，但消息投递未确认；不会重新执行任务。${ref}`;
  if (report.final.stage === 'history_commit') return `任务已结束，但本地结果存储失败；请先核对已收到的消息，不要直接重跑任务。${ref}`;
  const permanent: Partial<Record<FailureCategory, string>> = { auth: '模型认证失败', permission: '模型访问权限不足', context_limit: '输入超出模型上下文限制', quota_exhausted: '模型服务配额已耗尽', invalid_config: '模型启动配置错误', proxy_bootstrap: '本地模型代理启动失败', invalid_encrypted_content: '模型会话内容无法解密，需要核对会话状态' };
  const reason = permanent[report.final.category];
  const recovery = report.decision === 'exhausted' ? '恢复预算已用尽' : report.attempts > 1 ? `已额外尝试恢复 ${report.attempts - 1} 次，仍未成功` : '未满足安全自动恢复条件';
  return `${reason ?? '模型处理未完成'}；${recovery}。${report.executionRisk === 'proven_not_started' ? '本次模型执行未启动。' : '任务可能已部分执行，请先核对结果，避免重复操作。'}${ref}`;
}
