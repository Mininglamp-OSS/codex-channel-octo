/**
 * Session Router — routing + concurrency control + mention gate + rate limiting.
 */

import { isOwnerSender } from './sender-context.js';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { AgentFailure, diagnosticId } from './agent-failure.js';
import { TurnContext, type TurnLedger, type InterruptedTurn } from './turn-context.js';
import type { Config } from './config.js';
import type { BotMessage } from './octo/types.js';
import { ChannelType, MessageType } from './octo/types.js';
import { sendMessage } from './octo/api.js';
import { isAuthenticCronFire } from './cron-fire-marker.js';
import { normalizeInboundMention, normalizeMessageId } from './inbound-mention.js';
import { MentionPreferences } from './mention-prefs.js';
import { summarizeAgentError } from './agent-errors.js';
import { ConversationMarkdown, type ConversationTurnContext } from './conversation-md.js';
import type { AdmissionReservation, ContinuationPort, ContinuationTurn, DispatchObserver, ReservationResult } from './cards/contracts.js';
import { continuationMessage, getContinuation } from './cards/continuation.js';
import { canLoadPrivateMemory, privateMemorySessionKey } from './private-memory.js';

export interface RouteResult {
  sessionKey: string;
  shouldProcess: boolean;
  message: BotMessage;
  /** User content with leading @botname stripped (for LLM input). */
  cleanContent?: string;
  interruptedTurn?: InterruptedTurn;
  /**
   * Reason for rejection when shouldProcess is false.
   *
   * Only emitted for cases where the caller should treat the message as
   * 'do-not-cache-in-group-context' (rate-limited or oversized — these are
   * actively-rejected messages from a flooder). Silent-drop cases (blocked
   * bot, self message, system event, not mentioned) leave rejectionReason
   * undefined: those messages are legitimate group chatter the agent
   * should still see in [Group context].
   *
   * C1 / P2.5 (Stage 6): added to fix the channel where rate-limited or
   * oversized messages still polluted the group context cache. C1 follow-up
   * cleanup (齐静春 PR#41 review): trimmed to the 2 reasons actually emitted
   * so the type doesn't suggest a wider contract than the code provides.
   * Add more reasons here when corresponding emit sites land.
   */
  rejectionReason?: 'rate_limited' | 'oversized' | 'quarantined' | 'control' | 'stopping';
}

interface TokenBucket {
  tokens: number;
  lastRefill: number;
  /** Whether the user has already been notified of rate limiting in this window. */
  notified: boolean;
}

const BUCKET_STALE_MS = 5 * 60 * 1000; // 5 minutes
const CLEANUP_WAIT_MS = 3000;

/** Global rate limit: 10x per-session limit, shared across all sessions. */
const GLOBAL_RATE_MULTIPLIER = 10;

/** Maximum allowed content length in bytes (Q10). Messages exceeding this are rejected. */
const MAX_CONTENT_BYTES = 32_768; // 32 KB

export class SessionRouter {
  private readonly config: Config;
  private readonly robotId: string;
  /** G18: owner_uid from registerBot. Stored for future permission model. */
  private readonly ownerUid: string | (() => string);
  private readonly inboundQueues = new Map<string, Promise<void>>();
  private readonly tokenBuckets = new Map<string, TokenBucket>();
  /** G20: per-user buckets keyed by from_uid alone (cross-channel rate limit). */
  private readonly userBuckets = new Map<string, TokenBucket>();
  private globalBucket: TokenBucket | null = null;
  private pausedGlobalBucket: TokenBucket | null = null;
  /**
   * G14: UIDs known to be bots. Initialized with this bot's robotId; can be
   * extended via registerKnownBot() for future multi-bot deployments.
   */
  private readonly knownBotUids = new Set<string>();
  private readonly mentionPreferences: MentionPreferences;
  private readonly executions = new Set<Promise<void>>();
  private readonly turns = new Map<TurnContext, string>();
  private stopping = false;
  private lifecycleClosed = false;
  private readonly quarantineNotices = new Map<string, number>();
  private readonly quarantined = new Map<string, string>();
  private readonly pendingCleanup = new Map<string, TurnContext>();
  private readonly ledger?: TurnLedger;
  private readonly conversationMarkdown: ConversationMarkdown;
  private dispatchObserver?: DispatchObserver;
  private readonly continuationReservations = new WeakMap<AdmissionReservation, { turn: ContinuationTurn; release: () => void }>();
  private readonly lockedContinuations = new WeakSet<ContinuationTurn>();
  private readonly continuationDispatches = new WeakMap<BotMessage, { result: RouteResult; turn: TurnContext; used: boolean }>();
  private continuationHandler?: (message: BotMessage) => Promise<void>;

  constructor(config: Config, robotId: string, ownerUid: string | (() => string) = '', documentStore?: import('./conversation-md.js').ConversationDocumentStore) {
    if (documentStore && 'beginTurn' in documentStore) this.ledger = documentStore as typeof documentStore & TurnLedger;
    this.config = config;
    this.robotId = robotId;
    this.ownerUid = ownerUid;
    this.knownBotUids.add(robotId);
    this.mentionPreferences = new MentionPreferences(config);
    this.conversationMarkdown = new ConversationMarkdown(config, documentStore);
  }

  /**
   * Card runtime hook: told the exact dispatch handle id when that dispatch
   * times out. It observes only; ordinary timeout handling is unchanged.
   */
  setDispatchObserver(observer: DispatchObserver | undefined): void {
    this.dispatchObserver = observer;
  }

  /** Internal pipeline adapter; no event payload or serialized nonce is trusted. */
  setContinuationHandler(handler: ((message: BotMessage) => Promise<void>) | undefined): void {
    this.continuationHandler = handler;
  }

