/**
 * Registry frame builder and lifecycle mapping (WP-06 C08a).
 *
 * Pure: `ai.reasoning-process` template-ref frames from the progress model,
 * the PRD §7.4 view/state/reason/text mapping (AC-008.1), the newest 6
 * phases / 12 actions with an omitted indicator, fitting to the envelope cap
 * before transport (AC-007.4), control-free output (AC-018.5) and the
 * provisional OD-5 `timed_out` label without a late-reply promise.
 */

import { describe, expect, it } from "vitest";
import { serializeEditRegistry, serializeSendRegistry } from "../cards/api.js";
import type { CardRoute, ItemState, PinnedTemplate, SafeItemFacts, SafeProgram } from "../cards/contracts.js";
import { EMPTY_PROGRESS, reduceProgress, type ProgressModel } from "../cards/progress-model.js";
import {
  AUTOMATIC_REASONS,
  buildClosureFrame,
  buildProgressFrame,
  formatElapsed,
  lifecycleView,
  type AutomaticReason,
  type BuildOptions,
} from "../cards/registry-builder.js";
import { reduceItem } from "../cards/redact.js";

const PINNED: PinnedTemplate = Object.freeze({
  id: "ai.reasoning-process", version: "0.4.0", controlFree: true,
  views: Object.freeze({
    active: Object.freeze({ view: "active", version: "octo/v2", controlFree: true }),
    error: Object.freeze({ view: "error", version: "octo/v2", controlFree: true }),
    result: Object.freeze({ view: "result", version: "octo/v1", controlFree: true }),
  }),
}) as PinnedTemplate;
const ROUTE: CardRoute = { channelId: "s1_u1@s1_bot", channelType: 1 };
const OPTS: BuildOptions = { reasoningId: "card-0000", elapsedMs: 12_000, route: ROUTE, clientMsgNo: "00000000-0000-4000-8000-000000000000", maxEnvelopeBytes: 16_384 };

function cmd(i: number, over: Partial<ItemState> = {}): ItemState {
  return { kind: "item_state", attempt: 0, itemId: `c${i}`, seq: i, itemType: "command_execution", phase: "completed",
    status: "completed", safe: { category: "command", program: "git" as SafeProgram, exitClass: "ok" }, ...over };
}
const model = (events: readonly ItemState[]): ProgressModel => events.reduce(reduceProgress, EMPTY_PROGRESS);

describe("lifecycle mapping (AC-008.1, PRD §7.4)", () => {
  const expected: Record<AutomaticReason, [string, string, string]> = {
    working: ["active", "reasoning", "Working"],
    answering: ["active", "answering", "Answering"],
    completed: ["result", "completed", "Completed"],
    failed: ["error", "error", "Failed"],
    interrupted: ["error", "error", "Interrupted; needs review"],
    timed_out: ["error", "error", "Timed out"],
    policy_revoked: ["error", "error", "Unavailable by policy"],
  };
  for (const reason of AUTOMATIC_REASONS) {
    it(`${reason} → ${expected[reason].join(" / ")}`, () => {
      const v = lifecycleView(reason);
      expect([v.view, v.state, v.text]).toEqual(expected[reason]);
      expect(v.reason).toBe(reason);
    });
  }

  it("covers exactly the reachable automatic reasons; Stopped, paused and expired are not reachable", () => {
    expect([...AUTOMATIC_REASONS].sort()).toEqual(Object.keys(expected).sort());
    for (const unreachable of ["stopped", "paused", "resuming", "expired"]) {
      expect(AUTOMATIC_REASONS as readonly string[]).not.toContain(unreachable);
    }
  });

  it("timed_out text is provisional (OD-5) and never promises a later reply", () => {
    const text = lifecycleView("timed_out").text;
    expect(text.toLowerCase()).not.toContain("later");
    expect(text.toLowerCase()).not.toContain("may still arrive");
    const frame = buildProgressFrame(model([cmd(0)]), "timed_out", PINNED, OPTS);
    expect(JSON.stringify(frame).toLowerCase()).not.toContain("later reply");
  });
});

