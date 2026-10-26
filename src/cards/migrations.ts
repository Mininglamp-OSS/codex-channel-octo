/**
 * Card store schema, migration, online backup and activation provenance.
 *
 * The `card_v1` family is additive: it lives in the existing per-Bot SQLite
 * database next to the legacy tables and never alters them. Every card object
 * is versioned through `card_meta`; anything that does not match the exact
 * reference schema (missing, extra, newer or rewritten objects) is rejected
 * instead of being repaired in place.
 *
 * First-install provenance comes from an activation marker that lives outside
 * the replaceable DB/WAL/backup set. A database that "looks new" never
 * overrides a marker recording prior activation, and the absence of both is
 * unknown, not fresh.
 */

import { createHash, randomUUID } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';
import Database from 'better-sqlite3';
import type { DbAdapter } from '../db-adapter.js';
import { decodeStrictUtf8, readPrivateRegularFile } from './safe-file.js';

// ─── Versioning ─────────────────────────────────────────────────────────────

export const CARD_SCHEMA_FAMILY = 'card_v1';
/**
 * Version 2 is the intent-capable store: the DDL is unchanged and only
 * `card_meta` gains `intent_legacy`, the exact set of automatic cards that
 * were live when the store was upgraded from version 1. An older binary sees
 * a newer version and leaves cards inert (DTI-2.1 §2.2).
 *
 * Version 3 (SC-1) adds the nullable app-server settlement and late-outcome
 * audit columns to `card_explicit_requests` ({@link CARD_V3_DDL}); no
 * existing column, constraint or trigger changes.
 */
export const CARD_SCHEMA_VERSION = 3;
/** Older versions this binary can upgrade in place. */
const CARD_SCHEMA_VERSION_V1 = 1;
const CARD_SCHEMA_VERSION_V2 = 2;
export const CARD_EXPLICIT_LEDGER_VERSION = 1;
export const CARD_META_CREATED_BY = 'codex-channel-octo';

export const SESSION_TTL_MS = 24 * 60 * 60 * 1000;
export const RETENTION_MS = 24 * 60 * 60 * 1000;

/** Every card object, in creation order. Names are the protected graph. */
export const CARD_TABLES = [
  'card_meta',
  'card_messages',
  'card_sessions',
  'card_admissions',
  'card_event_dispositions',
  'card_event_attempts',
  'card_event_cursor',
  'card_handler_generations',
  'card_explicit_requests',
] as const;
export type CardTable = (typeof CARD_TABLES)[number];

/**
 * Reference DDL for `card_v1`, including the explicit-invocation ledger
 * (§4.1/§4.1a). Constraints are part of the contract: CHECK/UNIQUE/FK clauses
 * and the immutability triggers are verified byte-for-byte on every open.
 */