  /** The router locks/rate-limits raw routes; history and card bindings use the effective key. */
  private continuationKeys(turn: ContinuationTurn): { routeKey: string; historyKey: string } {
    const message = { from_uid: turn.requesterUid, channel_id: turn.route.channelId, channel_type: turn.route.channelType } as BotMessage;
    const routeKey = this.sessionKey(message);
    const historyKey = this.config.privateMemory?.enabled === true
      ? privateMemorySessionKey(routeKey, canLoadPrivateMemory(this.config, message, this.getOwnerUid())) : routeKey;
    return { routeKey, historyKey };
  }

  preflightContinuation(turn: ContinuationTurn): ReservationResult {
    const detail = getContinuation(turn);
    if (!this.lockedContinuations.has(turn) || this.stopping || !this.continuationHandler || !detail || !detail.current()) return { accepted: false, reason: 'closing' };
    if (!this.isSupportedChannel(turn.route.channelType)) return { accepted: false, reason: 'unsupported_channel' };
    const { routeKey, historyKey } = this.continuationKeys(turn);
    if (historyKey !== turn.sessionKey) return { accepted: false, reason: 'unsupported_channel' };
    if (this.ledger?.getQuarantinedTurnId(routeKey) || this.quarantined.has(routeKey)) return { accepted: false, reason: 'closing' };
    if (this.checkAllRateLimits(routeKey, turn.requesterUid)) return { accepted: false, reason: 'rate_limited' };
    const max = this.config.rateLimit.maxPerMinute;
    const buckets = [this.globalBucket!, this.userBuckets.get(turn.requesterUid)!, this.tokenBuckets.get(`${routeKey}\n${turn.requesterUid}`)!];
    let released = false;
    const reservation = Object.freeze({}) as AdmissionReservation;
    this.continuationReservations.set(reservation, { turn, release: () => {
      if (released) return; released = true;
      buckets.forEach((b, i) => { b.tokens = Math.min(max * (i === 0 ? GLOBAL_RATE_MULTIPLIER : 1), b.tokens + 1); });
    } });
    return { accepted: true, reservation };
  }

  releaseContinuation(reservation: AdmissionReservation): void {
    const held = this.continuationReservations.get(reservation);
    this.continuationReservations.delete(reservation); held?.release();
  }

  /** Admission uses this port so preflight, T2 and execution cannot interleave a reset. */
  withContinuationLock<T>(turn: ContinuationTurn, fn: (port: ContinuationPort) => Promise<T>): Promise<T> {
    return this.withSessionLock(this.continuationKeys(turn).routeKey, async () => {
      this.lockedContinuations.add(turn);
      const reservations: AdmissionReservation[] = [];
      const port: ContinuationPort = {
        preflightContinuation: candidate => {
          if (candidate !== turn) return { accepted: false, reason: 'closing' };
          const result = this.preflightContinuation(candidate);
          if (result.accepted) reservations.push(result.reservation);
          return result;
        },
        dispatchContinuation: (candidate, reservation) => this.dispatchContinuationLocked(candidate, reservation),
      };
      try { return await fn(port); }
      finally {
        this.lockedContinuations.delete(turn);
        reservations.forEach(r => this.releaseContinuation(r));
      }
    });
  }

  dispatchContinuation(turn: ContinuationTurn, reservation: AdmissionReservation): Promise<void> {
    return this.withSessionLock(this.continuationKeys(turn).routeKey, () => this.dispatchContinuationLocked(turn, reservation));
  }

  private async dispatchContinuationLocked(turn: ContinuationTurn, reservation: AdmissionReservation): Promise<void> {
    const held = this.continuationReservations.get(reservation);
    const detail = getContinuation(turn);
    if (!held || held.turn !== turn || !detail || !turn.admissionId) return;
    if (this.stopping || !this.continuationHandler || !await detail.authorize() || !detail.current()
      || this.stopping || !this.continuationHandler || this.continuationReservations.get(reservation) !== held
      || this.continuationKeys(turn).historyKey !== turn.sessionKey) return;
    this.continuationReservations.delete(reservation); // consumed once; no refund after dispatch
    const message = continuationMessage(turn);
    const { routeKey } = this.continuationKeys(turn);
    const result: RouteResult = { sessionKey: routeKey, shouldProcess: true, message, cleanContent: detail.prompt,
      interruptedTurn: this.ledger?.getInterruption(routeKey) };
    await this.runHandlerWithTimeout(result, async (_result, context) => {
      this.continuationDispatches.set(message, { result, turn: context, used: false });
      try { await this.continuationHandler!(message); }
      finally { this.continuationDispatches.delete(message); }
    });
  }

  /** G14: register another known bot uid (future multi-bot support). */
  registerKnownBot(uid: string): void {
    if (uid) this.knownBotUids.add(uid);
  }

  /**
   * Unregister a sibling bot uid (hot-reload: a bot was removed at runtime).
   * Never drops this router's OWN robotId — self is always a bot, removing it
   * would let the loop guard treat this bot's own echoes as user input.
   */
  unregisterKnownBot(uid: string): void {
    if (uid && uid !== this.robotId) this.knownBotUids.delete(uid);
  }

  /** Test/diagnostics: snapshot of currently-known bot uids. */
  knownBotUidsSnapshot(): ReadonlySet<string> {
    return new Set(this.knownBotUids);
  }

  /** G18: owner_uid stored from registerBot. Used by future permission model. */
  getOwnerUid(): string {
    return typeof this.ownerUid === 'function' ? this.ownerUid() : this.ownerUid;
  }

  getConversationMd(channelId: string, channelType: ChannelType): Promise<string | undefined> {
    return this.conversationMarkdown.get(channelId, channelType);
  }

