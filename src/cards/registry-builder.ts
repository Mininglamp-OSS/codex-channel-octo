/**
 * Registry frame builder and automatic lifecycle mapping (WP-06 C08a).
 *
 * Pure. Builds `ai.reasoning-process` template-ref frames from the progress
 * model and maps each reachable lifecycle reason to the PRD §7.4 view, wire
 * state and visible text:
 * - the newest 6 phases (one per attempt, never merged) carrying at most 12
 *   actions, with an omitted-items indicator;
 * - closed category labels and reducer facts only; no answer body, reasoning
 *   text or raw tool data;
 * - no controls: the pinned template must be control-free (AC-018.5), and
 *   Stopped, paused and expired are not reachable reasons;
 * - fitted before transport so that both the initial send and a worst-case
 *   edit envelope stay within the negotiated cap (AC-007.4).
 *
 * Every frame satisfies the server `ai.reasoning-process@0.4.1` data
 * contract: active states always carry `progressText`, every action has a
 * non-empty `detail` and status labels stay within 32 characters.
 *
 * The `timed_out` text is provisional pending OD-5: it shows the reason label
 * without the "a later reply may still arrive" clause, because main revokes
 * publication on timeout and never delivers a late answer.
 */

import { serializeEditRegistry, serializeSendRegistry } from "./api.js";
import type {
  CardRoute, PinnedTemplate, RegistryAction, RegistryData, RegistryPhase, RegistryView, TemplateRef, WireState,
} from "./contracts.js";
import type { ProgressModel, ProgressRow } from "./progress-model.js";

/** Structurally the registry member of the write queue's `CardFrame`. */
export interface RegistryFrame {
  readonly k: "registry";
  readonly ref: TemplateRef;
  readonly state: WireState;
  readonly data: RegistryData;
}

export const AUTOMATIC_REASONS = Object.freeze([
  "working", "answering", "completed", "failed", "interrupted", "timed_out", "policy_revoked",
] as const);
export type AutomaticReason = typeof AUTOMATIC_REASONS[number];
export type TerminalReason = Exclude<AutomaticReason, "working" | "answering">;

export interface LifecycleView {
  readonly view: RegistryView;
  readonly state: WireState;
  readonly reason: AutomaticReason;
  readonly text: string;
  readonly tone: RegistryData["statusTone"];
}

/** OD-5 provisional label: the reason only, with no late-reply promise. */
export const TIMED_OUT_PROVISIONAL_TEXT = "Timed out";

const VIEWS: Readonly<Record<AutomaticReason, LifecycleView>> = Object.freeze({
  working: Object.freeze({ view: "active", state: "reasoning", reason: "working", text: "Working", tone: "Accent" }),
  answering: Object.freeze({ view: "active", state: "answering", reason: "answering", text: "Answering", tone: "Accent" }),
  completed: Object.freeze({ view: "result", state: "completed", reason: "completed", text: "Completed", tone: "Good" }),
  failed: Object.freeze({ view: "error", state: "error", reason: "failed", text: "Failed", tone: "Attention" }),
  interrupted: Object.freeze({ view: "error", state: "error", reason: "interrupted", text: "Interrupted; needs review", tone: "Warning" }),
  timed_out: Object.freeze({ view: "error", state: "error", reason: "timed_out", text: TIMED_OUT_PROVISIONAL_TEXT, tone: "Warning" }),
  policy_revoked: Object.freeze({ view: "error", state: "error", reason: "policy_revoked", text: "Unavailable by policy", tone: "Attention" }),
} satisfies Record<AutomaticReason, LifecycleView>);

export function lifecycleView(reason: AutomaticReason): LifecycleView {
  return VIEWS[reason];
}

export function isTerminalReason(reason: AutomaticReason): reason is TerminalReason {
  return reason !== "working" && reason !== "answering";
}

