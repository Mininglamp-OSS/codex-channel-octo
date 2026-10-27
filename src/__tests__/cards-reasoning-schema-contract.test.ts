/**
 * Automatic frames against the server's `ai.reasoning-process@0.4.1` data
 * contract (XIN-2423).
 *
 * The live AP1 card send was rejected with HTTP 400: the first `reasoning`
 * frame had no `progressText`, closures carried an empty action `detail`, and
 * the `interrupted` status label was 33 characters. These cases run the real
 * live profile → template pin → builder → wire projection → type-17 send and
 * edit envelopes, and validate every emitted `data` against the pinned server
 * schema. Negative controls stay rejected both by the schema and locally.
 */
import { describe, expect, it } from "vitest";
import { CARD_MESSAGE_TYPE, CardRequestError, projectCardProfile, serializeEditRegistry, serializeSendRegistry } from "../cards/api.js";
import type { CardRoute, ItemState, PinnedTemplate, RegistryData, SafeItemFacts, SafeProgram } from "../cards/contracts.js";
import { parseProfile } from "../cards/profile-parse.js";
import { EMPTY_PROGRESS, MAX_RETAINED_ROWS, reduceProgress, type ProgressModel } from "../cards/progress-model.js";
import {
  AUTOMATIC_REASONS, MAX_ACTIONS, buildClosureFrame, buildProgressFrame, isTerminalReason, lifecycleView,
  type BuildOptions, type RegistryFrame,
} from "../cards/registry-builder.js";
import { liveProfileJson } from "./fixtures/card-profile-live.js";
import { reasoningSchemaErrors } from "./fixtures/reasoning-schema.js";

const ROUTE: CardRoute = { channelId: "s1_u1@s1_bot", channelType: 1 };
const OPTS: BuildOptions = { reasoningId: "card-0000", elapsedMs: 3_700, route: ROUTE,
  clientMsgNo: "00000000-0000-4000-8000-000000000000", maxEnvelopeBytes: 16_384 };

/** The template the live profile pins: `ai.reasoning-process@0.4.1`. */
const PINNED = (() => {
  const t = parseProfile(projectCardProfile(liveProfileJson() as never)).automatic.template;
  if (t === undefined) throw new Error("live profile pins no automatic template");
  return t as PinnedTemplate;
})();

type Kind = ItemState["itemType"];
let seq = 0;
function item(itemType: Kind, safe: SafeItemFacts, status: ItemState["status"] = "completed", attempt = 0): ItemState {
  const n = seq++;
  return { kind: "item_state", attempt, itemId: `i${n}`, seq: n, itemType,
    phase: status === "in_progress" ? "started" : "completed", ...(status ? { status } : {}), safe };
}
const cmd = (status?: ItemState["status"], attempt = 0) =>
  item("command_execution", { category: "command", program: "pwd" as SafeProgram, exitClass: "ok" }, status, attempt);
const model = (events: readonly ItemState[]): ProgressModel => events.reduce(reduceProgress, EMPTY_PROGRESS);
const rows = (n: number, attempt = 0) => Array.from({ length: n }, () => cmd("completed", attempt));

const ROW_CASES: readonly [string, () => ProgressModel][] = [
  ["one in-progress command (the AP1 first frame)", () => model([cmd("in_progress")])],
  ["one completed command", () => model([cmd("completed")])],
  ["one failed command", () => model([cmd("failed")])],
  ["command without a program", () => model([item("command_execution", { category: "command" })])],
  ["file change with a count", () => model([item("file_change", { category: "file_change", fileCount: 3 })])],
  ["file change without a count", () => model([item("file_change", { category: "file_change" })])],
  ["web search with a domain", () => model([item("web_search", { category: "web_search", domain: "example.com" })])],
  ["web search without a domain", () => model([item("web_search", { category: "web_search" })])],
  ["MCP tool call", () => model([item("mcp_tool_call", { category: "tool" })])],
  ["every action kind, mixed states", () => model([
    cmd("completed"), item("file_change", { category: "file_change" }, "failed"),
    item("web_search", { category: "web_search" }, "in_progress"), item("mcp_tool_call", { category: "tool" }, "in_progress"),
  ])],
  [`exactly ${MAX_ACTIONS} rows (no hidden step)`, () => model(rows(MAX_ACTIONS))],
  [`${MAX_ACTIONS + 1} rows (one hidden step)`, () => model(rows(MAX_ACTIONS + 1))],
  ["retention overflow (omitted rows)", () => model(rows(MAX_RETAINED_ROWS + 5))],
  ["seven attempts (phase limit)", () => model(Array.from({ length: 7 }, (_, a) => cmd("completed", a)))],
];