  prepareConversationMd(channelId: string, channelType: ChannelType, threadId?: string, storageSessionKey = channelId): Promise<ConversationTurnContext> {
    return this.conversationMarkdown.prepareTurn(channelId, channelType, threadId, storageSessionKey);
  }

  /**
   * Acquire a per-session lock for the full message handling pipeline.
   * Callers (e.g. index.ts) use this to ensure the entire handleMessage
   * chain — not just routing — runs serially per session key.
   */
  async withSessionLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.inboundQueues.get(key) ?? Promise.resolve();
    let resolveGate!: () => void;
    const gate = new Promise<void>((r) => {
      resolveGate = r;
    });
    this.inboundQueues.set(key, gate);

    try {
      await prev;
      return await fn();
    } finally {
      resolveGate();
      if (this.inboundQueues.get(key) === gate) {
        this.inboundQueues.delete(key);
      }
    }
  }

  /**
   * Route a message and, if it should be processed, run the handler callback
   * under the same per-session lock. This ensures no gap between route decision
   * and pipeline execution — concurrent same-session messages cannot interleave.
   */
  /**
   * Route a message and, if it should be processed, run the handler callback
   * under the same per-session lock. This ensures no gap between route decision
   * and pipeline execution — concurrent same-session messages cannot interleave.
   *
   * Returns the RouteResult (or `null` for silent-drop cases) so the caller
   * can inspect `rejectionReason` to decide whether the message should still
   * influence downstream side-effects like group context caching
   * (C1 / P2.5 — stage 6).
   */
  async routeAndHandle(
    msg: BotMessage,
    handler: (result: RouteResult, turn: TurnContext) => Promise<void>,
  ): Promise<RouteResult | null> {
    const continuation = this.continuationDispatches.get(msg);
    if (continuation) {
      const detail = getContinuation(msg);
      if (continuation.used || !detail || !detail.current()) return null;
      const keys = this.continuationKeys(detail.turn);
      if (keys.historyKey !== detail.turn.sessionKey || keys.routeKey !== continuation.result.sessionKey) return null;
      continuation.used = true;
      await handler(continuation.result, continuation.turn);
      return continuation.result;
    }
    const key = this.sessionKey(msg);
    return this.withSessionLock(key, async () => {
      if (this.stopping) return { sessionKey: key, shouldProcess: false, message: msg, rejectionReason: 'stopping' };
      // Cleanup is independent of the sender; finish it before computing
      // admission limits so a newly unblocked model turn pays the global budget.
      const pending = this.pendingCleanup.get(key);
      if (pending) {
        const blocked = this.ledger ? this.ledger.getQuarantinedTurnId(key) : this.quarantined.get(key);
        if (blocked !== pending.turnId) {
          pending.disposeExecutions(); this.pendingCleanup.delete(key);
        } else if (await pending.waitForStopped(0)) {
          this.ledger?.finishTurn(key,pending.turnId,'clean');
          this.quarantined.delete(key); this.quarantineNotices.delete(key); this.pendingCleanup.delete(key);
        }
      }
      const result = await this.processMessage(msg, key, true);
      if (!result || !result.shouldProcess) return result;
      if (this.stopping) return { ...result, shouldProcess:false, rejectionReason:'stopping' };
      // Control commands pass transport/mention and session/user rate gates but do not
      // enter the model or begin a new execution generation.
      if (await this.handleReconciliation(result)) {
        return { ...result, shouldProcess:false, rejectionReason:'control' };
      }
      // SQLite is authoritative when present: an offline release must not be
      // shadowed forever by the router's in-memory quarantine cache.
      const quarantinedId = this.ledger
        ? this.ledger.getQuarantinedTurnId(key)
        : this.quarantined.get(key);
      if (quarantinedId) {
        const lastNotice = this.quarantineNotices.get(key);
        if (lastNotice === undefined || Date.now() - lastNotice >= 60_000) {
          if (this.quarantineNotices.size >= 1000) this.quarantineNotices.delete(this.quarantineNotices.keys().next().value!);
          this.quarantineNotices.delete(key);
          this.quarantineNotices.set(key, Date.now());
          await this.replySafe(msg, this.pauseNotice(msg, key, quarantinedId));
        }
        return { ...result, shouldProcess:false, rejectionReason:'quarantined' };
      }
      if (result && result.shouldProcess) {
        result.interruptedTurn = this.ledger?.getInterruption(key);
        const admitted = await this.runHandlerWithTimeout(result, handler);
        if (!admitted) return { ...result, shouldProcess: false, rejectionReason: 'stopping' };
      }
      return result;
    });
  }

  /** Shutdown tracks real handler completion, even after the queue gate settles. */
  async stopTurns(graceMs = 5000): Promise<void> {
    this.stopping = true;
    for (const [turn, session] of this.turns) {
      turn.cancel();
      this.finishCancelledTurn(session, turn);
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([Promise.allSettled([...this.executions]), new Promise<void>(resolve => { timer = setTimeout(resolve, graceMs); })]);
    if (timer) clearTimeout(timer);
    this.lifecycleClosed = true;
    // Settled failed turns are no longer in `turns`/`executions`. Release
    // their socket resources without treating disposal as stopped proof.
    for (const pending of this.pendingCleanup.values()) pending.disposeExecutions();
    this.pendingCleanup.clear();
  }

  private async runHandlerWithTimeout(result: RouteResult, handler: (result: RouteResult, turn: TurnContext) => Promise<void>): Promise<boolean> {
    if (this.stopping) return false;
    const id = diagnosticId();
    const generation = this.ledger?.beginTurn(result.sessionKey, id) ?? 1;
    const turn = new TurnContext(this.config.dispatchTimeoutMs, generation, id);
    this.turns.set(turn, result.sessionKey);
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let timedOut = false;
    // The timeout path remains quarantined even if a cancelled promise settles:
    // subprocess/remote-effect termination cannot be proven by promise completion.
    const task = Promise.resolve().then(() => handler(result, turn));
    const settled = task.then(() => {}, err => {
      if (!turn.signal.aborted) {
        turn.interruption = 'failed';
        console.error('session-router: handler error', summarizeAgentError(err));
      }
    }).finally(async () => {
      turn.revoke();
      try {
        if (this.lifecycleClosed) {
          if (!(await turn.waitForStopped(CLEANUP_WAIT_MS))) turn.disposeExecutions();
          return;
        }
        // Synchronous work can hit its deadline before the timer callback runs.
        // Keep persisted interruption metadata consistent with timeout feedback.
        const abortReason = performance.now() >= turn.deadline && !this.stopping ? 'timed_out' : 'cancelled';
        const interrupted = turn.interruption ?? (turn.signal.aborted ? abortReason : turn.needsReconciliation ? 'failed' : undefined);
        if (interrupted) {
          this.ledger?.recordInterruption(result.sessionKey, {turnId:turn.turnId,reason:interrupted,executionRisk:turn.executionRisk,stage:turn.stage});
          const stopped = await turn.waitForStopped(CLEANUP_WAIT_MS);
          if (this.lifecycleClosed) {
            if (!stopped) turn.disposeExecutions();
            return; // The owner may have closed SQLite.
          }
          // Cleanup evidence reopens execution; it never asserts that external
          // operations rolled back, nor retries the previous user request.
          if (!stopped && !this.ledger) this.quarantined.set(result.sessionKey,turn.turnId);
          if (!stopped) this.pendingCleanup.set(result.sessionKey,turn);
          if (stopped) this.quarantined.delete(result.sessionKey);
          this.ledger?.finishTurn(result.sessionKey,turn.turnId,stopped ? 'clean' : 'quarantined');
        } else {
          turn.disposeExecutions();
          this.ledger?.finishTurn(result.sessionKey,turn.turnId,'clean');
          if (turn.interruptionPresented && result.interruptedTurn) this.ledger?.consumeInterruption(result.sessionKey,result.interruptedTurn.turnId);
        }
      } finally {
        this.executions.delete(settled); this.turns.delete(turn);
      }
    });
    this.executions.add(settled);
    let onAbort!: () => void;
    const cancelled = new Promise<void>(resolve => {
      onAbort = resolve; turn.signal.addEventListener('abort', onAbort, { once:true });
    });
    try {
      const waits: Promise<void>[] = [settled, cancelled];
      if (this.config.dispatchTimeoutMs > 0) waits.push(new Promise<void>(resolve => {
        timeout = setTimeout(() => { timedOut = true; turn.interruption = 'timed_out'; turn.cancel(); resolve(); }, this.config.dispatchTimeoutMs);
      }));
      await Promise.race(waits);
      if ((timedOut || performance.now() >= turn.deadline) && !this.stopping) {
        turn.interruption = 'timed_out';
        try { this.dispatchObserver?.onTimeout(id); } catch { /* observer-only: never alters timeout handling */ }
        this.finishCancelledTurn(result.sessionKey, turn);
        await this.replySafe(result.message, turn.executionRisk === 'proven_not_started' ? `⚠️ 任务超时，模型执行未启动；可以发送新任务。编号 ${turn.turnId}` : `⚠️ 任务超时，正在停止原执行。新请求将等待停止完成；部分操作可能已完成。编号 ${turn.turnId}`);
        await this.waitForCleanup(settled, result, turn);
      } else if (turn.signal.aborted && !this.stopping) {
        this.finishCancelledTurn(result.sessionKey, turn);
        await this.replySafe(result.message, `⚠️ 任务已取消，正在停止原执行。编号 ${turn.turnId}`);
        await this.waitForCleanup(settled, result, turn);
      }
    } finally { if (timeout) clearTimeout(timeout); turn.signal.removeEventListener('abort',onAbort); }
    return true;
  }

  private finishCancelledTurn(session: string, turn: TurnContext): void {
    turn.interruption ??= 'cancelled';
    this.ledger?.recordInterruption(session,{turnId:turn.turnId,reason:turn.interruption,executionRisk:turn.executionRisk,stage:turn.stage});
    const uncertain = turn.executionRisk !== 'proven_not_started';
    if (uncertain && !this.ledger) this.quarantined.set(session, turn.turnId);
    this.ledger?.finishTurn(session, turn.turnId, uncertain ? 'quarantined' : 'clean');
  }

  private async waitForCleanup(settled: Promise<void>, result: RouteResult, turn: TurnContext): Promise<void> {
    if (turn.executionRisk === 'proven_not_started') return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const ended = await Promise.race([settled.then(() => true),new Promise<boolean>(resolve => {timer=setTimeout(()=>resolve(false),CLEANUP_WAIT_MS);})]);
      const paused = this.ledger ? this.ledger.getQuarantinedTurnId(result.sessionKey) : this.quarantined.get(result.sessionKey);
      await this.replySafe(result.message, ended && !paused
        ? `✓ 原任务执行已结束。可以发送新任务，或要求继续上个任务；不会自动重跑。编号 ${turn.turnId}`
        : `⚠️ 原任务停止尚未确认，后续请求会重新检查清理结果。${this.pauseNotice(result.message,result.sessionKey,turn.turnId)}`);
    } finally { if (timer) clearTimeout(timer); }
  }

  private isControlOwner(msg: BotMessage): boolean {
    return isOwnerSender(msg, this.getOwnerUid());
  }

  private auditReconciliation(msg: BotMessage, target: string, turnId: string | undefined,
    outcome: 'unauthorized' | 'invalid_command' | 'dm_required' | 'turn_mismatch' | 'handler_running' | 'active' | 'released' | 'store_failed'): void {
    // Linkable locally, without raw private session/actor identifiers or command text.
    const digest = (value: string) => createHash('sha256').update(value).digest('hex');
    console.info('[codex-channel-octo] reconciliation', JSON.stringify({
      actorHash: digest(msg.from_uid), targetHash: digest(target), turnId, outcome,
    }));
  }

  private pauseNotice(msg: BotMessage, key: string, turnId: string): string {
    const prefix = `⚠️ 上次任务的执行状态尚未确认，本会话暂停新任务。编号 ${turnId}。`;
    if (this.isControlOwner(msg)) return `${prefix}核对外部结果后发送 /reconcile ${turnId} --external-results-verified 恢复；不会重跑旧任务。`;
    return `${prefix}请将编号和会话标识 ${key} 交给维护者。只有来信 UID 与注册 owner_uid 完全一致的主人可在本人私聊中发送 /reconcile ${turnId} --session ${key} --external-results-verified；若通道改写主人 UID，则必须由维护者停止网关后使用离线恢复流程，本频道无法授权解除。不会重跑旧任务。`;
  }

  /** Registration-bound control path; never invokes a model or resets history. */
  private async handleReconciliation(result: RouteResult): Promise<boolean> {
    const { message: msg, sessionKey: key, cleanContent } = result;
    if (msg.payload.type !== MessageType.Text || this.isCronFire(msg)) return false;
    const body = cleanContent?.trim() ?? '';
    if (!/^\/reconcile(?:\s|$)/i.test(body)) return false;
    if (!this.isControlOwner(msg)) {
      // Silent on healthy sessions; mark control so commands never enter history.
      this.auditReconciliation(msg, key, undefined, 'unauthorized');
      if (this.ledger?.isTurnQuarantined(key) || this.quarantined.has(key)) {
        await this.replySafe(msg, '此来信 UID 无法与注册 owner_uid 精确核验；如通道改写 UID，请由维护者停止网关并按离线恢复流程处理。');
      }
      return true;
    }
    const match = /^\/reconcile\s+([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:\s+--session\s+([^\s\x00-\x1f\x7f]{1,512}))?\s+--external-results-verified$/i.exec(body);
    if (!match) {
      this.auditReconciliation(msg, key, undefined, 'invalid_command');
      await this.replySafe(msg, '核对外部结果后发送 /reconcile <任务编号> [--session <会话标识>] --external-results-verified；指定其他会话时请从本人私聊发送。');
      return true;
    }
    const target = match[2] ?? key;
    if (match[2] && msg.channel_type !== ChannelType.DM) {
      this.auditReconciliation(msg, target, match[1].toLowerCase(), 'dm_required');
      await this.replySafe(msg, '请从与机器人的本人私聊中指定目标会话。');
      return true;
    }
    // These checks and the conditional SQLite update are synchronous: another
    // queued turn cannot interleave. Never nest session locks (cross-target
    // commands could deadlock); active rows and retained handlers fail closed.
    let reply: string;
    const id = match[1].toLowerCase();
    let outcome: 'turn_mismatch' | 'handler_running' | 'active' | 'released';
    try {
      const currentId = this.ledger ? this.ledger.getQuarantinedTurnId(target) : this.quarantined.get(target);
      // Do not disclose third-party runtime state for a guessed key/wrong ID.
      if (currentId !== id) {
        outcome = 'turn_mismatch';
        reply = '任务编号与目标会话的暂停记录不匹配，请检查编号和会话标识。';
      } else if ([...this.turns.values()].includes(target)) {
        outcome = 'handler_running';
        reply = '原任务仍在停止处理中，暂时不能恢复，请稍后再试。';
      } else if (this.ledger?.getTurnState(target) === 'active') {
        outcome = 'active';
        reply = '目标任务仍标记为运行中，不能解除隔离；请联系维护者核对运行状态，任务编号不一定有误。';
      } else {
        const released = this.ledger ? this.ledger.reconcileTurn(target, id) : this.quarantined.get(target) === id;
        if (released) { this.quarantined.delete(target); this.quarantineNotices.delete(target); }
        outcome = released ? 'released' : 'turn_mismatch';
        reply = released ? '✓ 目标会话已恢复，没有重跑旧任务。可以发送新消息。' : '任务编号与目标会话的暂停记录不匹配，请检查编号和会话标识。';
      }
    } catch {
      this.auditReconciliation(msg, target, id, 'store_failed');
      throw new AgentFailure({ stage: 'prepare', category: 'history_failed', source: 'local', evidence: 'structured' });
    }
    this.auditReconciliation(msg, target, id, outcome);
    await this.replySafe(msg, reply);
    return true;
  }

  async route(msg: BotMessage): Promise<RouteResult | null> {
    const key = this.sessionKey(msg);
    return this.withSessionLock(key, () => this.processMessage(msg, key));
  }

  sessionKey(msg: BotMessage): string {
    const spaceId = this.extractSpaceId(msg);
    if (msg.channel_type === ChannelType.DM) {
      // DM is per-user (private): same peer always resumes the same session.
      // from_uid IS the peer's identity here; a missing one is unroutable —
      // never fall back to '' (that would collapse every uid-less DM into ONE
      // shared session across unrelated peers, leaking history/memory). Mirrors
      // the group channel_id guard below. Caught upstream → message dropped.
      if (!msg.from_uid) {
        throw new Error('DM message has no from_uid — cannot derive a session key');
      }
      return spaceId ? `${spaceId}:${msg.from_uid}` : msg.from_uid;
    }
    // Group is per-CHANNEL (shared): every member of a group shares one session,
    // history, working dir, and memory — a group is a collective workspace, not
    // N private chats. (Reverses the per-(channel×user) split from PR #64; see
    // src/cwd-resolver.ts header. Space isolation is implicit: one bot = one
    // space = one process with its own dataDir/cwdBase/memoryBase.)
    //
    // channel_id IS the group's identity here, so a missing one is unroutable —
    // never fall back to '' (that would collapse every channel-less group message
    // into ONE shared session across unrelated channels, leaking history/memory
    // between them). Fail loud instead; route() treats the throw as a drop.
    if (!msg.channel_id) {
      throw new Error('Group message has no channel_id — cannot derive a session key');
    }
    return msg.channel_id;
  }

  /**
   * Extract spaceId from channel_id.
   * DM format: s{spaceId}_{uid1}@s{spaceId}_{uid2}
   * Group format: s{spaceId}_{groupNo} (but groups already use channel_id in key)
   */
  private extractSpaceId(msg: BotMessage): string {
    // For groups, channel_id already provides isolation
    if (this.isGroupLike(msg.channel_type)) return "";
    // DM: try from_uid first (format: s{spaceId}_{peerId})
    const uid = msg.from_uid;
    if (uid.startsWith("s")) {
      const lastUnderscore = uid.lastIndexOf("_");
      if (lastUnderscore > 0) {
        return uid.substring(1, lastUnderscore);
      }
    }
    // DM compound: s{spaceId}_{uid1}@s{spaceId}_{uid2}
    const channelId = msg.channel_id;
    if (channelId && channelId.startsWith("s")) {
      const atIdx = channelId.indexOf("@");
      const firstPart = atIdx > 0 ? channelId.substring(0, atIdx) : channelId;
      if (firstPart.startsWith("s")) {
        const lastUnderscore = firstPart.lastIndexOf("_");
        if (lastUnderscore > 0) {
          return firstPart.substring(1, lastUnderscore);
        }
      }
    }
    return "";
  }

  private isBlockedBot(uid: string): boolean {
    return this.config.botBlocklist?.includes(uid) ?? false;
  }

  /**
   * G14: Heuristic bot detection. Octo bot uids conventionally end in `_bot`.
   * This is NOT a perfect check — a human could pick that suffix — but it
   * catches the common case where a bot DMs another bot and triggers an
   * uncontrolled response loop. Bots whitelisted in `allowedBotUids` bypass
   * this gate.
   */
  private looksLikeBot(uid: string): boolean {
    if (this.knownBotUids.has(uid)) return true;
    if (uid.endsWith('_bot')) return true;
    return false;
  }

  private isAllowedBot(uid: string): boolean {
    return this.config.allowedBotUids?.includes(uid) ?? false;
  }

  private isGroupLike(channelType: ChannelType | undefined): boolean {
    return channelType === ChannelType.Group || channelType === ChannelType.CommunityTopic;
  }

  /**
   * Allowlist of channel types we actually converse on: DM, Group, and
   * CommunityTopic. Octo also emits system/command channels (e.g. channel_type
   * 8 "systemcmdonline" on connect) which are NOT user conversations — those
   * must be dropped, otherwise they fall through the DM/group gates and get
   * answered with an unsolicited LLM reply. Found in live deployment (#68).
   */
  private isSupportedChannel(channelType: ChannelType | undefined): boolean {
    return channelType === ChannelType.DM || this.isGroupLike(channelType);
  }

  private isMentioned(msg: BotMessage): boolean {
    const mention = normalizeInboundMention(msg.payload.mention, this.robotId);
    if (mention.mention_source === 'invalid') {
      const fingerprint = (value: unknown): string | null => {
        const id = normalizeMessageId(value);
        return id === null ? null : createHash('sha256').update(id).digest('hex');
      };
      console.warn('[codex-channel-octo] invalid mention metadata', JSON.stringify({
        channelHash: fingerprint(msg.channel_id), messageHash: fingerprint(msg.message_id), mention_source: 'invalid',
      }));
    }
    // Note: mention.all is a humans-only signal (@所有人), bots do NOT respond.
    // Admission compatibility is separate from the bounded prompt snapshot.
    // Scan without copying/serializing oversized transport arrays; never use
    // String.includes, which would admit partial UID matches.
    const raw = msg.payload.mention as unknown as { uids?: unknown } | undefined;
    const routingUids = raw?.uids;
    const legacyTarget = mention.mention_source === 'invalid'
      && (routingUids === this.robotId
        || (Array.isArray(routingUids) && routingUids.some(uid => uid === this.robotId)));
    return mention.is_explicitly_mentioned || mention.mentioned_ais || legacyTarget;
  }

  /**
   * #115: True for a GENUINE in-process cron fire — `payload._cronFire` AND a
   * matching per-process nonce. Such messages bypass the group @mention gate
   * (owner-gated at creation, bound to this session). A forged inbound payload
   * can set `_cronFire` but not the secret nonce, so it does not pass. Real
   * inbound messages never carry the marker.
   */
  private isCronFire(msg: BotMessage): boolean {
    return isAuthenticCronFire(msg.payload);
  }

  private async processMessage(msg: BotMessage, key: string, quarantineAware = false): Promise<RouteResult | null> {
    // Drop anything that isn't a real conversation channel (DM / group /
    // community topic). Octo emits system/command channels (e.g. channel_type 8
    // "systemcmdonline" on connect) that otherwise slip past the DM/group gates
    // and get an unsolicited reply (#68).
    if (!this.isSupportedChannel(msg.channel_type)) return null;

    // Skip stream update messages (G21) — only process final (non-stream) messages.
    // When streamOn is true, this is a partial update of an ongoing stream; the final
    // message arrives with streamOn=false and contains the complete content.
    if (msg.streamOn) return null;

    // Preference events are self-only. Markdown events may come from human
    // editors and are refetch hints; authenticated GET determines the contents.
    // Both use the transport channel, never the payload's claimed target.
    if (msg.payload.event) {
      this.conversationMarkdown.onEvent(msg);
      if (this.isGroupLike(msg.channel_type)
        && msg.from_uid === this.robotId
        && msg.payload.event.type === 'mention_pref_updated') {
        this.mentionPreferences.invalidate(msg.channel_id!);
      }
      return null;
    }

    // Ordinary self messages must still be dropped to prevent reply loops.
    if (msg.from_uid === this.robotId) return null;

    // DM blocklist filter.
    if (msg.channel_type === ChannelType.DM && this.isBlockedBot(msg.from_uid)) {
      return null;
    }

    // G14: DM from anything that looks like a bot — silently drop unless
    // explicitly whitelisted. Prevents bot↔bot reply loops.
    if (
      msg.channel_type === ChannelType.DM &&
      this.looksLikeBot(msg.from_uid) &&
      !this.isAllowedBot(msg.from_uid)
    ) {
      return null;
    }

    // Group: drop messages from other bots (blocklisted or self) entirely.
    if (this.isGroupLike(msg.channel_type) && this.isBlockedBot(msg.from_uid)) {
      return null;
    }

    // G14: Group messages from bot-looking uids — only respond if explicitly
    // @-mentioned. The mention gate below already enforces this, but bots in
    // the blocklist (above) get hard-dropped without even checking mentions.

    // Group mention gate — skip unless mentioned OR in mention-free group (G12).
    // #115: cron-fired synthetic messages bypass the @mention requirement — they
    // were created (owner-gated) and bound to this session; there's no human to
    // @-mention the bot at fire time. Rate limiting below still applies.
    if (this.isGroupLike(msg.channel_type) && !this.isMentioned(msg) && !this.isCronFire(msg)) {
      // Multi-bot loop guard: in a mention-free group there is no @-mention gate
      // to stop one bot from replying to another bot's plain-text message. Drop
      // messages from known/bot-looking uids (unless explicitly whitelisted) so
      // two bots in the same mention-free room cannot enter an unbounded reply
      // loop. An @-mention still goes through (handled by the branch above).
      if (this.looksLikeBot(msg.from_uid) && !this.isAllowedBot(msg.from_uid)) {
        return null;
      }
      // Explicit operator allowlists keep their existing exact-channel semantics.
      // Otherwise consult the server's parent-group policy, including AI sessions,
      // and only admit confirmed humans (or explicitly allowed member bots).
      const isMentionFree = this.config.mentionFreeGroups?.includes(msg.channel_id!) ?? false;
      if (!isMentionFree && !await this.mentionPreferences.allows(
        msg.channel_id!, msg.from_uid, this.isAllowedBot(msg.from_uid),
      )) return null;
    }

    // Rate limit check BEFORE non-text check — prevents DM spam of non-text
    // messages from bypassing rate limiting entirely.
    // G20 fix: peek all three buckets without consuming; only consume on full
    // pass. On block, attach notified state to the actual blocking bucket so
    // the debounce reply doesn't spam when a different bucket has tokens.
    // #115: cron fires skip the rate limit — a scheduler-fired task is an
    // operator-scheduled action (already bounded by the cron interval), not
    // user spam. Without this a fire that lands while the owner's bucket is
    // exhausted would be silently dropped while its nextRun has already advanced.
    if (!this.isCronFire(msg)) {
      const blocker = this.checkAllRateLimits(key, msg.from_uid, quarantineAware && (this.ledger ? this.ledger.getTurnState(key) === 'quarantined' : this.quarantined.has(key)));
      if (blocker) {
        if (!blocker.notified) {
          blocker.notified = true;
          await this.replySafe(msg, '请稍后再试');
        }
        return {
          sessionKey: key,
          shouldProcess: false,
          message: msg,
          rejectionReason: 'rate_limited',
        };
      }
    }

    // G1: All payload types are now resolved by inbound.resolveContent in
    // handleMessage. The router only filters rate limits, size, and bot
    // loops — type-specific handling lives in the pipeline.

    // Q10: Reject messages exceeding content length limit (text only — media
    // URLs are bounded by their own size and rendered via resolveContent).
    const content = msg.payload.content ?? '';
    if (
      msg.payload.type === MessageType.Text &&
      Buffer.byteLength(content, 'utf-8') > MAX_CONTENT_BYTES
    ) {
      await this.replySafe(msg, '消息过长，请缩短后重试');
      return {
        sessionKey: key,
        shouldProcess: false,
        message: msg,
        rejectionReason: 'oversized',
      };
    }

    // G13: Strip leading @botname from group TEXT messages for cleaner LLM input.
    // For non-text payloads (images, files, etc.) cleanContent stays undefined
    // so the pipeline falls back to the resolveContent rendering instead of an
    // empty string.
    let cleanContent: string | undefined;
    if (msg.payload.type === MessageType.Text) {
      cleanContent = content;
      if (this.isGroupLike(msg.channel_type)) {
        const mention = msg.payload.mention;
        const metadata = normalizeInboundMention(mention, this.robotId);
        // Path 1: entities-based removal (precise offset/length).
        if (metadata.is_explicitly_mentioned && metadata.mention_source === 'entities'
          && Array.isArray(mention?.entities)) {
          const botEntity = mention.entities.find(
            (e) => e !== null && typeof e === 'object' && !Array.isArray(e)
              && e.uid === this.robotId && e.offset === 0 && Number.isSafeInteger(e.length)
              && e.length > 0 && e.length <= content.length && /^[@＠]/.test(content)
              // Do not split a UTF-16 surrogate pair at the removal boundary.
              && (content.codePointAt(e.length - 1) ?? 0) <= 0xffff,
          );
          if (botEntity) {
            cleanContent = content.substring(botEntity.length).trimStart();
          }
        }
        // Path 2: routing-UID fallback when no entity claims the leading span.
        // In mention-free groups (G12) where the bot wasn't @'d, do NOT touch
        // the message — a leading @ is addressed to someone else.
        const hasLeadingEntity = Array.isArray(mention?.entities) && mention.entities.some(
          e => e !== null && typeof e === 'object' && !Array.isArray(e) && e.offset === 0,
        );
        if (cleanContent === content && metadata.is_explicitly_mentioned && metadata.mention_source !== 'invalid'
          && metadata.mentioned_uids.includes(this.robotId) && !hasLeadingEntity
          && Array.isArray(mention?.uids) && mention.uids.includes(this.robotId)) {
          cleanContent = content.replace(/^[@＠]\S+\s*/, '').trimStart();
        }
        // If stripping emptied the content, keep original.
        if (!cleanContent) cleanContent = content;
      }
    }

    return { sessionKey: key, shouldProcess: true, message: msg, cleanContent };
  }

  /**
   * G20 fix: Check all three rate limits (global, per-session, per-user) in
   * one pass. Refills all three buckets, then either consumes 1 token from
   * each (when all pass) or returns the blocking bucket (when any fails).
   *
   * Returns null on success (tokens consumed), or the blocking bucket on
   * failure (no tokens consumed). The caller uses the blocking bucket's
   * `notified` flag to debounce the "请稍后再试" reply per-bucket, so a user
   * blocked by per-user limit doesn't get spammed when their per-session
   * bucket still has tokens.
   */
  private checkAllRateLimits(key: string, uid: string, paused = false): TokenBucket | null {
    this.cleanStaleBuckets();

    const now = Date.now();
    const maxPerMinute = this.config.rateLimit.maxPerMinute;
    const globalMax = maxPerMinute * GLOBAL_RATE_MULTIPLIER;

    const globalBucket = this.getOrCreateGlobalBucket(now, globalMax, paused);
    // Per-participant session bucket: key by session AND uid. For a group the
    // sessionKey is the channel_id (shared), so keying the rate bucket by
    // sessionKey alone would collapse the WHOLE room into one maxPerMinute quota
    // (the 6th message/min from ANY member blocked). Including uid restores a
    // per-member per-channel quota — matching the pre-shared-session behavior —
    // while the global + per-user buckets still bound abuse. For a DM the
    // sessionKey already embeds the peer, so this is just per-peer. Joined with a
    // newline (never present in a uid/key) so distinct pairs can't alias.
    const sessionBucketKey = `${key}\n${uid}`;
    const sessionBucket = this.getOrCreateBucket(this.tokenBuckets, sessionBucketKey, now, maxPerMinute);
    const userBucket = this.getOrCreateBucket(this.userBuckets, uid, now, maxPerMinute);

    this.refillBucket(globalBucket, now, globalMax);
    this.refillBucket(sessionBucket, now, maxPerMinute);
    this.refillBucket(userBucket, now, maxPerMinute);

    // Check in priority order: global → per-user → per-session.
    // Per-user before per-session so a user blocked across groups gets a
    // consistent debounce target instead of one per session bucket.
    if (globalBucket.tokens < 1) return globalBucket;
    if (userBucket.tokens < 1) return userBucket;
    if (sessionBucket.tokens < 1) return sessionBucket;

    // All pass — consume one token from each, and clear notified flags so
    // future blocks get a fresh debounce window.
    globalBucket.tokens -= 1;
    sessionBucket.tokens -= 1;
    userBucket.tokens -= 1;
    globalBucket.notified = false;
    sessionBucket.notified = false;
    userBucket.notified = false;
    return null;
  }

  private getOrCreateBucket(
    map: Map<string, TokenBucket>,
    key: string,
    now: number,
    capacity: number,
  ): TokenBucket {
    let bucket = map.get(key);
    if (!bucket) {
      bucket = { tokens: capacity, lastRefill: now, notified: false };
      map.set(key, bucket);
    }
    return bucket;
  }

  private getOrCreateGlobalBucket(now: number, capacity: number, paused = false): TokenBucket {
    const existing = paused ? this.pausedGlobalBucket : this.globalBucket;
    if (existing) return existing;
    const bucket = { tokens: capacity, lastRefill: now, notified: false };
    if (paused) this.pausedGlobalBucket = bucket;
    else this.globalBucket = bucket;
    return bucket;
  }

  private refillBucket(bucket: TokenBucket, now: number, capacity: number): void {
    const elapsed = now - bucket.lastRefill;
    const refill = (elapsed / 60_000) * capacity;
    bucket.tokens = Math.min(capacity, bucket.tokens + refill);
    bucket.lastRefill = now;
  }

  /** Remove token buckets that haven't been used in 5 minutes. */
  private cleanStaleBuckets(): void {
    const now = Date.now();
    for (const [key, bucket] of this.tokenBuckets) {
      if (now - bucket.lastRefill > BUCKET_STALE_MS) {
        this.tokenBuckets.delete(key);
      }
    }
    for (const [uid, bucket] of this.userBuckets) {
      if (now - bucket.lastRefill > BUCKET_STALE_MS) {
        this.userBuckets.delete(uid);
      }
    }
  }

  private async replySafe(msg: BotMessage, content: string): Promise<void> {
    if (!msg.channel_id || msg.channel_type === undefined) return;
    try {
      await sendMessage({
        apiUrl: this.config.apiUrl,
        botToken: this.config.botToken,
        channelId: msg.channel_id,
        channelType: msg.channel_type,
        content,
      });
    } catch (err) {
      console.error(`session-router: reply failed: ${String(err)}`);
    }
  }
}