export interface BuildOptions {
  /** Opaque per-card identifier; never a user, route or turn identifier. */
  readonly reasoningId: string;
  readonly elapsedMs: number;
  /** Trusted route of the card, used only to measure the real envelope. */
  readonly route: CardRoute;
  readonly clientMsgNo: string;
  /** `min(policy maxPayloadBytes, 16384)`. */
  readonly maxEnvelopeBytes: number;
}

export const MAX_PHASES = 6;
export const MAX_ACTIONS = 12;

/** Largest message id and sequence a later edit can carry. */
const WORST_MESSAGE_ID = "9223372036854775807";
const TITLE = "Progress";

export function formatElapsed(ms: number): string {
  const total = Number.isFinite(ms) && ms > 0 ? Math.floor(ms / 1000) : 0;
  if (total < 60) return `${total}s`;
  const minutes = Math.floor(total / 60);
  if (minutes < 60) return `${minutes}m ${String(total % 60).padStart(2, "0")}s`;
  const hours = Math.min(Math.floor(minutes / 60), 999_999);
  return `${hours}h ${String(minutes % 60).padStart(2, "0")}m`;
}

const TOOL_LABEL: Readonly<Record<ProgressRow["itemType"], string>> = Object.freeze({
  command_execution: "Command", file_change: "File change", web_search: "Search", mcp_tool_call: "Tool",
});

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

/** Fixed per-kind detail when the reducer kept no safe fact for the row. */
const DETAIL_FALLBACK: Readonly<Record<ProgressRow["itemType"], string>> = Object.freeze({
  command_execution: "Shell command", file_change: "File edit", web_search: "Web search", mcp_tool_call: "Tool call",
});

function detailOf(row: ProgressRow): string {
  const safe = row.safe;
  let detail: string | undefined;
  switch (row.itemType) {
    case "command_execution": detail = safe.program; break;
    case "file_change": detail = safe.fileCount !== undefined ? plural(safe.fileCount, "file") : undefined; break;
    case "web_search": detail = safe.domain; break;
    case "mcp_tool_call": detail = undefined; break;
  }
  return detail || DETAIL_FALLBACK[row.itemType];
}

function actionOf(row: ProgressRow): RegistryAction {
  const [statusGlyph, statusTone] = row.status === "completed" ? ["✓", "Good"] as const
    : row.status === "failed" ? ["✗", "Attention"] as const : ["…", "Accent"] as const;
  return { tool: TOOL_LABEL[row.itemType], detail: detailOf(row), statusGlyph, statusTone };
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const key of Object.keys(value)) deepFreeze((value as Record<string, unknown>)[key]);
    Object.freeze(value);
  }
  return value;
}

/** Newest rows first-in-last-out, grouped by attempt; at most `maxActions` actions in `MAX_PHASES` phases. */
function phasesOf(model: ProgressModel, maxActions: number): { phases: RegistryPhase[]; shown: number } {
  const newest = model.rows.slice(Math.max(0, model.rows.length - maxActions));
  const groups: { attempt: number; rows: ProgressRow[] }[] = [];
  for (const row of newest) {
    const last = groups.at(-1);
    if (last !== undefined && last.attempt === row.attempt) last.rows.push(row);
    else groups.push({ attempt: row.attempt, rows: [row] });
  }
  const kept = groups.slice(Math.max(0, groups.length - MAX_PHASES));
  const multiple = new Set(model.rows.map((r) => r.attempt)).size > 1;
  const phases = kept.map((g) => ({ thought: multiple ? `Attempt ${g.attempt + 1}` : "Steps", actions: g.rows.map(actionOf) }));
  return { phases, shown: kept.reduce((n, g) => n + g.rows.length, 0) };
}

function controlFree(pinned: PinnedTemplate): boolean {
  return pinned !== null && typeof pinned === "object" && pinned.controlFree === true
    && pinned.views?.active?.controlFree === true && pinned.views?.error?.controlFree === true
    && pinned.views?.result?.controlFree === true;
}