export const CARD_V1_DDL: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS card_meta (
  k TEXT PRIMARY KEY,
  v TEXT NOT NULL
)`,
  `CREATE TABLE IF NOT EXISTS card_messages (
  card_id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK(kind IN ('automatic','display','interactive')),
  session_key TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  channel_type INTEGER NOT NULL,
  generation TEXT NOT NULL,
  topic_scope TEXT,
  reset_epoch INTEGER NOT NULL,
  body_digest TEXT NOT NULL,
  client_msg_no TEXT NOT NULL UNIQUE,
  message_id TEXT UNIQUE,
  template_id TEXT,
  template_version TEXT,
  profile TEXT,
  pinned_limits_json TEXT,
  seq_reserved INTEGER NOT NULL DEFAULT 0 CHECK(seq_reserved >= 0),
  seq_acked INTEGER NOT NULL DEFAULT 0 CHECK(seq_acked >= 0 AND seq_acked <= seq_reserved),
  state TEXT NOT NULL CHECK(state IN ('sending','ambiguous','active','answering','done','error','expired','abandoned')),
  terminal_reason TEXT CHECK(terminal_reason IS NULL OR terminal_reason IN ('completed','failed','interrupted','timed_out','expired','policy_revoked')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  terminal_at INTEGER,
  retain_until INTEGER,
  CHECK((state IN ('done','error','expired','abandoned')) = (terminal_at IS NOT NULL)),
  CHECK(terminal_at IS NULL OR (retain_until IS NOT NULL AND retain_until >= terminal_at + 86400000)),
  CHECK(state IN ('sending','ambiguous') OR state IN ('expired','error','abandoned') OR message_id IS NOT NULL)
)`,
  `CREATE INDEX IF NOT EXISTS idx_card_messages_open ON card_messages(state) WHERE terminal_at IS NULL`,
  `CREATE TABLE IF NOT EXISTS card_sessions (
  session_id TEXT PRIMARY KEY,
  card_id TEXT NOT NULL UNIQUE REFERENCES card_messages(card_id),
  requester_uid TEXT NOT NULL,
  session_key TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  channel_type INTEGER NOT NULL,
  origin_generation TEXT NOT NULL,
  topic_scope TEXT,
  reset_epoch INTEGER NOT NULL,
  contract_version INTEGER NOT NULL,
  authored_contract_json TEXT NOT NULL,
  authored_data_hash TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('sending','pending','retry_wait','admitted','ambiguous','completed','failed','dead_letter','expired')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts BETWEEN 0 AND 3),
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  terminal_at INTEGER,
  retain_until INTEGER,
  CHECK(expires_at = created_at + 86400000),
  CHECK((status IN ('completed','failed','dead_letter','expired')) = (terminal_at IS NOT NULL)),
  CHECK(terminal_at IS NULL OR (retain_until IS NOT NULL AND retain_until >= terminal_at + 86400000))
)`,
  `CREATE INDEX IF NOT EXISTS idx_card_sessions_active ON card_sessions(status, expires_at)`,
  `CREATE TABLE IF NOT EXISTS card_admissions (
  admission_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL UNIQUE REFERENCES card_sessions(session_id),
  event_id TEXT NOT NULL UNIQUE,
  continuation_generation TEXT NOT NULL,
  submitted_hash TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('admitted','completed','failed','ambiguous')),
  admitted_at INTEGER NOT NULL,
  settled_at INTEGER,
  CHECK((state IN ('completed','failed')) = (settled_at IS NOT NULL))
)`,
  `CREATE TABLE IF NOT EXISTS card_event_dispositions (
  event_id TEXT PRIMARY KEY,
  consumer_scope TEXT NOT NULL,
  event_class TEXT NOT NULL,
  session_id TEXT REFERENCES card_sessions(session_id),
  disposition TEXT NOT NULL CHECK(disposition IN ('admitted','duplicate','invalid','unauthorized','unknown','poison','expired','rejected','dead_letter','unsupported_control')),
  reason_code TEXT,
  attempts INTEGER NOT NULL DEFAULT 1 CHECK(attempts BETWEEN 1 AND 3),
  created_at INTEGER NOT NULL,
  retain_until INTEGER NOT NULL,
  CHECK(retain_until >= created_at + 86400000)
)`,
  `CREATE TABLE IF NOT EXISTS card_event_attempts (
  event_id TEXT PRIMARY KEY,
  consumer_scope TEXT NOT NULL,
  event_class TEXT NOT NULL,
  session_id TEXT REFERENCES card_sessions(session_id),
  message_id TEXT NOT NULL,
  position_ref TEXT NOT NULL,
  previous_position_ref TEXT,
  envelope_digest TEXT NOT NULL,
  attempt_no INTEGER NOT NULL CHECK(attempt_no BETWEEN 0 AND 3),
  phase TEXT NOT NULL CHECK(phase IN ('started','failed','send_wait')),
  reason_code TEXT,
  next_eligible_at INTEGER,
  updated_at INTEGER NOT NULL,
  CHECK((phase = 'send_wait' AND attempt_no = 0) OR (phase IN ('started','failed') AND attempt_no BETWEEN 1 AND 3))
)`,
  `CREATE TABLE IF NOT EXISTS card_event_cursor (
  consumer_scope TEXT PRIMARY KEY,
  topology TEXT NOT NULL CHECK(topology IN ('T-PART','T-EXCL')),
  cursor TEXT,
  acked_through TEXT,
  halted_reason TEXT,
  halted_at INTEGER,
  updated_at INTEGER NOT NULL,
  CHECK((halted_reason IS NULL) = (halted_at IS NULL))
)`,
  `CREATE TABLE IF NOT EXISTS card_handler_generations (
  generation TEXT PRIMARY KEY,
  installation_ref TEXT NOT NULL,
  session_key TEXT NOT NULL,
  runtime_incarnation TEXT NOT NULL,
  reset_epoch INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  context_digest TEXT NOT NULL,
  policy_identity TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('live','closed')),
  invocation_count INTEGER NOT NULL DEFAULT 0 CHECK(invocation_count BETWEEN 0 AND 32),
  logical_send_count INTEGER NOT NULL DEFAULT 0 CHECK(logical_send_count BETWEEN 0 AND 10),
  created_at INTEGER NOT NULL,
  closed_at INTEGER,
  retain_until INTEGER,
  CHECK((state = 'closed') = (closed_at IS NOT NULL)),
  CHECK(closed_at IS NULL OR (retain_until IS NOT NULL AND retain_until >= closed_at + 86400000))
)`,
  `CREATE TABLE IF NOT EXISTS card_explicit_requests (
  generation TEXT NOT NULL REFERENCES card_handler_generations(generation),
  request_id TEXT NOT NULL,
  body_digest TEXT NOT NULL,
  opcode TEXT NOT NULL CHECK(opcode IN ('display','interactive')),
  state TEXT NOT NULL CHECK(state IN ('charged','reserved','acked','failed','ambiguous','cancelled')),
  send_slot INTEGER CHECK(send_slot BETWEEN 1 AND 10),
  client_msg_no TEXT UNIQUE,
  card_id TEXT REFERENCES card_messages(card_id),
  safe_result_json TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY(generation, request_id),
  UNIQUE(generation, send_slot),
  CHECK((send_slot IS NULL) = (client_msg_no IS NULL)),
  CHECK((send_slot IS NULL) = (card_id IS NULL)),
  CHECK(state NOT IN ('reserved','acked','ambiguous') OR send_slot IS NOT NULL),
  CHECK(state <> 'charged' OR send_slot IS NULL)
)`,
  // Fixed 24 h expiry is never renewed (§3.3 T4).
  `CREATE TRIGGER IF NOT EXISTS trg_card_sessions_expiry_fixed
BEFORE UPDATE OF expires_at, created_at ON card_sessions
WHEN NEW.expires_at IS NOT OLD.expires_at OR NEW.created_at IS NOT OLD.created_at
BEGIN SELECT RAISE(ABORT, 'card_sessions expiry is fixed'); END`,
  // Terminal session outcomes are absorbing.
  `CREATE TRIGGER IF NOT EXISTS trg_card_sessions_terminal
BEFORE UPDATE OF status ON card_sessions
WHEN OLD.status IN ('completed','failed','dead_letter','expired') AND NEW.status IS NOT OLD.status
BEGIN SELECT RAISE(ABORT, 'card_sessions terminal status is absorbing'); END`,
  // Terminal card states are absorbing; sequence fences never regress.
  `CREATE TRIGGER IF NOT EXISTS trg_card_messages_terminal
BEFORE UPDATE OF state ON card_messages
WHEN OLD.state IN ('done','error','expired','abandoned') AND NEW.state IS NOT OLD.state
BEGIN SELECT RAISE(ABORT, 'card_messages terminal state is absorbing'); END`,
  `CREATE TRIGGER IF NOT EXISTS trg_card_messages_fences
BEFORE UPDATE ON card_messages
WHEN NEW.seq_reserved < OLD.seq_reserved OR NEW.seq_acked < OLD.seq_acked
  OR (OLD.message_id IS NOT NULL AND NEW.message_id IS NOT OLD.message_id)
  OR NEW.client_msg_no IS NOT OLD.client_msg_no OR NEW.body_digest IS NOT OLD.body_digest
