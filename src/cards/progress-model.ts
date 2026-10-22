/**
 * Automatic progress model (TD v3 §3.2 / PRD §7.4, WP-06 C08a).
 *
 * Pure reduction of the bridge's `item_state` events into stable rows keyed
 * by `(attempt, itemId)`:
 * - one row per item: later snapshots and the completion update it in place,
 *   and a completion-only item produces exactly one completed row;
 * - a completed/failed row never regresses on a late update;
 * - attempts are never merged, so a retry adds its own rows;
 * - reasoning/todo items only raise the activity flag (no row, no send);
 * - injected card-tool items (trusted server identity) are excluded.
 *
 * Rows hold reducer facts only (`redact.reduceItem`), never raw SDK fields.
 * Retention is bounded; evicted rows are counted as omitted.
 */

import type { ItemState, SafeCategory, SafeItemFacts } from "./contracts.js";

export type RowItemType = "command_execution" | "file_change" | "mcp_tool_call" | "web_search";
export type RowStatus = "in_progress" | "completed" | "failed";

export interface ProgressRow {
  readonly attempt: number;
  readonly itemId: string;
  /** First-sight bridge sequence; rows are kept in this order. */
  readonly order: number;
  readonly itemType: RowItemType;
  readonly status: RowStatus;
  readonly safe: SafeItemFacts;
}

export interface ProgressModel {
  readonly rows: readonly ProgressRow[];
  /** Rows evicted by the retention bound. */
  readonly omitted: number;
  /** A reasoning/todo item was seen; activity only, never displayable. */
  readonly activity: boolean;
}

/** Upper bound on retained rows; the frame shows at most the newest 12. */
export const MAX_RETAINED_ROWS = 48;

export const EMPTY_PROGRESS: ProgressModel = Object.freeze({ rows: Object.freeze([]) as readonly ProgressRow[], omitted: 0, activity: false });

const ROW_TYPES: ReadonlySet<string> = new Set<RowItemType>(["command_execution", "file_change", "mcp_tool_call", "web_search"]);
const ACTIVITY_TYPES: ReadonlySet<string> = new Set(["reasoning", "todo_list"]);
const PHASES: ReadonlySet<string> = new Set(["started", "updated", "completed"]);
const STATUSES: ReadonlySet<string> = new Set(["in_progress", "completed", "failed"]);
const CATEGORIES: ReadonlySet<string> = new Set<SafeCategory>(["command", "file_change", "web_search", "tool", "activity"]);

function wellFormed(ev: unknown): ev is ItemState {
  if (ev === null || typeof ev !== "object") return false;
  const e = ev as Record<string, unknown>;
  if (e.kind !== "item_state") return false;
  if (!Number.isSafeInteger(e.attempt) || (e.attempt as number) < 0) return false;
  if (typeof e.itemId !== "string" || e.itemId.length === 0) return false;
  if (!Number.isSafeInteger(e.seq)) return false;
  if (typeof e.itemType !== "string" || !(ROW_TYPES.has(e.itemType) || ACTIVITY_TYPES.has(e.itemType))) return false;
  if (typeof e.phase !== "string" || !PHASES.has(e.phase)) return false;
  if (e.status !== undefined && (typeof e.status !== "string" || !STATUSES.has(e.status))) return false;
  const safe = e.safe as Record<string, unknown> | null;
  return safe !== null && typeof safe === "object" && typeof safe.category === "string" && CATEGORIES.has(safe.category);
}

/** Command, file, non-injected MCP and search items form rows. */
export function isDisplayableItem(ev: ItemState): boolean {
  return wellFormed(ev) && ROW_TYPES.has(ev.itemType) && ev.safe.mcpServerId === undefined;
}

export function hasDisplayableRow(model: ProgressModel): boolean {
  return model.rows.length > 0;
}

function statusOf(ev: ItemState): RowStatus {
  if (ev.status === "failed") return "failed";
  if (ev.phase === "completed" || ev.status === "completed") return "completed";
  return "in_progress";
}

function freezeFacts(safe: SafeItemFacts): SafeItemFacts {
  return Object.isFrozen(safe) ? safe : Object.freeze({ ...safe });
}

/** Pure; returns the same model for ignored or malformed events. */
export function reduceProgress(model: ProgressModel, ev: ItemState): ProgressModel {
  if (!wellFormed(ev)) return model;
  if (ACTIVITY_TYPES.has(ev.itemType)) {
    return model.activity ? model : Object.freeze({ ...model, activity: true });
  }
  if (ev.safe.mcpServerId !== undefined) return model;
  const index = model.rows.findIndex((r) => r.attempt === ev.attempt && r.itemId === ev.itemId);
  const status = statusOf(ev);
  if (index >= 0) {
    const prev = model.rows[index] as ProgressRow;
    const next: ProgressRow = Object.freeze({
      ...prev,
      // A terminal row is absorbing; a late in-progress snapshot never reopens it.
      status: prev.status === "in_progress" ? status : prev.status,
      safe: freezeFacts(ev.safe),
    });
    const rows = model.rows.slice();
    rows[index] = next;
    return Object.freeze({ ...model, rows: Object.freeze(rows) });
  }
  // An update for an evicted row (older than every retained row) is dropped.
  const oldest = model.rows[0];
  if (model.omitted > 0 && oldest !== undefined && (ev.attempt < oldest.attempt
    || (ev.attempt === oldest.attempt && ev.seq < oldest.order))) return model;
  const row: ProgressRow = Object.freeze({
    attempt: ev.attempt, itemId: ev.itemId, order: ev.seq, itemType: ev.itemType as RowItemType, status,
    safe: freezeFacts(ev.safe),
  });
  const rows = [...model.rows, row];
  let omitted = model.omitted;
  while (rows.length > MAX_RETAINED_ROWS) { rows.shift(); omitted++; }
  return Object.freeze({ ...model, rows: Object.freeze(rows), omitted });
}