function fits(frame: RegistryFrame, opts: BuildOptions): boolean {
  try {
    serializeSendRegistry({ route: opts.route, clientMsgNo: opts.clientMsgNo, ref: frame.ref, state: frame.state,
      data: frame.data, maxEnvelopeBytes: opts.maxEnvelopeBytes });
    serializeEditRegistry({ route: opts.route, messageId: WORST_MESSAGE_ID, ref: frame.ref, state: frame.state,
      data: frame.data, seq: Number.MAX_SAFE_INTEGER, transient: true, maxEnvelopeBytes: opts.maxEnvelopeBytes });
    return true;
  } catch {
    return false;
  }
}

function frameOf(pinned: PinnedTemplate, v: LifecycleView, data: Omit<RegistryData, "state" | "statusLabel" | "statusTone" | "title">): RegistryFrame {
  const full: RegistryData = {
    reasoningId: data.reasoningId, state: v.state, title: TITLE, statusLabel: v.text, statusTone: v.tone,
    timerText: data.timerText, traceExpanded: data.traceExpanded, traceCollapsed: data.traceCollapsed,
    collapsedSummary: data.collapsedSummary,
    ...(data.progressText !== undefined ? { progressText: data.progressText } : {}),
    phases: data.phases,
    ...(v.view === "error" ? { errorTitle: v.text, errorMessage: v.text } : {}),
  };
  return deepFreeze({ k: "registry", ref: { id: pinned.id, version: pinned.version }, state: v.state, data: full });
}

/**
 * Progress frame for the current model and reason, or `undefined` when there
 * is no displayable row, the template is not control-free, or not even one
 * action fits the envelope cap.
 */
export function buildProgressFrame(model: ProgressModel, reason: AutomaticReason, pinned: PinnedTemplate, opts: BuildOptions): RegistryFrame | undefined {
  if (!controlFree(pinned) || model.rows.length === 0 || !Object.hasOwn(VIEWS, reason)) return undefined;
  const v = VIEWS[reason];
  const total = model.rows.length + model.omitted;
  for (let maxActions = MAX_ACTIONS; maxActions >= 1; maxActions--) {
    const { phases, shown } = phasesOf(model, maxActions);
    const hidden = total - shown;
    const frame = frameOf(pinned, v, {
      reasoningId: opts.reasoningId,
      timerText: formatElapsed(opts.elapsedMs),
      traceExpanded: v.view === "active",
      traceCollapsed: v.view !== "active",
      collapsedSummary: plural(total, "step"),
      ...(hidden > 0 ? { progressText: `${plural(hidden, "earlier step")} not shown` }
        : v.view === "active" ? { progressText: `${plural(total, "step")} so far` } : {}),
      phases,
    });
    if (fits(frame, opts)) return frame;
  }
  return undefined;
}

/**
 * Minimal terminal closure (AC-007.5): status and reason only. It carries no
 * activity, count or answer, and has no controls; the single status row's
 * detail is the reason label itself.
 */
export function buildClosureFrame(reason: AutomaticReason, pinned: PinnedTemplate, opts: BuildOptions): RegistryFrame | undefined {
  if (!controlFree(pinned) || !Object.hasOwn(VIEWS, reason) || !isTerminalReason(reason)) return undefined;
  const v = VIEWS[reason];
  const done = reason === "completed";
  const frame = frameOf(pinned, v, {
    reasoningId: opts.reasoningId,
    timerText: formatElapsed(opts.elapsedMs),
    traceExpanded: false,
    traceCollapsed: true,
    collapsedSummary: v.text,
    phases: [{ thought: v.text, actions: [{ tool: "Status", detail: v.text, statusGlyph: done ? "✓" : "!", statusTone: done ? "Good" : "Attention" }] }],
  });
  return fits(frame, opts) ? frame : undefined;
}