describe("buildProgressFrame", () => {
  it("emits an exact template-ref frame whose wire state equals data.state", () => {
    const frame = buildProgressFrame(model([cmd(0)]), "working", PINNED, OPTS);
    expect(frame).toBeDefined();
    expect(frame!.k).toBe("registry");
    expect(frame!.ref).toEqual({ id: "ai.reasoning-process", version: "0.4.0" });
    expect(frame!.state).toBe("reasoning");
    expect(frame!.data.state).toBe("reasoning");
    expect(frame!.data.reasoningId).toBe("card-0000");
    expect(frame!.data.statusLabel).toBe("Working");
    expect(frame!.data.timerText).toBe("12s");
    expect(frame!.data.traceExpanded).toBe(true);
    expect(frame!.data.traceCollapsed).toBe(false);
    expect(frame!.data.phases).toHaveLength(1);
    expect(frame!.data.phases[0]?.actions).toEqual([{ tool: "Command", detail: "git", statusGlyph: "✓", statusTone: "Good" }]);
    expect(Object.isFrozen(frame)).toBe(true);
    // The frame passes the closed wire projection used by the transport.
    expect(() => serializeSendRegistry({ route: ROUTE, clientMsgNo: OPTS.clientMsgNo, ref: frame!.ref, state: frame!.state, data: frame!.data })).not.toThrow();
  });

  it("terminal views: result for completed, error with an error title for errors", () => {
    const m = model([cmd(0)]);
    const done = buildProgressFrame(m, "completed", PINNED, OPTS)!;
    expect(done.state).toBe("completed");
    expect(done.data.traceExpanded).toBe(false);
    expect(done.data.errorTitle).toBeUndefined();
    const failed = buildProgressFrame(m, "failed", PINNED, OPTS)!;
    expect(failed.state).toBe("error");
    expect(failed.data.errorTitle).toBe("Failed");
    expect(failed.data.errorMessage).toBe("Failed");
  });

  it("maps each category to a closed label and safe detail", () => {
    const m = model([
      cmd(0, { status: "in_progress", phase: "started" }),
      { kind: "item_state", attempt: 0, itemId: "f", seq: 1, itemType: "file_change", phase: "completed", status: "failed", safe: { category: "file_change", fileCount: 3 } },
      { kind: "item_state", attempt: 0, itemId: "w", seq: 2, itemType: "web_search", phase: "completed", safe: { category: "web_search", domain: "example.com" } },
      { kind: "item_state", attempt: 0, itemId: "m", seq: 3, itemType: "mcp_tool_call", phase: "started", safe: { category: "tool" } },
    ]);
    const actions = buildProgressFrame(m, "working", PINNED, OPTS)!.data.phases.flatMap((p) => p.actions);
    expect(actions).toEqual([
      { tool: "Command", detail: "git", statusGlyph: "…", statusTone: "Accent" },
      { tool: "File change", detail: "3 files", statusGlyph: "✗", statusTone: "Attention" },
      { tool: "Search", detail: "example.com", statusGlyph: "✓", statusTone: "Good" },
      { tool: "Tool", detail: "Tool call", statusGlyph: "…", statusTone: "Accent" },
    ]);
  });

  it("keeps attempts as separate phases (lineage), newest last", () => {
    const m = model([cmd(0), cmd(1, { attempt: 1, itemId: "c0", seq: 5 })]);
    const phases = buildProgressFrame(m, "working", PINNED, OPTS)!.data.phases;
    expect(phases.map((p) => p.thought)).toEqual(["Attempt 1", "Attempt 2"]);
  });

  it("keeps the newest 12 actions in at most 6 phases with an omitted indicator", () => {
    const m = model(Array.from({ length: 20 }, (_, i) => cmd(i)));
    const data = buildProgressFrame(m, "working", PINNED, OPTS)!.data;
    const actions = data.phases.flatMap((p) => p.actions);
    expect(actions).toHaveLength(12);
    expect(data.progressText).toBe("8 earlier steps not shown");
    expect(data.collapsedSummary).toBe("20 steps");
    const many = model(Array.from({ length: 9 }, (_, i) => cmd(i, { attempt: i, itemId: "c", seq: i })));
    const phases = buildProgressFrame(many, "working", PINNED, OPTS)!.data.phases;
    expect(phases).toHaveLength(6);
    expect(phases.at(-1)?.thought).toBe("Attempt 9");
  });

  it("returns undefined without a displayable row (no empty card is manufactured)", () => {
    expect(buildProgressFrame(EMPTY_PROGRESS, "working", PINNED, OPTS)).toBeUndefined();
    expect(buildProgressFrame(EMPTY_PROGRESS, "completed", PINNED, OPTS)).toBeUndefined();
  });

  it("refuses a template that is not control-free (AC-018.5)", () => {
    const withControls = { ...PINNED, controlFree: false } as unknown as PinnedTemplate;
    expect(buildProgressFrame(model([cmd(0)]), "working", withControls, OPTS)).toBeUndefined();
    expect(buildClosureFrame("interrupted", withControls, OPTS)).toBeUndefined();
  });
});

