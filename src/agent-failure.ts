/** Classification stays closed; bounded original errors are carried separately for display. */
import { randomUUID } from 'node:crypto';
import { nativeErrorMessage, nativeErrorName } from './native-error.js';
import { redactErrorText } from './error-redaction.js';
import { safeFailureReflection, readDataProperty } from './error-reflection.js';
import { ERROR_LIMITS, limitText, type ErrorDetails } from './error-details.js';
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
export type RecoveryStopReason = 'disabled' | 'unsafe_effects' | 'ineligible_failure' | 'attempt_limit' | 'time_budget' | 'cancelled' | 'deadline';
export interface FailureReport {
  diagnosticId: string; attempts: number; decision: RecoveryDecision;
  executionRisk: ExecutionRisk; first: Readonly<FailureSnapshot>; final: Readonly<FailureSnapshot>;
  originalError?: Readonly<ErrorDetails>; finalError?: Readonly<ErrorDetails>;
  recoveryStopReason?: RecoveryStopReason;
  sessionMode?: 'start' | 'resume'; consecutiveFailures?: number;
  nextSessionAction?: 'continue' | 'replace' | 'wait';
}
export class TurnFailure extends AgentFailure {
  constructor(readonly report: Readonly<FailureReport>) { super(report.final); }
}
export const diagnosticId = (): string => randomUUID();
export function classifyFailure(error: unknown, source: FailureSnapshot['source'] = 'sdk_exception'): FailureSnapshot {
  // Reject reflection hazards in both the thrown value and its parse-error cause
  // before instanceof/property reads. Diagnostics flags never change this rule.
  if (!safeFailureReflection(error)) {
    return {stage:'inference',category:'unknown',source,evidence:'unknown'};
  }
  const cause = error instanceof Error ? readDataProperty(error, 'cause') : undefined;
  if (!safeFailureReflection(cause)) {
    return {stage:'inference',category:'unknown',source,evidence:'unknown'};
  }
  if (error instanceof AgentFailure) return { ...error.snapshot };
  const unknown = (): FailureSnapshot => ({stage:'inference',category:'unknown',source,evidence:'unknown'});
  if (!(error instanceof Error)) return unknown();
  const dataMessage = readDataProperty(error, 'message');
  const dataName = readDataProperty(error, 'name');
  const message = dataMessage === undefined ? nativeErrorMessage(error) : dataMessage;
  const name = dataName === undefined ? nativeErrorName(error) : dataName;
  const code = readDataProperty(error, 'code');
  const syscall = readDataProperty(error, 'syscall');
  const causeMessage = cause instanceof SyntaxError ? readDataProperty(cause, 'message') : undefined;
  // A data descriptor is not a type guarantee. Never coerce SDK objects or call
  // their string methods while reporting another failure.
  if ([message, name, code, syscall, causeMessage].some(value => value !== undefined && typeof value !== 'string')) return unknown();
  const msg = typeof message === 'string' ? message : '';
  if (name === 'TimeoutError') return { stage: 'inference', category: 'timeout', source, evidence: 'structured' };
  if (name === 'AbortError') return { stage: 'inference', category: 'cancelled', source, evidence: 'structured' };
  if (msg.startsWith('Failed to parse item:') && cause instanceof SyntaxError) {
    return { stage: 'jsonl_parse', category: /Unterminated string|Unexpected end of JSON/i.test(typeof causeMessage === 'string' ? causeMessage : '') ? 'jsonl_incomplete' : 'jsonl_invalid', source, evidence: 'structured' };
  }
  if (msg.startsWith('CODEX_JSONL_PROXY_BOOTSTRAP_FAILURE:')) return { stage: 'spawn', category: 'proxy_bootstrap', source, evidence: 'recognized_text' };
  // Only OS spawn errors carry positive evidence that no CLI was started.
  if (typeof syscall === 'string' && syscall.startsWith('spawn') && typeof code === 'string' && code) {
    return { stage: 'spawn', category: ['EAGAIN', 'EMFILE', 'ENFILE'].includes(code) ? 'network_transient' : 'invalid_config', source, evidence: 'structured' };
  }
  // Never inspect subprocess stderr, rejected JSONL, or arbitrary tool text.
  if (/^Codex Exec exited with (?:code \d+|signal SIG[A-Z]+):/.test(msg)) return { stage: 'process_exit', category: 'process_exit', source, evidence: 'recognized_text' };
  if (source === 'sdk_event') {
    // The gateway/SDK may wrap a transient upstream response instead of
    // emitting the bare "503 service unavailable" token. Keep the match
    // bounded to the structured HTTP status prefix; do not classify arbitrary
    // tool or model text as retryable.
    const wrappedStatus = /^unexpected status (503|502|500) (?:service unavailable|bad gateway|internal server error)(?::|$)/i.exec(msg);
    if (wrappedStatus) {
      const status = Number(wrappedStatus[1]);
      return { stage: 'inference', category: 'provider_unavailable', source, evidence: 'recognized_text', httpStatus: status };
    }
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
const reasonLabels: Record<FailureCategory, string> = {
  network_transient:'网络连接失败', stream_interrupted:'模型响应流中断', rate_limited:'模型服务限流',
  quota_exhausted:'模型服务配额已耗尽', provider_unavailable:'模型服务不可用', auth:'模型认证失败',
  permission:'模型访问权限不足', context_limit:'输入超出模型上下文限制', invalid_encrypted_content:'模型会话内容无法解密',
  invalid_config:'模型启动配置错误', jsonl_incomplete:'模型事件 JSONL 不完整', jsonl_invalid:'模型事件 JSONL 格式错误',
  proxy_bootstrap:'本地模型代理启动失败', process_exit:'模型进程退出', cancelled:'任务已取消', timeout:'任务超时',
  delivery_failed:'回答已生成，但消息投递未确认；不会重新执行任务', api_failed:'Octo API 请求失败',
  history_failed:'任务已结束，但本地结果存储失败', unknown:'模型执行失败，具体原因未识别',
};
const recoveryLabels: Record<RecoveryStopReason, string> = {
  disabled:'未重试：自动恢复未启用', unsafe_effects:'未重试：无法确认原任务是否已产生副作用',
  ineligible_failure:'未重试：当前失败不符合自动恢复条件', attempt_limit:'恢复失败：已达到最大尝试次数',
  time_budget:'恢复失败：恢复时间预算不足', cancelled:'恢复已停止：任务已取消', deadline:'恢复已停止：任务时限已到或剩余时间不足',
};
export function failureReply(report: FailureReport): string {
  const final = report.finalError;
  const first = report.originalError;
  const fallback = report.final.stage === 'delivery' ? reasonLabels.delivery_failed
    : report.final.stage === 'history_commit' ? reasonLabels.history_failed : reasonLabels[report.final.category];
  const recovery = report.recoveryStopReason ? recoveryLabels[report.recoveryStopReason]
    : report.decision === 'blocked_uncertain' ? recoveryLabels.unsafe_effects
    : report.decision === 'cancelled' ? recoveryLabels.cancelled
    : report.decision === 'exhausted' ? '恢复预算已用尽' : '未记录具体恢复停止原因';
  const actions = {continue:'下一条消息继续原线程', replace:'下一条消息将在旧执行停止后建立新线程', wait:'正在停止原执行，新请求将等待停止完成'};
  const suffix = [
    `失败类型：${fallback}`,
    `失败位置：${report.final.stage} / ${report.final.source} / ${report.final.category}`,
    ...(report.sessionMode ? [`会话状态：${report.sessionMode === 'resume' ? '恢复已有线程' : '新线程'}，该线程连续失败 ${report.consecutiveFailures ?? 0} 次。`] : []),
    `恢复结果：${recovery}${report.attempts > 1 ? `；已额外尝试恢复 ${report.attempts - 1} 次` : ''}。`,
    `执行状态：${report.executionRisk === 'proven_not_started' ? '本次模型执行未启动。' : '任务可能已部分执行，请先核对结果，避免重复操作。'}`,
    ...(report.nextSessionAction ? [`后续处理：${actions[report.nextSessionAction]}。`] : []),
    `诊断编号 ${limitText(redactErrorText(report.diagnosticId), 64)}`,
  ].join('\n');
  let detail = '';
  if (first && final && (first.message !== final.message || first.details !== final.details)) {
    detail = `首次错误：${limitText(redactErrorText(first.message), 500)}\n`;
  }
  detail = limitText(redactErrorText(detail + (final?.details || first?.details || 'SDK 未提供更多错误详情。')), ERROR_LIMITS.details);
  const message = limitText(redactErrorText(final?.message || first?.message || fallback), ERROR_LIMITS.message);
  const body = `执行失败：${message}\n\n异常详情：\n${detail}`;
  // Reserve metadata first; even a giant exception cannot displace its identifier.
  return limitText(body, ERROR_LIMITS.notice - Array.from(suffix).length - 2) + '\n\n' + suffix;
}
