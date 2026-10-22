/**
 * Automatic progress model (WP-06 C08a, TD v3 §3.2 / PRD §7.4).
 *
 * Pure reduction of bridge `item_state` events into stable `(attempt, itemId)`
 * rows: one row per item, completion-only items produce one completed row,
 * reasoning/todo only raise an activity flag, attempts are never merged and
 * injected-tool items are excluded (AC-005.1/.2).
 */

import { describe, expect, it } from "vitest";
import type { ItemState, SafeItemFacts, SafeProgram } from "../cards/contracts.js";
import {
  EMPTY_PROGRESS,
  MAX_RETAINED_ROWS,
  hasDisplayableRow,
  isDisplayableItem,
  reduceProgress,
  type ProgressModel,
} from "../cards/progress-model.js";
import { reduceItem } from "../cards/redact.js";

const command = (program?: string, exitClass?: SafeItemFacts["exitClass"]): SafeItemFacts =>
  ({ category: "command", ...(program ? { program: program as SafeProgram } : {}), ...(exitClass ? { exitClass } : {}) });

function item(over: Partial<ItemState> & Pick<ItemState, "itemId" | "seq">): ItemState {
  return {
    kind: "item_state", attempt: 0, itemType: "command_execution", phase: "started",
    safe: command("git"), ...over,
  };
}

function run(events: readonly ItemState[], start: ProgressModel = EMPTY_PROGRESS): ProgressModel {
  return events.reduce(reduceProgress, start);
}

describe("reduceProgress rows (AC-005.1)", () => {
  it("started → updated → completed updates one row in place, never duplicating it", () => {
    const m = run([
      item({ itemId: "a", seq: 0, phase: "started", status: "in_progress" }),
      item({ itemId: "a", seq: 0, phase: "updated", status: "in_progress" }),
      item({ itemId: "a", seq: 0, phase: "completed", status: "completed", safe: command("git", "ok") }),
    ]);
    expect(m.rows).toHaveLength(1);
    expect(m.rows[0]).toMatchObject({ attempt: 0, itemId: "a", itemType: "command_execution", status: "completed" });
    expect(m.rows[0]?.safe).toEqual(command("git", "ok"));
  });

  it("a completion-only item produces exactly one completed row", () => {
    const m = run([item({ itemId: "solo", seq: 3, phase: "completed", status: "completed" })]);
    expect(m.rows).toHaveLength(1);
    expect(m.rows[0]?.status).toBe("completed");
  });

  it("failed status is kept and a terminal row never regresses on a late update", () => {
    const m = run([
      item({ itemId: "f", seq: 1, phase: "completed", status: "failed" }),
      item({ itemId: "f", seq: 1, phase: "updated", status: "in_progress" }),
    ]);
    expect(m.rows[0]?.status).toBe("failed");
  });

  it("rows keep first-sight order across item types", () => {
    const m = run([
      item({ itemId: "c", seq: 0 }),
      item({ itemId: "w", seq: 1, itemType: "web_search", safe: { category: "web_search", domain: "example.com" } }),
      item({ itemId: "e", seq: 2, itemType: "file_change", safe: { category: "file_change", fileCount: 2 } }),
      item({ itemId: "m", seq: 3, itemType: "mcp_tool_call", safe: { category: "tool" } }),
      item({ itemId: "c", seq: 0, phase: "completed", status: "completed" }),
    ]);
    expect(m.rows.map((r) => r.itemId)).toEqual(["c", "w", "e", "m"]);
  });

  it("the same item id in a different attempt is a distinct row (no cross-attempt merge)", () => {
    const m = run([
      item({ attempt: 0, itemId: "x", seq: 0, phase: "completed", status: "failed" }),
      item({ attempt: 1, itemId: "x", seq: 4, phase: "started" }),
    ]);
    expect(m.rows.map((r) => [r.attempt, r.itemId, r.status])).toEqual([[0, "x", "failed"], [1, "x", "in_progress"]]);
  });

  it("is pure: the input model is never mutated and outputs are frozen", () => {
    const first = run([item({ itemId: "a", seq: 0 })]);
    const before = JSON.stringify(first);
    const next = reduceProgress(first, item({ itemId: "b", seq: 1 }));
    expect(JSON.stringify(first)).toBe(before);
    expect(next).not.toBe(first);
    expect(Object.isFrozen(next)).toBe(true);
    expect(Object.isFrozen(next.rows)).toBe(true);
    expect(Object.isFrozen(next.rows[0])).toBe(true);
  });
});