function wire(frame: RegistryFrame) {
  const send = JSON.parse(serializeSendRegistry({ route: ROUTE, clientMsgNo: OPTS.clientMsgNo, ref: frame.ref, state: frame.state,
    data: frame.data, maxEnvelopeBytes: OPTS.maxEnvelopeBytes }).body) as
    { payload: { type: number; template_ref: unknown; state: string; data: RegistryData } };
  const edit = JSON.parse(serializeEditRegistry({ route: ROUTE, messageId: "9223372036854775807", ref: frame.ref, state: frame.state,
    data: frame.data, seq: 1, transient: frame.state === "reasoning" || frame.state === "answering", maxEnvelopeBytes: OPTS.maxEnvelopeBytes }).body) as
    { template_ref: unknown; state: string; data: RegistryData };
  return { send, edit };
}

/** Every wire body of a frame is a type-17 template-ref envelope whose data the server schema accepts. */
function expectServerValid(frame: RegistryFrame | undefined): RegistryFrame {
  expect(frame).toBeDefined();
  const f = frame!;
  expect(reasoningSchemaErrors(f.data)).toEqual([]);
  const { send, edit } = wire(f);
  expect(send.payload.type).toBe(CARD_MESSAGE_TYPE);
  expect(send.payload.template_ref).toEqual({ id: "ai.reasoning-process", version: "0.4.1" });
  expect(send.payload.state).toBe(f.state);
  expect(send.payload.data).toEqual(f.data);
  expect(reasoningSchemaErrors(send.payload.data)).toEqual([]);
  expect(edit.template_ref).toEqual(send.payload.template_ref);
  expect(edit.data).toEqual(f.data);
  expect(reasoningSchemaErrors(edit.data)).toEqual([]);
  return f;
}

describe("automatic frames satisfy the server ai.reasoning-process@0.4.1 data schema", () => {
  it("pins 0.4.1 from the sanitized live profile", () => {
    expect([PINNED.id, PINNED.version]).toEqual(["ai.reasoning-process", "0.4.1"]);
  });

  for (const reason of AUTOMATIC_REASONS) {
    describe(`progress frame, reason ${reason}`, () => {
      it.each(ROW_CASES)("%s", (_name, build) => {
        expectServerValid(buildProgressFrame(build(), reason, PINNED, OPTS));
      });
    });
  }

  it.each(AUTOMATIC_REASONS.filter(isTerminalReason))("minimal closure, reason %s (lifecycle and restart recovery)", (reason) => {
    const frame = expectServerValid(buildClosureFrame(reason, PINNED, OPTS));
    // AC-007.5: the closure states the reason only, with no activity or count.
    expect(frame.data.phases).toEqual([{ thought: lifecycleView(reason).text,
      actions: [expect.objectContaining({ tool: "Status", detail: lifecycleView(reason).text })] }]);
  });

  it("frames fitted to a tight envelope cap stay schema-valid", () => {
    const m = model(rows(MAX_ACTIONS));
    const full = buildProgressFrame(m, "working", PINNED, OPTS)!;
    const { bytes } = serializeEditRegistry({ route: ROUTE, messageId: "9223372036854775807", ref: full.ref, state: full.state,
      data: full.data, seq: Number.MAX_SAFE_INTEGER, transient: true });
    const fitted = expectServerValid(buildProgressFrame(m, "working", PINNED, { ...OPTS, maxEnvelopeBytes: bytes - 150 }));
    expect(fitted.data.phases.flatMap((p) => p.actions).length).toBeLessThan(MAX_ACTIONS);
    expect(fitted.data.progressText).toMatch(/^\d+ earlier steps? not shown$/);
  });

  it("long elapsed times stay within timerText bounds", () => {
    for (const elapsedMs of [0, -1, Number.NaN, 59_999, 3_600_000, Number.MAX_SAFE_INTEGER]) {
      expectServerValid(buildProgressFrame(model([cmd()]), "working", PINNED, { ...OPTS, elapsedMs }));
      expectServerValid(buildClosureFrame("interrupted", PINNED, { ...OPTS, elapsedMs }));
    }
  });
});