BEGIN SELECT RAISE(ABORT, 'card_messages fence regression'); END`,
  // Settled admissions are absorbing and their identity is immutable.
  `CREATE TRIGGER IF NOT EXISTS trg_card_admissions_fixed
BEFORE UPDATE ON card_admissions
WHEN NEW.session_id IS NOT OLD.session_id OR NEW.event_id IS NOT OLD.event_id
  OR NEW.continuation_generation IS NOT OLD.continuation_generation
  OR NEW.submitted_hash IS NOT OLD.submitted_hash
  OR (OLD.state IN ('completed','failed') AND NEW.state IS NOT OLD.state)
BEGIN SELECT RAISE(ABORT, 'card_admissions record is immutable'); END`,
  // Final dispositions are immutable once written.
  `CREATE TRIGGER IF NOT EXISTS trg_card_event_dispositions_final
BEFORE UPDATE ON card_event_dispositions
BEGIN SELECT RAISE(ABORT, 'card_event_dispositions are final'); END`,
  // Handler counters never refund and a closed generation never reopens.
  `CREATE TRIGGER IF NOT EXISTS trg_card_handler_generations_fence
BEFORE UPDATE ON card_handler_generations
WHEN NEW.invocation_count < OLD.invocation_count OR NEW.logical_send_count < OLD.logical_send_count
  OR (OLD.state = 'closed' AND NEW.state IS NOT OLD.state)
  OR NEW.runtime_incarnation IS NOT OLD.runtime_incarnation OR NEW.reset_epoch IS NOT OLD.reset_epoch
  OR NEW.context_digest IS NOT OLD.context_digest OR NEW.installation_ref IS NOT OLD.installation_ref
BEGIN SELECT RAISE(ABORT, 'card_handler_generations fence regression'); END`,
  // A charged request keeps its identity, body and send slot.
  `CREATE TRIGGER IF NOT EXISTS trg_card_explicit_requests_fixed
BEFORE UPDATE ON card_explicit_requests
WHEN NEW.body_digest IS NOT OLD.body_digest OR NEW.opcode IS NOT OLD.opcode
  OR (OLD.send_slot IS NOT NULL AND (NEW.send_slot IS NOT OLD.send_slot OR NEW.client_msg_no IS NOT OLD.client_msg_no OR NEW.card_id IS NOT OLD.card_id))
  OR (OLD.state IN ('acked','failed','cancelled') AND NEW.state IS NOT OLD.state)
BEGIN SELECT RAISE(ABORT, 'card_explicit_requests record is immutable'); END`,
];

/**
 * Version 3 additions (SC-1), applied after {@link CARD_V1_DDL} on both a
 * fresh install and an upgrade so the stored SQL is identical either way.
 * `settled_by` marks a row the app-server dispatcher finished; once such a
 * row is `ambiguous` its state never changes again, and a late transport
 * outcome is written once to the `late_*` audit columns only.
 */
export const CARD_V3_DDL: readonly string[] = [
  `ALTER TABLE card_explicit_requests ADD COLUMN settled_by TEXT CHECK(settled_by IS NULL OR settled_by = 'app_server')`,
  `ALTER TABLE card_explicit_requests ADD COLUMN late_outcome TEXT CHECK(late_outcome IS NULL OR late_outcome IN ('acked','failed'))`,
  `ALTER TABLE card_explicit_requests ADD COLUMN late_message_id TEXT`,
  `ALTER TABLE card_explicit_requests ADD COLUMN late_at INTEGER`,
  `CREATE TRIGGER IF NOT EXISTS trg_card_explicit_requests_settled
BEFORE UPDATE ON card_explicit_requests
WHEN (OLD.settled_by IS NOT NULL AND NEW.settled_by IS NOT OLD.settled_by)
  OR (OLD.settled_by IS NOT NULL AND OLD.state = 'ambiguous' AND NEW.state IS NOT OLD.state)
  OR (OLD.late_outcome IS NOT NULL AND (NEW.late_outcome IS NOT OLD.late_outcome
    OR NEW.late_message_id IS NOT OLD.late_message_id OR NEW.late_at IS NOT OLD.late_at))
  OR (NEW.late_outcome IS NOT NULL AND (NEW.settled_by IS NULL OR NEW.state <> 'ambiguous' OR NEW.late_at IS NULL))
  OR (NEW.late_outcome IS NULL AND (NEW.late_message_id IS NOT NULL OR NEW.late_at IS NOT NULL))
  OR (NEW.late_message_id IS NOT NULL AND NEW.late_outcome IS NOT 'acked')