describe("envelope fitting before transport (AC-007.4)", () => {
  it("drops the oldest actions until both the send and the worst-case edit envelope fit", () => {
    const m = model(Array.from({ length: 12 }, (_, i) => cmd(i)));
    const full = buildProgressFrame(m, "working", PINNED, OPTS)!;
    const fullBytes = serializeSendRegistry({ route: ROUTE, clientMsgNo: OPTS.clientMsgNo, ref: full.ref, state: full.state, data: full.data }).bytes;
    const cap = fullBytes - 40;
    const fitted = buildProgressFrame(m, "working", PINNED, { ...OPTS, maxEnvelopeBytes: cap })!;
    const actions = fitted.data.phases.flatMap((p) => p.actions);
    expect(actions.length).toBeLessThan(12);
    expect(actions.length).toBeGreaterThan(0);
    expect(fitted.data.progressText).toMatch(/earlier steps? not shown$/);
    const edit = serializeEditRegistry({ route: ROUTE, messageId: "9223372036854775807", ref: fitted.ref, state: fitted.state,
      data: fitted.data, seq: Number.MAX_SAFE_INTEGER, transient: true });
    expect(edit.bytes).toBeLessThanOrEqual(cap);
  });

  it("returns undefined when even a single action cannot fit", () => {
    expect(buildProgressFrame(model([cmd(0)]), "working", PINNED, { ...OPTS, maxEnvelopeBytes: 200 })).toBeUndefined();
  });
});

describe("minimal closure frame (AC-007.5)", () => {
  it("carries only the terminal status and reason: no activity, details or counts", () => {
    const frame = buildClosureFrame("interrupted", PINNED, OPTS)!;
    expect(frame.state).toBe("error");
    expect(frame.data.statusLabel).toBe("Interrupted; needs review");
    expect(frame.data.phases).toEqual([{ thought: "Interrupted; needs review", actions: [{ tool: "Status", detail: "Interrupted; needs review", statusGlyph: "!", statusTone: "Attention" }] }]);
    expect(frame.data.progressText).toBeUndefined();
    expect(frame.data.traceExpanded).toBe(false);
    expect(() => serializeEditRegistry({ route: ROUTE, messageId: "1", ref: frame.ref, state: frame.state, data: frame.data, seq: 2, transient: false })).not.toThrow();
  });

  it("is defined for completed and the error reasons only", () => {
    expect(buildClosureFrame("completed", PINNED, OPTS)?.state).toBe("completed");
    expect(buildClosureFrame("working", PINNED, OPTS)).toBeUndefined();
    expect(buildClosureFrame("answering", PINNED, OPTS)).toBeUndefined();
  });
});

describe("formatElapsed", () => {
  it("formats bounded, nonempty timer text", () => {
    expect(formatElapsed(0)).toBe("0s");
    expect(formatElapsed(59_999)).toBe("59s");
    expect(formatElapsed(65_000)).toBe("1m 05s");
    expect(formatElapsed(3_725_000)).toBe("1h 02m");
    expect(formatElapsed(-5)).toBe("0s");
    expect(formatElapsed(Number.NaN)).toBe("0s");
  });
});

describe("privacy corpus through the builder (AC-019.2 input)", () => {
  it("no protected sentinel from raw SDK items reaches a frame", () => {
    const raws = [
      { id: "1", type: "command_execution", command: "curl -H 'Authorization: Bearer SENTINEL_BEARER' https://SENTINEL.internal/x", status: "completed", exit_code: 1 },
      { id: "2", type: "file_change", changes: [{ path: "SENTINEL_DIR/secret.env", kind: "update" }], status: "completed" },
      { id: "3", type: "web_search", query: "SENTINEL_SEARCH", url: "https://user:SENTINEL_PW@docs.example.org/p?q=SENTINEL_Q" },
      { id: "4", type: "mcp_tool_call", server: "SENTINEL_SERVER", tool: "SENTINEL_TOOL", arguments: { k: "SENTINEL_ARG" }, status: "completed" },
    ];
    const m = model(raws.map((r, i): ItemState => ({ kind: "item_state", attempt: 0, itemId: r.id, seq: i, phase: "completed",
      itemType: r.type as ItemState["itemType"], safe: reduceItem(r) as SafeItemFacts })));
    for (const reason of AUTOMATIC_REASONS) {
      const text = JSON.stringify(buildProgressFrame(m, reason, PINNED, OPTS) ?? null);
      expect(text).not.toMatch(/SENTINEL/);
    }
  });
});