describe("active progressText is a bounded count summary", () => {
  it.each([
    ["one row", 1, "1 step so far"],
    [`exactly ${MAX_ACTIONS} rows`, MAX_ACTIONS, `${MAX_ACTIONS} steps so far`],
    [`${MAX_ACTIONS + 1} rows`, MAX_ACTIONS + 1, "1 earlier step not shown"],
    [`${MAX_ACTIONS + 8} rows`, MAX_ACTIONS + 8, "8 earlier steps not shown"],
  ])("%s", (_name, n, text) => {
    for (const reason of ["working", "answering"] as const) {
      expect(buildProgressFrame(model(rows(n)), reason, PINNED, OPTS)!.data.progressText).toBe(text);
    }
  });

  it("terminal progress frames keep progressText only for hidden steps", () => {
    expect(buildProgressFrame(model(rows(1)), "completed", PINNED, OPTS)!.data.progressText).toBeUndefined();
    expect(buildProgressFrame(model(rows(MAX_ACTIONS + 2)), "failed", PINNED, OPTS)!.data.progressText).toBe("2 earlier steps not shown");
  });

  it("the lazy first frame is unchanged: no displayable row, no frame", () => {
    for (const reason of AUTOMATIC_REASONS) expect(buildProgressFrame(EMPTY_PROGRESS, reason, PINNED, OPTS)).toBeUndefined();
  });
});

describe("action detail is never empty and leaks no raw facts", () => {
  it.each([
    ["command without a program", item("command_execution", { category: "command" }), "Command", "Shell command"],
    ["file change without a count", item("file_change", { category: "file_change" }), "File change", "File edit"],
    ["web search without a domain", item("web_search", { category: "web_search" }), "Search", "Web search"],
    ["MCP tool call", item("mcp_tool_call", { category: "tool" }), "Tool", "Tool call"],
    ["command with a program", cmd(), "Command", "pwd"],
    ["file change with a count", item("file_change", { category: "file_change", fileCount: 2 }), "File change", "2 files"],
    ["web search with a domain", item("web_search", { category: "web_search", domain: "example.com" }), "Search", "example.com"],
  ])("%s", (_name, ev, tool, detail) => {
    const action = buildProgressFrame(model([ev]), "working", PINNED, OPTS)!.data.phases[0]!.actions[0]!;
    expect([action.tool, action.detail]).toEqual([tool, detail]);
  });
});

describe("status labels fit the server contract for every reason", () => {
  it.each(AUTOMATIC_REASONS)("%s", (reason) => {
    const { text } = lifecycleView(reason);
    expect(text.trim()).not.toBe("");
    expect([...text].length).toBeLessThanOrEqual(32);
  });

  it("interrupted uses the canonical short label", () => {
    expect(lifecycleView("interrupted").text).toBe("Interrupted; needs review");
  });
});

