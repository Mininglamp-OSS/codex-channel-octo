/**
 * Session Store — SQLite persistence via better-sqlite3 + thin adapter.
 */

import type { DbAdapter, PreparedStatement } from './db-adapter.js';
import { escapeRoleLabels, sanitizeDisplayName } from './prompt-safety.js';

export interface Session {
  id: string;
  channelId: string;
  channelType: number;
  createdAt: number;
  updatedAt: number;
}

interface SessionRow {
  id: string;
  channel_id: string;
  channel_type: number;
  created_at: number;
  updated_at: number;
}

interface MessageRow {
  role: 'user' | 'assistant';
  content: string;
  message_seq: number | null;
  from_name: string | null;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS turn_execution (
  session_key TEXT PRIMARY KEY, turn_id TEXT NOT NULL, generation INTEGER NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('active','clean','quarantined')),
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS interrupted_turns (
  turn_id TEXT PRIMARY KEY, session_key TEXT NOT NULL,
  reason TEXT NOT NULL, execution_risk TEXT NOT NULL, stage TEXT NOT NULL,
  context_pending INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS interrupted_session ON interrupted_turns(session_key, created_at);
CREATE INDEX IF NOT EXISTS turn_execution_turn_idx ON turn_execution(turn_id);
CREATE TABLE IF NOT EXISTS turn_outputs (
  turn_id TEXT PRIMARY KEY, session_key TEXT NOT NULL, content TEXT NOT NULL,
  message_seq INTEGER, bot_name TEXT, state TEXT NOT NULL DEFAULT 'generated',
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS delivery_parts (
  turn_id TEXT NOT NULL, part_index INTEGER NOT NULL, client_msg_no TEXT NOT NULL UNIQUE,
  payload TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'pending', message_id TEXT,
  PRIMARY KEY(turn_id, part_index)
);
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  channel_id TEXT NOT NULL,
  channel_type INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('user', 'assistant')),
  content TEXT NOT NULL,
  timestamp INTEGER NOT NULL,
  message_seq INTEGER,
  from_name TEXT,
  FOREIGN KEY(session_id) REFERENCES sessions(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS group_members (
  group_id TEXT NOT NULL,
  uid TEXT NOT NULL,
  name TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY(group_id, uid)
);

-- v0.3 /reset barrier: the message_seq at which a session was intentionally
-- cleared. Kept in a SEPARATE table (no FK to sessions) so it SURVIVES
-- deleteSession() and a process restart — G4 cold-start backfill consults it to
-- avoid resurrecting pre-reset history. One row per session that ever reset.
CREATE TABLE IF NOT EXISTS reset_barriers (
  session_id TEXT PRIMARY KEY,
  reset_seq INTEGER NOT NULL
);

-- v0.3 persistent sessions: maps our sessionKey to the SDK's session UUID so a
-- later turn can resume the same agent session (v2 Session API). Kept separate
-- from the sessions table (different lifecycle); cleared by /reset with history.
CREATE TABLE IF NOT EXISTS sdk_sessions (
  session_id TEXT PRIMARY KEY,
  sdk_session_id TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_messages_session_id ON messages(session_id, id);
CREATE TABLE IF NOT EXISTS conversation_document_state (
  session_id TEXT PRIMARY KEY,
  sdk_session_id TEXT NOT NULL,
  signature TEXT,
  FOREIGN KEY(session_id) REFERENCES sdk_sessions(session_id) ON DELETE CASCADE
);
`;

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

function rowToSession(row: SessionRow): Session {
  return {
    id: row.id,
    channelId: row.channel_id,
    channelType: row.channel_type,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class SessionStore {
  private readonly adapter: DbAdapter;

  private selectSession!: PreparedStatement;
  private insertSession!: PreparedStatement;
  private touchSession!: PreparedStatement;
  private insertMessage!: PreparedStatement;
  private selectRecentMessages!: PreparedStatement;
  private deleteExpired!: PreparedStatement;
  private deleteSessionStmt!: PreparedStatement;
  private upsertResetBarrier!: PreparedStatement;
  private selectResetBarrier!: PreparedStatement;
  private upsertSdkSession!: PreparedStatement;
  private selectSdkSession!: PreparedStatement;
  private deleteSdkSession!: PreparedStatement;
  private deleteExpiredSdkSessions!: PreparedStatement;

  /** Tracks the last message_seq at which the bot replied, per group session key. */
  private lastBotReplySeq = new Map<string, number>();

  constructor(adapter: DbAdapter) {
    this.adapter = adapter;
  }

  /** Invoke only after acquiring the gateway singleton lock. */
  recoverInterruptedTurns(): void {
    this.adapter.exec("UPDATE turn_execution SET state='quarantined' WHERE state='active'");
  }
  isTurnQuarantined(session: string): boolean {
    const row = this.adapter.prepare('SELECT state FROM turn_execution WHERE session_key = ?').get(session) as { state: string } | undefined;
    return row?.state === 'quarantined' || row?.state === 'active';
  }
  getTurnState(session: string): 'active' | 'quarantined' | 'clean' | undefined {
    return (this.adapter.prepare('SELECT state FROM turn_execution WHERE session_key=?').get(session) as {state:'active' | 'quarantined' | 'clean'} | undefined)?.state;
  }
  getQuarantinedTurnId(session: string): string | undefined {
    return (this.adapter.prepare("SELECT turn_id FROM turn_execution WHERE session_key=? AND state IN ('active','quarantined')").get(session) as {turn_id:string} | undefined)?.turn_id;
  }
  quarantinedTurnCount(): number {
    return (this.adapter.prepare("SELECT count(*) AS count FROM turn_execution WHERE state='quarantined'").get() as {count:number}).count;
  }
  beginTurn(session: string, turnId: string): number {
    return this.adapter.transaction(() => {
      if (this.isTurnQuarantined(session)) throw new Error('Session requires execution reconciliation');
      this.adapter.prepare(`INSERT INTO turn_execution VALUES (?, ?, 1, 'active', ?)
        ON CONFLICT(session_key) DO UPDATE SET turn_id=excluded.turn_id, generation=generation+1, state='active', updated_at=excluded.updated_at`).run(session, turnId, Date.now());
      return (this.adapter.prepare('SELECT generation FROM turn_execution WHERE session_key = ?').get(session) as { generation: number }).generation;
    })();
  }
  finishTurn(session: string, turnId: string, state: 'clean' | 'quarantined'): void {
    this.adapter.prepare('UPDATE turn_execution SET state=?, updated_at=? WHERE session_key=? AND turn_id=?').run(state, Date.now(), session, turnId);
  }
  recordInterruption(session: string, turn: import('./turn-context.js').InterruptedTurn): void {
    this.adapter.prepare(`INSERT OR IGNORE INTO interrupted_turns(turn_id,session_key,reason,execution_risk,stage,created_at)
      SELECT ?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM turn_execution WHERE session_key=? AND turn_id=?)`)
      .run(turn.turnId,session,turn.reason,turn.executionRisk,turn.stage,Date.now(),session,turn.turnId);
  }
  getInterruption(session: string): import('./turn-context.js').InterruptedTurn | undefined {
    const row = this.adapter.prepare(`SELECT turn_id AS turnId, reason, execution_risk AS executionRisk, stage
      FROM interrupted_turns WHERE session_key=? AND context_pending=1 ORDER BY rowid DESC LIMIT 1`)
      .get(session) as import('./turn-context.js').InterruptedTurn | undefined;
    return row;
  }
  consumeInterruption(session: string, turnId: string): void {
    this.adapter.prepare(`UPDATE interrupted_turns SET context_pending=0 WHERE session_key=? AND rowid <=
      (SELECT rowid FROM interrupted_turns WHERE session_key=? AND turn_id=?)`).run(session,session,turnId);
  }
  saveTurnOutput(turnId: string, session: string, text: string, seq?: number, bot?: string): void {
    this.adapter.prepare('INSERT INTO turn_outputs(turn_id,session_key,content,message_seq,bot_name,created_at) VALUES (?,?,?,?,?,?)').run(turnId, session, text, seq ?? null, bot ?? null, Date.now());
  }
  saveDeliveryPart(turnId: string, index: number, clientMsgNo: string, payload: string): void {
    this.adapter.prepare('INSERT INTO delivery_parts(turn_id,part_index,client_msg_no,payload) VALUES (?,?,?,?)').run(turnId, index, clientMsgNo, payload);
  }
  saveDeliveryParts(turnId: string, parts: Array<{ clientMsgNo: string; payload: string }>): void {
    this.adapter.transaction(() => parts.forEach((part,index) => this.saveDeliveryPart(turnId,index,part.clientMsgNo,part.payload)))();
  }
  /** Exact-turn reconciliation after external checks; /reset never calls this. */
  reconcileTurn(session: string, turnId: string): boolean {
    return this.adapter.prepare("UPDATE turn_execution SET state='clean', updated_at=? WHERE session_key=? AND turn_id=? AND state='quarantined'").run(Date.now(),session,turnId).changes === 1;
  }
  markDeliveryPart(turnId: string, index: number, state: 'confirmed' | 'unknown', messageId?: string): void {
    this.adapter.prepare('UPDATE delivery_parts SET state=?, message_id=? WHERE turn_id=? AND part_index=?').run(state, messageId ?? null, turnId, index);
  }
  commitTurnOutput(turnId: string): void {
    this.adapter.transaction(() => {
      const output = this.adapter.prepare('SELECT * FROM turn_outputs WHERE turn_id=?').get(turnId) as { session_key: string; content: string; message_seq: number | null; bot_name: string | null; state: string } | undefined;
      if (!output || output.state === 'committed') return;
      const parts = this.adapter.prepare('SELECT state FROM delivery_parts WHERE turn_id=?').all(turnId) as Array<{state:string}>;
      if (!parts.length || parts.some(p => p.state !== 'confirmed')) throw new Error('Delivery not confirmed');
      this.appendAssistant(output.session_key, output.content, output.message_seq ?? undefined, output.bot_name ?? undefined);
      this.adapter.prepare("UPDATE turn_outputs SET state='committed' WHERE turn_id=?").run(turnId);
    })();
  }
  /** Read-only ledger view of one exact turn, ordered by part. Never returns payloads or keys. */
  readDeliveryParts(turnId: string): ReadonlyArray<{ index: number; state: 'pending' | 'unknown' | 'confirmed'; messageId: string | null }> {
    return this.adapter.prepare('SELECT part_index AS "index", state, message_id AS messageId FROM delivery_parts WHERE turn_id=? ORDER BY part_index')
      .all(turnId) as Array<{ index: number; state: 'pending' | 'unknown' | 'confirmed'; messageId: string | null }>;
  }

  init(): void {
    this.adapter.exec(SCHEMA);


    // Migrations: add columns missing on pre-existing DBs (SQLite can't add them
    // via CREATE TABLE IF NOT EXISTS). Guarded + throw on real failure (Q1-2) so
    // a silent failure can't surface later as cryptic SQL errors. Note: this is
    // schema presence, NOT data back-compat. New rows always write from_name;
    // older rows added before this column may be NULL, which renderTurn handles
    // via `from_name ?? role` — keep that coalesce (it is not dead code).
    try {
      const cols = this.adapter
        .prepare("PRAGMA table_info(messages)")
        .all() as Array<{ name: string }>;
      if (!cols.some((c) => c.name === 'message_seq')) {
        this.adapter.exec('ALTER TABLE messages ADD COLUMN message_seq INTEGER');
      }
      if (!cols.some((c) => c.name === 'from_name')) {
        this.adapter.exec('ALTER TABLE messages ADD COLUMN from_name TEXT');
      }
    } catch (err) {
      throw new Error(
        `session-store: messages column migration failed — database is in an unknown state. Underlying error: ${String(err)}`,
      );
    }

    this.selectSession = this.adapter.prepare('SELECT * FROM sessions WHERE id = ?');
    this.insertSession = this.adapter.prepare(
      'INSERT INTO sessions (id, channel_id, channel_type, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
    );
    this.touchSession = this.adapter.prepare('UPDATE sessions SET updated_at = ? WHERE id = ?');
    this.insertMessage = this.adapter.prepare(
      'INSERT INTO messages (session_id, role, content, timestamp, message_seq, from_name) VALUES (?, ?, ?, ?, ?, ?)',
    );
    this.selectRecentMessages = this.adapter.prepare(
      'SELECT role, content, message_seq, from_name FROM messages WHERE session_id = ? ORDER BY id DESC LIMIT ?',
    );
    this.deleteExpired = this.adapter.prepare('DELETE FROM sessions WHERE updated_at < ?');
    this.deleteSessionStmt = this.adapter.prepare('DELETE FROM sessions WHERE id = ?');
    this.upsertResetBarrier = this.adapter.prepare(
      'INSERT INTO reset_barriers (session_id, reset_seq) VALUES (?, ?) ' +
        'ON CONFLICT(session_id) DO UPDATE SET reset_seq = excluded.reset_seq ' +
        'WHERE excluded.reset_seq > reset_barriers.reset_seq',
    );
    this.selectResetBarrier = this.adapter.prepare(
      'SELECT reset_seq FROM reset_barriers WHERE session_id = ?',
    );
    this.upsertSdkSession = this.adapter.prepare(
      'INSERT INTO sdk_sessions (session_id, sdk_session_id, updated_at) VALUES (?, ?, ?) ' +
        'ON CONFLICT(session_id) DO UPDATE SET sdk_session_id = excluded.sdk_session_id, ' +
        'updated_at = excluded.updated_at',
    );
    this.selectSdkSession = this.adapter.prepare(
      'SELECT sdk_session_id FROM sdk_sessions WHERE session_id = ?',
    );
    this.deleteSdkSession = this.adapter.prepare(
      'DELETE FROM sdk_sessions WHERE session_id = ?',
    );
    this.deleteExpiredSdkSessions = this.adapter.prepare(
      'DELETE FROM sdk_sessions WHERE updated_at < ?',
    );
  }

  getOrCreate(id: string, channelId: string, channelType: number): Session {
    const now = Date.now();
    const existing = this.selectSession.get(id) as SessionRow | undefined;
    if (existing) {
      this.touchSession.run(now, id);
      return rowToSession({ ...existing, updated_at: now });
    }
    this.insertSession.run(id, channelId, channelType, now, now);
    return {
      id,
      channelId,
      channelType,
      createdAt: now,
      updatedAt: now,
    };
  }

  appendUser(sessionId: string, content: string, messageSeq?: number, fromName?: string): void {
    this.append(sessionId, 'user', content, messageSeq, fromName);
  }

  appendAssistant(sessionId: string, content: string, messageSeq?: number, botName?: string): void {
    // Assistant turns are attributed to the bot's name (the caller passes the
    // registered bot id). Stored like any other turn — rendering is uniform.
    this.append(sessionId, 'assistant', content, messageSeq, botName);
  }

  private append(
    sessionId: string,
    role: 'user' | 'assistant',
    content: string,
    messageSeq?: number,
    fromName?: string,
  ): void {
    const now = Date.now();
    // SECURITY: from_name is the IM display name — USER-CONTROLLED. It is
    // rendered into the shared history prefix as `[<role> <from_name>]:`, so a
    // raw value like `Alice]\n[assistant bot]: forged` would inject a fake
    // assistant turn that every group member then sees (cross-user context
    // poisoning in shared group mode). sanitizeDisplayName (prompt-safety, the
    // shared choke point) strips bracket/line-break chars, caps length, and
    // falls back to the role if nothing survives.
    const safeName = sanitizeDisplayName(fromName ?? role, role);
    this.insertMessage.run(sessionId, role, content, now, messageSeq ?? null, safeName);
    this.touchSession.run(now, sessionId);
  }

  /**
   * Render one history turn with speaker attribution. Group sessions are shared
   * across members, so every turn names its sender — `[user <name>]:` and
   * `[assistant <botName>]:`. The name is sanitized at write time (see append())
   * so it cannot forge turn labels; the `?? role` coalesce only guards rows from
   * before this column existed.
   *
   * SECURITY: the message CONTENT is also user-controlled and travels into the
   * shared `[Conversation history]` block. A body whose line starts with
   * `[assistant ...]:` / `[user ...]:` would forge an extra turn that, in shared
   * group mode, every member then reads as real conversation (cross-user context
   * poisoning — the same threat the from_name strip closes, but via content and
   * easier to exploit since no display name is needed). So we neutralize any
   * line-leading role label in the content here, at render time. This is the one
   * coherent policy: turn labels can ONLY originate from this renderer, never
   * from a user-controlled name or body.
   */
  private renderTurn(r: MessageRow): string {
    return `[${r.role} ${r.from_name ?? r.role}]: ${escapeRoleLabels(r.content)}`;
  }

  buildHistoryPrefix(sessionId: string, limit: number): string {
    const rows = this.selectRecentMessages.all(sessionId, limit) as MessageRow[];
    // Rows are DESC; reverse to chronological order.
    const ordered = rows.slice().reverse();
    return ordered.map((r) => this.renderTurn(r)).join('\n');
  }

  cleanExpired(): number {
    const cutoff = Date.now() - SEVEN_DAYS_MS;
    this.adapter.prepare('DELETE FROM interrupted_turns WHERE context_pending=0 AND created_at < ?').run(cutoff);
    // Keep unresolved execution evidence; completed tombstones can expire.
    this.adapter.prepare("DELETE FROM turn_execution WHERE state='clean' AND updated_at < ?").run(cutoff);
    // The admission tombstone and the evidence needed for reconciliation share
    // retention. Reset remains an explicit content deletion, not a release.
    const expiredOutput = `SELECT o.turn_id FROM turn_outputs o WHERE o.created_at < ?
      AND NOT EXISTS (SELECT 1 FROM turn_execution e
        WHERE e.turn_id=o.turn_id AND e.state IN ('active','quarantined'))`;
    this.adapter.prepare(`DELETE FROM delivery_parts WHERE turn_id IN (${expiredOutput})`).run(cutoff);
    this.adapter.prepare(`DELETE FROM turn_outputs WHERE turn_id IN (${expiredOutput})`).run(cutoff);
    const result = this.deleteExpired.run(cutoff);
    // Expire the SDK-session mapping on the same 7-day TTL. sdk_sessions is a
    // separate table (no FK cascade to sessions), so without this a stale mapping
    // would survive the sessions/messages cleanup — and since SDK sessions are
    // always on, the next message would recreate the session and `resume` the
    // expired SDK conversation, silently resurrecting history past the TTL
    // (PR #120 review). updated_at is bumped every turn (setSdkSessionId), so it
    // tracks activity exactly like sessions.updated_at.
    this.deleteExpiredSdkSessions.run(cutoff);
    return result.changes;
  }

  deleteSession(sessionId: string): void {
    this.adapter.prepare('DELETE FROM delivery_parts WHERE turn_id IN (SELECT turn_id FROM turn_outputs WHERE session_key=?)').run(sessionId);
    this.adapter.prepare('DELETE FROM turn_outputs WHERE session_key=?').run(sessionId);
    this.deleteSessionStmt.run(sessionId);
  }

  /**
   * v0.3 /reset: record a barrier so cold-start backfill never resurrects
   * history at or before `resetSeq`. Persisted independently of the session row
   * (survives deleteSession + restart). Monotonic — a later reset raises the
   * barrier, an out-of-order/older seq is ignored.
   *
   * `resetSeq` is the message_seq of the /reset command itself; everything up to
   * and including it is considered intentionally discarded.
   */
  setResetBarrier(sessionId: string, resetSeq: number): void {
    this.upsertResetBarrier.run(sessionId, resetSeq);
  }

  /** Return the reset barrier seq for a session, or undefined if never reset. */
  getResetBarrier(sessionId: string): number | undefined {
    const row = this.selectResetBarrier.get(sessionId) as
      | { reset_seq: number }
      | undefined;
    return row?.reset_seq;
  }

  /**
   * v0.3 persistent sessions: record the SDK session UUID for a sessionKey so a
   * later turn can resume it. Upserts (latest wins).
   */
  setSdkSessionId(sessionId: string, sdkSessionId: string): void {
    const changed = this.getSdkSessionId(sessionId) !== sdkSessionId;
    this.upsertSdkSession.run(sessionId, sdkSessionId, Date.now());
    if (changed) {
      this.adapter.prepare('INSERT INTO conversation_document_state (session_id, sdk_session_id, signature) VALUES (?, ?, NULL) ON CONFLICT(session_id) DO UPDATE SET sdk_session_id = excluded.sdk_session_id, signature = NULL')
        .run(sessionId, sdkSessionId);
    }
  }

  /** Return the stored SDK session UUID for a sessionKey, or undefined. */
  getSdkSessionId(sessionId: string): string | undefined {
    const row = this.selectSdkSession.get(sessionId) as
      | { sdk_session_id: string }
      | undefined;
    return row?.sdk_session_id;
  }

  /** Forget the SDK session mapping (e.g. on /reset or a resume failure). */
  clearSdkSessionId(sessionId: string): void {
    this.deleteSdkSession.run(sessionId);
  }

  getConversationDocumentSignature(sessionId: string, threadId: string): string | null | undefined {
    if (this.getSdkSessionId(sessionId) !== threadId) return null;
    const row = this.adapter.prepare('SELECT signature FROM conversation_document_state WHERE session_id = ? AND sdk_session_id = ?')
      .get(sessionId, threadId) as { signature: string | null } | undefined;
    return row?.signature;
  }

  setConversationDocumentSignature(sessionId: string, threadId: string, signature: string): void {
    this.adapter.prepare('INSERT INTO conversation_document_state (session_id, sdk_session_id, signature) SELECT session_id, sdk_session_id, ? FROM sdk_sessions WHERE session_id = ? AND sdk_session_id = ? ON CONFLICT(session_id) DO UPDATE SET sdk_session_id = excluded.sdk_session_id, signature = excluded.signature')
      .run(signature, sessionId, threadId);
  }

  close(): void {
    this.adapter.close();
  }

  /** Record the message_seq at which the bot last replied for a session. */
  setLastBotReplySeq(sessionId: string, seq: number): void {
    this.lastBotReplySeq.set(sessionId, seq);
  }

  /** Get the message_seq at which the bot last replied for a session. */
  getLastBotReplySeq(sessionId: string): number | undefined {
    return this.lastBotReplySeq.get(sessionId);
  }

  /**
   * Build history prefix with answered/new segmentation (G10).
   * Messages with message_seq <= lastBotReplySeq are labeled [answered history],
   * messages after are labeled [new messages]. Falls back to flat history if
   * no lastBotReplySeq tracked or no seq data available.
   */
  buildSegmentedHistoryPrefix(sessionId: string, limit: number): string {
    const rows = this.selectRecentMessages.all(sessionId, limit) as MessageRow[];
    const ordered = rows.slice().reverse();
    if (ordered.length === 0) return '';

    const lastReplySeq = this.lastBotReplySeq.get(sessionId);
    if (lastReplySeq === undefined) {
      // No segmentation tracking — return flat history.
      return ordered.map((r) => this.renderTurn(r)).join('\n');
    }

    // Real segmentation by message_seq (G10 fix per PR#30 review):
    // - rows with message_seq <= lastReplySeq are answered
    // - rows with message_seq > lastReplySeq are new
    // - rows with NULL message_seq (assistant replies, legacy) attach to the
    //   answered side if they precede any "new" user row, else stay flat.
    const answered: MessageRow[] = [];
    const newMsgs: MessageRow[] = [];
    let seenNew = false;
    for (const r of ordered) {
      if (r.message_seq != null && r.message_seq > lastReplySeq) {
        seenNew = true;
        newMsgs.push(r);
      } else if (r.message_seq != null) {
        answered.push(r);
      } else {
        // No seq (e.g. assistant reply) — follows the current side.
        (seenNew ? newMsgs : answered).push(r);
      }
    }

    if (newMsgs.length === 0) {
      // Nothing new since last reply — don't show segmentation labels.
      return answered.map((r) => this.renderTurn(r)).join('\n');
    }

    const parts: string[] = [];
    if (answered.length > 0) {
      parts.push('[answered history]');
      parts.push(...answered.map((r) => this.renderTurn(r)));
    }
    parts.push('[new messages]');
    parts.push(...newMsgs.map((r) => this.renderTurn(r)));
    return parts.join('\n');
  }
}