describe("activity-only items (AC-005.2)", () => {
  it("reasoning and todo items set activity only and are never rows", () => {
    const m = run([
      item({ itemId: "r", seq: -1, itemType: "reasoning", safe: { category: "activity" } }),
      item({ itemId: "t", seq: -1, itemType: "todo_list", safe: { category: "activity" } }),
    ]);
    expect(m.rows).toEqual([]);
    expect(m.activity).toBe(true);
    expect(hasDisplayableRow(m)).toBe(false);
  });

  it("an empty model has no displayable row", () => {
    expect(hasDisplayableRow(EMPTY_PROGRESS)).toBe(false);
    expect(EMPTY_PROGRESS.activity).toBe(false);
  });

  it("injected-tool items (trusted server identity) are excluded from automatic rows", () => {
    const injected = item({ itemId: "card-tool", seq: 0, itemType: "mcp_tool_call", safe: { category: "tool", mcpServerId: "octo-cards" } });
    expect(isDisplayableItem(injected)).toBe(false);
    const m = run([injected]);
    expect(m.rows).toEqual([]);
    expect(hasDisplayableRow(m)).toBe(false);
  });

  it("only command/file/MCP/search items are displayable", () => {
    for (const itemType of ["command_execution", "file_change", "mcp_tool_call", "web_search"] as const) {
      expect(isDisplayableItem(item({ itemId: "i", seq: 0, itemType }))).toBe(true);
    }
    for (const itemType of ["reasoning", "todo_list"] as const) {
      expect(isDisplayableItem(item({ itemId: "i", seq: 0, itemType, safe: { category: "activity" } }))).toBe(false);
    }
  });
});

describe("malformed input is ignored", () => {
  const bad: unknown[] = [
    null,
    { kind: "work", attempt: 0, itemId: "a", seq: 0, itemType: "command_execution" },
    { ...item({ itemId: "a", seq: 0 }), attempt: -1 },
    { ...item({ itemId: "a", seq: 0 }), attempt: 1.5 },
    { ...item({ itemId: "", seq: 0 }) },
    { ...item({ itemId: "a", seq: 0 }), seq: Number.NaN },
    { ...item({ itemId: "a", seq: 0 }), itemType: "agent_message" },
    { ...item({ itemId: "a", seq: 0 }), phase: "deleted" },
    { ...item({ itemId: "a", seq: 0 }), status: "weird" },
    { ...item({ itemId: "a", seq: 0 }), safe: null },
    { ...item({ itemId: "a", seq: 0 }), safe: { category: "secret" } },
  ];
  for (const [i, ev] of bad.entries()) {
    it(`case ${i} leaves the model unchanged`, () => {
      expect(reduceProgress(EMPTY_PROGRESS, ev as ItemState)).toBe(EMPTY_PROGRESS);
    });
  }
});

describe("retention bound", () => {
  it(`keeps at most ${MAX_RETAINED_ROWS} rows and counts the evicted ones as omitted`, () => {
    const events = Array.from({ length: MAX_RETAINED_ROWS + 5 }, (_, i) => item({ itemId: `i${i}`, seq: i }));
    const m = run(events);
    expect(m.rows).toHaveLength(MAX_RETAINED_ROWS);
    expect(m.omitted).toBe(5);
    expect(m.rows[0]?.itemId).toBe("i5");
    // An update for an evicted row creates nothing and is not double counted.
    const later = reduceProgress(m, item({ itemId: "i0", seq: 0, phase: "completed", status: "completed" }));
    expect(later.rows).toHaveLength(MAX_RETAINED_ROWS);
    expect(later.omitted).toBe(5);
  });
});

describe("privacy: rows carry reducer facts only (AC-006.1 / AC-019.2 input)", () => {
  it("raw command, path and query text from SDK items never reaches a row", () => {
    const raw = [
      { id: "c", type: "command_execution", command: "SECRET_TOKEN=abc123 git push https://user:pw@host/x", status: "completed", exit_code: 0, aggregated_output: "SENTINEL_OUTPUT" },
      { id: "f", type: "file_change", changes: [{ path: "/home/u/SENTINEL_PATH.txt", kind: "add" }], status: "completed" },
      { id: "w", type: "web_search", query: "SENTINEL_QUERY", url: "https://a.b.example.com/SENTINEL?q=1" },
    ];
    const events: ItemState[] = raw.map((r, i) => ({
      kind: "item_state", attempt: 0, itemId: r.id, seq: i, phase: "completed", status: "completed",
      itemType: r.type as ItemState["itemType"], safe: reduceItem(r),
    }));
    const text = JSON.stringify(run(events));
    for (const sentinel of ["SECRET_TOKEN", "abc123", "user:pw", "SENTINEL_OUTPUT", "SENTINEL_PATH", "SENTINEL_QUERY", "SENTINEL?q"]) {
      expect(text).not.toContain(sentinel);
    }
  });
});