describe("negative controls stay rejected by the server schema and by the local projection", () => {
  const valid = (): RegistryData => buildProgressFrame(model([cmd()]), "working", PINNED, OPTS)!.data;
  const errorData = (): RegistryData => buildClosureFrame("failed", PINNED, OPTS)!.data;
  const withAction = (d: RegistryData, over: Record<string, unknown>): RegistryData =>
    ({ ...d, phases: [{ ...d.phases[0]!, actions: [{ ...d.phases[0]!.actions[0]!, ...over }] }] }) as RegistryData;
  const without = (d: RegistryData, key: keyof RegistryData): RegistryData => {
    const copy: Record<string, unknown> = { ...d };
    delete copy[key];
    return copy as unknown as RegistryData;
  };
  const action = valid().phases[0]!.actions[0]!;

  const cases: readonly [string, () => RegistryData][] = [
    ["empty action detail", () => withAction(valid(), { detail: "" })],
    ["missing progressText while reasoning", () => without(valid(), "progressText")],
    ["missing progressText while answering", () => without({ ...valid(), state: "answering" }, "progressText")],
    ["empty progressText", () => ({ ...valid(), progressText: "" })],
    ["progressText over 160", () => ({ ...valid(), progressText: "x".repeat(161) })],
    ["statusLabel over 32", () => ({ ...valid(), statusLabel: "Interrupted; outcome needs review" })],
    ["title over 64", () => ({ ...valid(), title: "x".repeat(65) })],
    ["collapsedSummary over 160", () => ({ ...valid(), collapsedSummary: "x".repeat(161) })],
    ["tool over 81", () => withAction(valid(), { tool: "x".repeat(82) })],
    ["detail over 192", () => withAction(valid(), { detail: "x".repeat(193) })],
    ["statusGlyph over 2", () => withAction(valid(), { statusGlyph: "✓✓✓" })],
    ["action tone Warning", () => withAction(valid(), { statusTone: "Warning" })],
    ["unknown status tone", () => ({ ...valid(), statusTone: "Info" as never })],
    ["unknown state", () => ({ ...valid(), state: "paused" as never })],
    ["both trace flags true", () => ({ ...valid(), traceExpanded: true, traceCollapsed: true })],
    ["both trace flags false", () => ({ ...valid(), traceExpanded: false, traceCollapsed: false })],
    ["error without errorTitle", () => without(errorData(), "errorTitle")],
    ["error without errorMessage", () => without(errorData(), "errorMessage")],
    ["errorTitle over 64", () => ({ ...errorData(), errorTitle: "x".repeat(65) })],
    ["no phases", () => ({ ...valid(), phases: [] })],
    ["phase without actions", () => ({ ...valid(), phases: [{ thought: "Steps", actions: [] }] })],
    ["seven phases", () => ({ ...valid(), phases: Array.from({ length: 7 }, () => ({ thought: "Steps", actions: [action] })) })],
    ["thirteen actions in a phase", () => ({ ...valid(), phases: [{ thought: "Steps", actions: Array.from({ length: 13 }, () => action) }] })],
  ];

  it.each(cases)("%s", (_name, build) => {
    const data = build();
    expect(reasoningSchemaErrors(data)).not.toEqual([]);
    expect(() => serializeSendRegistry({ route: ROUTE, clientMsgNo: OPTS.clientMsgNo, ref: { id: PINNED.id, version: PINNED.version },
      state: data.state, data, maxEnvelopeBytes: OPTS.maxEnvelopeBytes })).toThrow(CardRequestError);
  });

  it("unknown data keys are rejected by the schema and dropped by the closed projection", () => {
    const data = { ...valid(), extra: "x" } as RegistryData;
    expect(reasoningSchemaErrors(data)).not.toEqual([]);
    const sent = JSON.parse(serializeSendRegistry({ route: ROUTE, clientMsgNo: OPTS.clientMsgNo, ref: { id: PINNED.id, version: PINNED.version },
      state: data.state, data, maxEnvelopeBytes: OPTS.maxEnvelopeBytes }).body) as { payload: { data: RegistryData } };
    expect(sent.payload.data).not.toHaveProperty("extra");
    expect(reasoningSchemaErrors(sent.payload.data)).toEqual([]);
  });
});