BEGIN SELECT RAISE(ABORT, 'card_explicit_requests settlement is immutable'); END`,
];

/** DDL of one schema version, in application order. */
function ddlFor(version: 1 | 2 | 3): readonly string[] {
  return version === 3 ? [...CARD_V1_DDL, ...CARD_V3_DDL] : CARD_V1_DDL;
}

// ─── Reference schema and hash ──────────────────────────────────────────────

export interface SchemaObject {
  readonly type: string;
  readonly name: string;
  readonly tblName: string;
  readonly sql: string;
}

function readCardObjects(adapter: DbAdapter): SchemaObject[] {
  const rows = adapter
    .prepare(
      `SELECT type, name, tbl_name AS tblName, sql FROM sqlite_master
       WHERE (name LIKE 'card\\_%' ESCAPE '\\' OR tbl_name LIKE 'card\\_%' ESCAPE '\\'
              OR name LIKE 'idx\\_card\\_%' ESCAPE '\\' OR name LIKE 'trg\\_card\\_%' ESCAPE '\\')
         AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\'
       ORDER BY type, name`,
    )
    .all() as Array<{ type: string; name: string; tblName: string; sql: string | null }>;
  return rows.map((r) => ({ type: r.type, name: r.name, tblName: r.tblName, sql: r.sql ?? '' }));
}

const referenceCache = new Map<number, { objects: SchemaObject[]; hash: string }>();

/**
 * The exact card object set of `version` (default: current) on a pristine
 * database: `CARD_V1_DDL` for versions 1 and 2, plus `CARD_V3_DDL` for 3.
 */
export function referenceSchema(version: 1 | 2 | 3 = CARD_SCHEMA_VERSION): { objects: readonly SchemaObject[]; hash: string } {
  const cached = referenceCache.get(version);
  if (cached) return cached;
  const db = new Database(':memory:');
  try {
    for (const stmt of ddlFor(version)) db.exec(stmt);
    const objects = (db
      .prepare(
        `SELECT type, name, tbl_name AS tblName, sql FROM sqlite_master
         WHERE name NOT LIKE 'sqlite\\_%' ESCAPE '\\' ORDER BY type, name`,
      )
      .all() as Array<{ type: string; name: string; tblName: string; sql: string | null }>)
      .map((r) => ({ type: r.type, name: r.name, tblName: r.tblName, sql: r.sql ?? '' }));
    const ref = { objects, hash: hashObjects(objects) };
    referenceCache.set(version, ref);
    return ref;
  } finally {
    db.close();
  }
}

function hashObjects(objects: readonly SchemaObject[]): string {
  const h = createHash('sha256');
  for (const o of objects) h.update(`${o.type}\u0000${o.name}\u0000${o.tblName}\u0000${o.sql}\u0001`);
  return h.digest('hex');
}

// ─── Inspection ─────────────────────────────────────────────────────────────

export interface CardMeta {
  readonly schemaFamily: string;
  readonly schemaVersion: 1 | 2 | 3;
  readonly explicitLedgerVersion: number;
  readonly schemaHash: string;
  readonly lineageId: string;
  readonly installationRef: string;
  readonly createdBy: string;
  readonly createdAt: number;
  /**
   * Automatic cards written before durable terminal intent existed; never
   * adopted, given intent or edited by recovery. Empty for version 1 until
   * the upgrade records it.
   */
  readonly legacyIntentCards: ReadonlySet<string>;
}

export type SchemaInspection =
  | { readonly state: 'absent' }
  | { readonly state: 'complete'; readonly meta: CardMeta }
  | { readonly state: 'partial'; readonly missing: readonly string[] }
  | { readonly state: 'unknown'; readonly detail: 'extra_object' | 'object_mismatch' | 'meta_invalid' }
  | { readonly state: 'newer'; readonly schemaVersion: number };

const META_KEYS = [
  'schema_family',
  'schema_version',
  'explicit_ledger_version',
  'schema_hash',
  'lineage_id',
  'installation_ref',
  'created_by',
  'created_at',
] as const;

/** Version 2 key holding the exact legacy automatic card set. */
export const INTENT_LEGACY_KEY = 'intent_legacy';
export const INTENT_LEGACY_FORMAT = 1;
export const MAX_INTENT_LEGACY_CARDS = 2048;
const MAX_CARD_ID_BYTES = 1024;

/** Canonical `intent_legacy` text: sorted, unique ids. */
export function serializeIntentLegacy(cards: Iterable<string>): string {
  const ids = [...new Set(cards)].sort();
  return JSON.stringify({ format: INTENT_LEGACY_FORMAT, cards: ids });
}

/**
 * Parse `intent_legacy`. Only the exact canonical serialization is accepted,
 * so ordering, duplicates, extra keys and whitespace are all rejected.
 */
export function parseIntentLegacy(text: string): ReadonlySet<string> | null {
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  if (Object.keys(o).length !== 2 || o.format !== INTENT_LEGACY_FORMAT || !Array.isArray(o.cards)) return null;
  const cards = o.cards as unknown[];
  if (cards.length > MAX_INTENT_LEGACY_CARDS) return null;
  for (const id of cards) {
    if (typeof id !== 'string' || id.length === 0 || Buffer.byteLength(id, 'utf8') > MAX_CARD_ID_BYTES) return null;
  }
  if (serializeIntentLegacy(cards as string[]) !== text) return null;
  return new Set(cards as string[]);
}

function readMetaRaw(adapter: DbAdapter): Map<string, string> {
  const rows = adapter.prepare('SELECT k, v FROM card_meta').all() as Array<{ k: unknown; v: unknown }>;
  const out = new Map<string, string>();
  for (const r of rows) {
    if (typeof r.k !== 'string' || typeof r.v !== 'string') throw new Error('card_meta value type');
    out.set(r.k, r.v);
  }
  return out;
}

const DECIMAL = /^(0|[1-9][0-9]{0,15})$/;

function parseMeta(raw: Map<string, string>): CardMeta | 'newer' | null {
  const version = raw.get('schema_version');
  if (version !== undefined && DECIMAL.test(version) && Number(version) > CARD_SCHEMA_VERSION) return 'newer';
  const ledger = raw.get('explicit_ledger_version');
  if (ledger !== undefined && DECIMAL.test(ledger) && Number(ledger) > CARD_EXPLICIT_LEDGER_VERSION) return 'newer';
  const family = raw.get('schema_family');
  if (family !== undefined && family !== CARD_SCHEMA_FAMILY && /^card_v[0-9]+$/.test(family)) return 'newer';
  // Version 1 has exactly the base keys; versions 2 and 3 add exactly `intent_legacy`.
  let schemaVersion: 1 | 2 | 3;
  if (version === String(CARD_SCHEMA_VERSION_V1)) schemaVersion = 1;
  else if (version === String(CARD_SCHEMA_VERSION_V2)) schemaVersion = 2;
  else if (version === String(CARD_SCHEMA_VERSION)) schemaVersion = 3;
  else return null;
  if (raw.size !== META_KEYS.length + (schemaVersion >= 2 ? 1 : 0)) return null;
  for (const k of META_KEYS) if (!raw.has(k)) return null;
  let legacyIntentCards: ReadonlySet<string> = new Set<string>();
  if (schemaVersion >= 2) {
    const legacy = raw.get(INTENT_LEGACY_KEY);
    const parsed = legacy === undefined ? null : parseIntentLegacy(legacy);
    if (parsed === null) return null;
    legacyIntentCards = parsed;
  }
  const createdAt = raw.get('created_at') as string;
  if (
    family !== CARD_SCHEMA_FAMILY ||
    ledger !== String(CARD_EXPLICIT_LEDGER_VERSION) ||
    raw.get('created_by') !== CARD_META_CREATED_BY ||
    !DECIMAL.test(createdAt)
  ) {
    return null;
  }
  const lineageId = raw.get('lineage_id') as string;
  const installationRef = raw.get('installation_ref') as string;
  if (!isSafeRef(lineageId) || !isSafeRef(installationRef)) return null;
  return {
    schemaFamily: family,
    schemaVersion,
    explicitLedgerVersion: CARD_EXPLICIT_LEDGER_VERSION,
    schemaHash: raw.get('schema_hash') as string,
    lineageId,
    installationRef,
    createdBy: CARD_META_CREATED_BY,
    createdAt: Number(createdAt),
    legacyIntentCards,
  };
}

const SAFE_REF = /^[A-Za-z0-9._:-]{1,128}$/;

function isSafeRef(v: unknown): v is string {
  return typeof v === 'string' && SAFE_REF.test(v);
}

/**
 * Classify the card object set of an open database. Throws only when SQLite
 * itself fails (corrupt file, unreadable header); callers treat that as an
 * integrity failure.
 */
export function inspectCardSchema(adapter: DbAdapter): SchemaInspection {
  const actual = readCardObjects(adapter);
  if (actual.length === 0) return { state: 'absent' };

  // A newer binary may have rewritten or extended the schema; check its
  // declared version first so the rejection names the real cause.
  // The declared version selects the reference; anything unparsable is
  // compared against the current one and then fails on its metadata.
  let declared: 1 | 2 | 3 = CARD_SCHEMA_VERSION;
  if (actual.some((o) => o.type === 'table' && o.name === 'card_meta')) {
    let raw: Map<string, string> | null = null;
    try {
      raw = readMetaRaw(adapter);
    } catch {
      return { state: 'unknown', detail: 'meta_invalid' };
    }
    const parsed = parseMeta(raw);
    if (parsed === 'newer') {
      const v = raw.get('schema_version');
      return { state: 'newer', schemaVersion: v !== undefined && DECIMAL.test(v) ? Number(v) : CARD_SCHEMA_VERSION + 1 };
    }
    if (parsed !== null) declared = parsed.schemaVersion;
  }

  const ref = referenceSchema(declared);
  const refByKey = new Map(ref.objects.map((o) => [`${o.type}:${o.name}`, o]));
  const actualByKey = new Map(actual.map((o) => [`${o.type}:${o.name}`, o]));
  for (const key of actualByKey.keys()) {
    if (!refByKey.has(key)) return { state: 'unknown', detail: 'extra_object' };
  }
  const missing: string[] = [];
  for (const [key, o] of refByKey) {
    const a = actualByKey.get(key);
    if (!a) {
      missing.push(o.name);
      continue;
    }
    if (a.sql !== o.sql || a.tblName !== o.tblName) return { state: 'unknown', detail: 'object_mismatch' };
  }
  if (missing.length > 0) return { state: 'partial', missing };

  let raw: Map<string, string>;
  try {
    raw = readMetaRaw(adapter);
  } catch {
    return { state: 'unknown', detail: 'meta_invalid' };
  }
  const meta = parseMeta(raw);
  if (meta === null || meta === 'newer' || meta.schemaVersion !== declared || meta.schemaHash !== ref.hash) {
    return { state: 'unknown', detail: 'meta_invalid' };
  }
  return { state: 'complete', meta };
}

// ─── Integrity and invariants ───────────────────────────────────────────────

export type InvariantViolation =
  | 'integrity_check'
  | 'foreign_key'
  | 'handler_invocation_count'
  | 'handler_send_count'
  | 'send_slot_range'
  | 'request_card_mismatch'
  | 'admission_session_state'
  | 'session_card_kind'
  | 'disposition_admission'
  | 'cursor_halt'
  | 'terminal_intent_shape'
  | 'intent_legacy_conflict';

/** Ids listed in `intent_legacy`; no rows for a version 1 store. */
export const LEGACY_IDS_SQL = `SELECT value FROM json_each((SELECT v FROM card_meta WHERE k = '${INTENT_LEGACY_KEY}'), '$.cards')`;

/** Full integrity, FK closure and cross-row invariant check of the card graph. */
export function checkCardInvariants(adapter: DbAdapter): InvariantViolation[] {
  const out: InvariantViolation[] = [];
  const integrity = adapter.prepare('PRAGMA integrity_check').all() as Array<Record<string, unknown>>;
  if (integrity.length !== 1 || Object.values(integrity[0] ?? {})[0] !== 'ok') out.push('integrity_check');
  for (const table of CARD_TABLES) {
    if (adapter.prepare(`PRAGMA foreign_key_check(${table})`).all().length > 0) {
      out.push('foreign_key');
      break;
    }
  }
  const one = (sql: string): boolean => adapter.prepare(sql).get() !== undefined;
  if (
    one(`SELECT 1 FROM card_handler_generations g
         WHERE g.invocation_count < (SELECT count(*) FROM card_explicit_requests r WHERE r.generation = g.generation)`)
  ) {
    out.push('handler_invocation_count');
  }
  // High-water counters never refund, while settled request rows are pruned by
  // retention; only a counter below retained evidence (restore regression) is invalid.
  if (
    one(`SELECT 1 FROM card_handler_generations g
         WHERE g.logical_send_count < (SELECT count(*) FROM card_explicit_requests r
                                        WHERE r.generation = g.generation AND r.send_slot IS NOT NULL)`)
  ) {
    out.push('handler_send_count');
  }
  if (
    one(`SELECT 1 FROM card_explicit_requests r JOIN card_handler_generations g USING(generation)
         WHERE r.send_slot IS NOT NULL AND r.send_slot > g.logical_send_count`)
  ) {
    out.push('send_slot_range');
  }
  if (
    one(`SELECT 1 FROM card_explicit_requests r JOIN card_messages m ON m.card_id = r.card_id
         WHERE m.client_msg_no IS NOT r.client_msg_no OR m.kind <> r.opcode`)
  ) {
    out.push('request_card_mismatch');
  }
  if (
    one(`SELECT 1 FROM card_admissions a JOIN card_sessions s USING(session_id)
         WHERE s.status NOT IN ('admitted','ambiguous','completed','failed')
            OR (a.state IN ('completed','failed') AND s.status <> a.state)`) ||
    one(`SELECT 1 FROM card_sessions s WHERE s.status IN ('admitted','completed')
         AND NOT EXISTS (SELECT 1 FROM card_admissions a WHERE a.session_id = s.session_id)`)
  ) {
    out.push('admission_session_state');
  }
  if (one(`SELECT 1 FROM card_sessions s JOIN card_messages m USING(card_id) WHERE m.kind <> 'interactive'`)) {
    out.push('session_card_kind');
  }
  if (
    one(`SELECT 1 FROM card_admissions a WHERE NOT EXISTS (
           SELECT 1 FROM card_event_dispositions d
           WHERE d.event_id = a.event_id AND d.disposition = 'admitted' AND d.session_id = a.session_id)`) ||
    one(`SELECT 1 FROM card_event_dispositions d WHERE d.disposition = 'admitted' AND NOT EXISTS (
           SELECT 1 FROM card_admissions a WHERE a.event_id = d.event_id)`)
  ) {
    out.push('disposition_admission');
  }
  if (one(`SELECT 1 FROM card_event_cursor WHERE halted_reason IS NOT NULL AND length(halted_reason) = 0`)) {
    out.push('cursor_halt');
  }
  // A live row may carry a terminal reason only as the durable intent of a
  // bound automatic card that has reserved its terminal sequence.
  if (
    one(`SELECT 1 FROM card_messages WHERE terminal_at IS NULL AND terminal_reason IS NOT NULL
         AND NOT (kind = 'automatic' AND message_id IS NOT NULL AND seq_reserved >= 1 AND state IN ('active','answering'))`)
  ) {
    out.push('terminal_intent_shape');
  }
  if (
    one(`SELECT 1 FROM card_messages m WHERE m.terminal_at IS NULL AND m.terminal_reason IS NOT NULL
         AND m.card_id IN (${LEGACY_IDS_SQL})`)
  ) {
    out.push('intent_legacy_conflict');
  }
  return out;
}

/** Rows in the protected card graph, excluding `card_meta`. */
export function countProtectedRows(adapter: DbAdapter): number {
  let total = 0;
  for (const table of CARD_TABLES) {
    if (table === 'card_meta') continue;
    total += (adapter.prepare(`SELECT count(*) AS c FROM ${table}`).get() as { c: number }).c;
  }
  return total;
}

// ─── Migration ──────────────────────────────────────────────────────────────

export interface MigrationInput {
  readonly installationRef: string;
  readonly lineageId: string;
  readonly nowMs: number;
}

/**
 * Create the `card_v1` family and its metadata in one write transaction.
 * Rerunning against an identical installation is a no-op; legacy tables are
 * never touched.
 */
export function migrateCardSchema(adapter: DbAdapter, input: MigrationInput): CardMeta {
  if (!isSafeRef(input.installationRef) || !isSafeRef(input.lineageId)) {
    throw new Error('invalid installation or lineage reference');
  }
  if (adapter.inTransaction) throw new Error('card migration cannot run inside a transaction');
  const ref = referenceSchema();
  adapter.exec('BEGIN IMMEDIATE');
  try {
    // A partial install has no metadata yet; only a fresh family gets the v3 columns.
    const fresh = readCardObjects(adapter).length === 0;
    for (const stmt of fresh ? ddlFor(CARD_SCHEMA_VERSION) : CARD_V1_DDL) adapter.exec(stmt);
    const insert = adapter.prepare('INSERT OR IGNORE INTO card_meta (k, v) VALUES (?, ?)');
    const values: Record<(typeof META_KEYS)[number] | typeof INTENT_LEGACY_KEY, string> = {
      schema_family: CARD_SCHEMA_FAMILY,
      schema_version: String(CARD_SCHEMA_VERSION),
      explicit_ledger_version: String(CARD_EXPLICIT_LEDGER_VERSION),
      schema_hash: ref.hash,
      lineage_id: input.lineageId,
      installation_ref: input.installationRef,
      created_by: CARD_META_CREATED_BY,
      created_at: String(Math.trunc(input.nowMs)),
      // A fresh store has no card written without intent.
      intent_legacy: serializeIntentLegacy([]),
    };
    for (const k of [...META_KEYS, INTENT_LEGACY_KEY] as const) insert.run(k, values[k]);
    const inspected = inspectCardSchema(adapter);
    if (inspected.state !== 'complete') throw new Error(`card schema not complete after migration: ${inspected.state}`);
    if (inspected.meta.installationRef !== input.installationRef) {
      throw new Error('card schema belongs to a different installation');
    }
    adapter.exec('COMMIT');
    return inspected.meta;
  } catch (err) {
    if (adapter.inTransaction) adapter.exec('ROLLBACK');
    throw err;
  }
}

/**
 * Upgrade a complete version 1 store to version 2 in one write transaction:
 * record every live automatic card as legacy, then bump the version. More
 * than `MAX_INTENT_LEGACY_CARDS` legacy cards, a lineage change or any
 * invariant violation throws and rolls back, leaving version 1 untouched.
 */
export function upgradeCardSchemaV1toV2(adapter: DbAdapter, expectedLineageId: string): CardMeta {
  if (adapter.inTransaction) throw new Error('card migration cannot run inside a transaction');
  adapter.exec('BEGIN IMMEDIATE');
  try {
    const before = inspectCardSchema(adapter);
    if (before.state !== 'complete' || before.meta.schemaVersion !== 1 || before.meta.lineageId !== expectedLineageId) {
      throw new Error('card schema is not the expected version 1 store');
    }
    const legacy = (adapter
      .prepare(`SELECT card_id FROM card_messages WHERE kind = 'automatic' AND terminal_at IS NULL ORDER BY card_id`)
      .all() as Array<{ card_id: string }>).map((r) => r.card_id);
    if (legacy.length > MAX_INTENT_LEGACY_CARDS) throw new Error('too many legacy automatic cards');
    adapter.prepare('INSERT INTO card_meta (k, v) VALUES (?, ?)').run(INTENT_LEGACY_KEY, serializeIntentLegacy(legacy));
    const bumped = adapter
      .prepare(`UPDATE card_meta SET v = ? WHERE k = 'schema_version' AND v = ?`)
      .run(String(CARD_SCHEMA_VERSION_V2), String(CARD_SCHEMA_VERSION_V1)).changes;
    if (bumped !== 1) throw new Error('card schema version changed during upgrade');
    const after = inspectCardSchema(adapter);
    if (after.state !== 'complete' || after.meta.schemaVersion !== 2 || after.meta.lineageId !== expectedLineageId) {
      throw new Error('card schema not complete after upgrade');
    }
    if (checkCardInvariants(adapter).length > 0) throw new Error('card invariants failed after upgrade');
    adapter.exec('COMMIT');
    return after.meta;
  } catch (err) {
    if (adapter.inTransaction) adapter.exec('ROLLBACK');
    throw err;
  }
}

/**
 * Upgrade a complete version 2 store to version 3 (SC-1) in one write
 * transaction: add the nullable settlement/audit columns and their trigger,
 * then bump the version and schema hash. Existing rows keep every value
 * (the new columns are NULL). Any failure rolls back to version 2.
 */
export function upgradeCardSchemaV2toV3(adapter: DbAdapter, expectedLineageId: string): CardMeta {
  if (adapter.inTransaction) throw new Error('card migration cannot run inside a transaction');
  adapter.exec('BEGIN IMMEDIATE');
  try {
    const before = inspectCardSchema(adapter);
    if (before.state !== 'complete' || before.meta.schemaVersion !== 2 || before.meta.lineageId !== expectedLineageId) {
      throw new Error('card schema is not the expected version 2 store');
    }
    for (const stmt of CARD_V3_DDL) adapter.exec(stmt);
    const set = adapter.prepare(`UPDATE card_meta SET v = ? WHERE k = ? AND v = ?`);
    if (set.run(String(CARD_SCHEMA_VERSION), 'schema_version', String(CARD_SCHEMA_VERSION_V2)).changes !== 1
      || set.run(referenceSchema(3).hash, 'schema_hash', referenceSchema(2).hash).changes !== 1) {
      throw new Error('card schema metadata changed during upgrade');
    }
    const after = inspectCardSchema(adapter);
    if (after.state !== 'complete' || after.meta.schemaVersion !== 3 || after.meta.lineageId !== expectedLineageId) {
      throw new Error('card schema not complete after upgrade');
    }
    if (checkCardInvariants(adapter).length > 0) throw new Error('card invariants failed after upgrade');
    adapter.exec('COMMIT');
    return after.meta;
  } catch (err) {
    if (adapter.inTransaction) adapter.exec('ROLLBACK');
    throw err;
  }
}

// ─── Online backup ──────────────────────────────────────────────────────────

export interface BackupReceipt {
  /** File name only; directories are deployment-private. */
  readonly fileName: string;
  readonly path: string;
  readonly sha256: string;
  readonly bytes: number;
}

function utcStamp(nowMs: number): string {
  return new Date(nowMs).toISOString().replace(/[-:]/g, '').replace('.', '');
}

function ensurePrivateDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
}

/** Backup label of the first install; unchanged so its file name stays the same. */
export const FIRST_INSTALL_BACKUP_LABEL = `pre-${CARD_SCHEMA_FAMILY}`;
/** Backup label of the version 1 → 2 upgrade. */
export const UPGRADE_V2_BACKUP_LABEL = `pre-${CARD_SCHEMA_FAMILY}-s2`;
/** Backup label before the SC-1 upgrade to version 3. */
export const UPGRADE_V3_BACKUP_LABEL = `pre-${CARD_SCHEMA_FAMILY}-s3`;

/**
 * Online pre-mutation backup: `<backupDir>/cc-octo.<label>.<utc>.db`
 * (`pre-card_v1` by default), mode 0600 inside a 0700 directory. The
 * destination is created exclusively before SQLite writes into it, and the
 * copy must pass `integrity_check` before the receipt is returned.
 */
export async function backupBeforeMigration(
  adapter: DbAdapter,
  backupDir: string,
  nowMs: number,
  label: string = FIRST_INSTALL_BACKUP_LABEL,
): Promise<BackupReceipt> {
  if (label !== FIRST_INSTALL_BACKUP_LABEL && label !== UPGRADE_V2_BACKUP_LABEL && label !== UPGRADE_V3_BACKUP_LABEL) throw new Error('invalid backup label');
  ensurePrivateDir(backupDir);
  const fileName = `cc-octo.${label}.${utcStamp(nowMs)}.db`;
  const path = join(backupDir, fileName);
  const fd = openSync(path, 'wx', 0o600);
  closeSync(fd);
  chmodSync(path, 0o600);
  try {
    await adapter.backup(path);
    chmodSync(path, 0o600);
    // The copy inherits WAL mode; make it a single self-contained file so no
    // -wal/-shm side files exist outside the receipt, then verify it.
    const check = new Database(path, { fileMustExist: true });
    try {
      check.pragma('journal_mode = DELETE');
      const rows = check.prepare('PRAGMA integrity_check').all() as Array<Record<string, unknown>>;
      if (rows.length !== 1 || Object.values(rows[0] ?? {})[0] !== 'ok') throw new Error('backup integrity check failed');
    } finally {
      check.close();
    }
  } catch (err) {
    for (const suffix of ['', '-wal', '-shm', '-journal']) rmSync(`${path}${suffix}`, { force: true });
    throw err;
  }
  const bytes = readFileSync(path);
  return { fileName, path, sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length };
}

// ─── Activation / recovery marker ───────────────────────────────────────────

export const ACTIVATION_MARKER_FORMAT = 'cc-octo-card-activation';
export const ACTIVATION_MARKER_VERSION = 1;

export interface ActivationMarker {
  readonly installationRef: string;
  /** Positive first-install provenance is `false`; it flips once and never back. */
  readonly everActivated: boolean;
  readonly schemaFamily: string | null;
  readonly lineageId: string | null;
  readonly backupRef: string | null;
  readonly recoveryClearanceRef: string | null;
  readonly updatedAt: number;
}

export type MarkerRead =
  | { readonly state: 'absent' }
  | { readonly state: 'invalid' }
  | { readonly state: 'present'; readonly marker: ActivationMarker };

/** Independent provenance port; deployments own where the marker lives. */
export interface ActivationMarkerPort {
  read(): MarkerRead;
  /** Durable before returning (file data and directory entry synced). */
  write(marker: ActivationMarker): void;
}

const MARKER_KEYS = [
  'format',
  'version',
  'installationRef',
  'everActivated',
  'schemaFamily',
  'lineageId',
  'backupRef',
  'recoveryClearanceRef',
  'updatedAt',
] as const;

const MAX_MARKER_BYTES = 4096;

export function parseActivationMarker(text: string): ActivationMarker | null {
  if (Buffer.byteLength(text, 'utf8') > MAX_MARKER_BYTES) return null;
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const keys = Object.keys(o);
  if (keys.length !== MARKER_KEYS.length || !MARKER_KEYS.every((k) => Object.hasOwn(o, k))) return null;
  const nullableRef = (x: unknown): x is string | null => x === null || isSafeRef(x);
  if (
    o.format !== ACTIVATION_MARKER_FORMAT ||
    o.version !== ACTIVATION_MARKER_VERSION ||
    !isSafeRef(o.installationRef) ||
    typeof o.everActivated !== 'boolean' ||
    !(o.schemaFamily === null || (typeof o.schemaFamily === 'string' && /^card_v[0-9]{1,6}$/.test(o.schemaFamily))) ||
    !nullableRef(o.lineageId) ||
    !nullableRef(o.backupRef) ||
    !nullableRef(o.recoveryClearanceRef) ||
    typeof o.updatedAt !== 'number' ||
    !Number.isSafeInteger(o.updatedAt) ||
    o.updatedAt < 0
  ) {
    return null;
  }
  // Activation is a one-way fact bound to a lineage.
  if (o.everActivated && (o.lineageId === null || o.schemaFamily === null)) return null;
  if (!o.everActivated && (o.lineageId !== null || o.schemaFamily !== null)) return null;
  return {
    installationRef: o.installationRef,
    everActivated: o.everActivated,
    schemaFamily: o.schemaFamily as string | null,
    lineageId: o.lineageId as string | null,
    backupRef: o.backupRef as string | null,
    recoveryClearanceRef: o.recoveryClearanceRef as string | null,
    updatedAt: o.updatedAt,
  };
}

export function serializeActivationMarker(marker: ActivationMarker): string {
  return `${JSON.stringify({
    format: ACTIVATION_MARKER_FORMAT,
    version: ACTIVATION_MARKER_VERSION,
    installationRef: marker.installationRef,
    everActivated: marker.everActivated,
    schemaFamily: marker.schemaFamily,
    lineageId: marker.lineageId,
    backupRef: marker.backupRef,
    recoveryClearanceRef: marker.recoveryClearanceRef,
    updatedAt: marker.updatedAt,
  })}\n`;
}

/** File marker: atomic temp-write, fsync, rename, directory fsync; 0600 in 0700. */
export class FileActivationMarker implements ActivationMarkerPort {
  constructor(private readonly path: string) {}

  /**
   * Read through the shared provenance reader (S2-b): runs on the startup path
   * under the Bot lock, so it never follows a symlink or blocks on a FIFO, and
   * accepts only a private regular file within the marker's own byte bound.
   * Missing is `absent`; anything else unreadable or malformed is `invalid`.
   */
  read(): MarkerRead {
    const file = readPrivateRegularFile(this.path, MAX_MARKER_BYTES);
    if (file.kind === 'missing') return { state: 'absent' };
    if (file.kind === 'invalid') return { state: 'invalid' };
    const text = decodeStrictUtf8(file.bytes);
    if (text === null) return { state: 'invalid' };
    const marker = parseActivationMarker(text);
    return marker ? { state: 'present', marker } : { state: 'invalid' };
  }

  write(marker: ActivationMarker): void {
    const dir = dirname(this.path);
    ensurePrivateDir(dir);
    const tmp = join(dir, `.${basename(this.path)}.${randomUUID()}.tmp`);
    const fd = openSync(tmp, 'wx', 0o600);
    try {
      writeSync(fd, serializeActivationMarker(marker));
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    try {
      renameSync(tmp, this.path);
    } catch (err) {
      rmSync(tmp, { force: true });
      throw err;
    }
    const dfd = openSync(dir, 'r');
    try {
      fsyncSync(dfd);
    } catch {
      // Some platforms reject fsync on a directory handle; the rename is still atomic.
    } finally {
      closeSync(dfd);
    }
  }
}

/**
 * Deployment-side provisioning of positive first-install provenance. It never
 * overwrites an existing marker, so it cannot erase prior activation.
 */
export function provisionFirstInstallMarker(path: string, installationRef: string, nowMs: number): void {
  if (!isSafeRef(installationRef)) throw new Error('invalid installation reference');
  ensurePrivateDir(dirname(path));
  const fd = openSync(path, 'wx', 0o600);
  try {
    writeSync(
      fd,
      serializeActivationMarker({
        installationRef,
        everActivated: false,
        schemaFamily: null,
        lineageId: null,
        backupRef: null,
        recoveryClearanceRef: null,
        updatedAt: Math.trunc(nowMs),
      }),
    );
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

export function isSafeStoreRef(v: unknown): v is string {
  return isSafeRef(v);
}
