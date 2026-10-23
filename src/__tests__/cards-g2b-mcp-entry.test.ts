/**
 * E9′ regression guard G2b: the exact injected `mcpEntry` (WP09-PF v3 §3,
 * N/A condition (iv)).
 *
 * Evidence label: [UNIT]. The merged entry carries exactly
 * `{command, args, required, startup_timeout_sec, startup_readiness,
 * enabled_tools, tools}`, with no `auth`, OAuth, `env`, `env_vars`,
 * `bearer_token_env_var` or `url` field, and every offered tool is
 * `approval_mode: "approve"`, so Codex never asks to persist a tool approval
 * (`mcp_tool_call.rs:2303`). A new key or mode fails here first.
 */

import { afterEach, describe, expect, it } from "vitest";
import { randomBytes, randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolOpcode, TrustedTurnContext } from "../cards/contracts.js";
import { provisionFirstInstallMarker } from "../cards/migrations.js";
import { cardSubsystemPaths, openCardSubsystem } from "../cards/recovery.js";
import { EXPLICIT_OP_UNAVAILABLE, createToolHost, type ExplicitOpHandler } from "../cards/tool-host.js";
import { createAdapter } from "../db-adapter.js";
import { SessionStore } from "../session-store.js";
import { manualTime } from "./fixtures/card-write-harness.js";
import { admissibleGateway } from "./fixtures/gd-admit.js";

const roots: string[] = [];
const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const c of cleanups.splice(0).reverse()) { try { c(); } catch { /* best effort */ } }
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

const unavailable = (op: ToolOpcode): ExplicitOpHandler => ({ op, async handle() { return EXPLICIT_OP_UNAVAILABLE; } });

async function entryFor(ops: readonly ToolOpcode[]): Promise<Readonly<Record<string, unknown>>> {
  const dataDir = join(mkdtempSync(join(tmpdir(), "g2b-")), "data");
  roots.push(join(dataDir, ".."));
  mkdirSync(dataDir);
  const p = cardSubsystemPaths(dataDir);
  mkdirSync(p.cardsDir, { recursive: true, mode: 0o700 });
  writeFileSync(p.installationRefPath, "install-a\n", { mode: 0o600, flag: "wx" });
  chmodSync(p.installationRefPath, 0o600);
  provisionFirstInstallMarker(p.markerPath, "install-a", Date.UTC(2026, 9, 22));
  const adapter = createAdapter(join(dataDir, "cc-octo.db"));
  new SessionStore(adapter).init();
  const time = manualTime();
  const incarnation = randomUUID();
  const sub = await openCardSubsystem({ adapter, dataDir, clock: time.wall, runtimeIncarnation: incarnation });
  if (sub.state !== "ready") throw new Error(sub.state);
  const host = createToolHost({ store: sub.store, installationRef: sub.meta.installationRef, cardsDir: p.cardsDir,
    ops: new Map([["display", unavailable("display")], ["interactive", unavailable("interactive")]]), excludedRoots: [],
    clock: time.clock, wall: time.wall, timers: time.timers,
    entry: { nodePath: process.execPath, serverPath: new URL(import.meta.url).pathname } })!;
  cleanups.push(() => { host.close({ reason: "shutdown", deadlineMono: time.now(), signal: AbortSignal.abort() }); sub.store.retire(); adapter.close(); });
  const gateway = admissibleGateway();
  cleanups.push(gateway.release);
  const ctx: TrustedTurnContext = Object.freeze({
    botRef: { originKey: "https://test.invalid", credentialRef: "c".repeat(43) }, route: { channelId: "chan", channelType: 1 },
    requesterUid: "u1", sessionKey: "s1", turnGeneration: randomUUID(), resetEpoch: 0, policyIdentity: "c".repeat(43),
    runtimeIncarnation: incarnation, injectedServerId: `octo_cards_${randomBytes(16).toString("hex")}`,
    routeEligibility: { kind: "dm" as const, obo: false, docTask: false, cron: false }, origin: { kind: "user" as const },
  });
  const gen = host.openGeneration({ ctx, binding: { sessionKey: "s1", channelId: "chan", channelType: 1, topicScope: null,
    generation: ctx.turnGeneration, resetEpoch: 0 }, expiresAtMono: time.now() + 600_000, currentResetEpoch: () => 0, ops, admit: gateway.admit })!;
  const h = (await gen.launch.prepareAttempt())!;
  expect(h).toBeDefined();
  return h.mcpEntry;
}

describe("G2b: exact injected mcpEntry", () => {
  for (const ops of [["display"], ["interactive"], ["display", "interactive"]] as const) {
    it(`offers [${ops.join(", ")}] with exactly the reviewed keys and approve mode on every tool`, async () => {
      const entry = await entryFor(ops);
      expect(Object.keys(entry).sort()).toEqual(["args", "command", "enabled_tools", "required", "startup_readiness", "startup_timeout_sec", "tools"]);
      for (const forbidden of ["auth", "oauth", "oauth_config", "env", "env_vars", "bearer_token_env_var", "url", "http_headers", "env_http_headers"]) {
        expect(Object.hasOwn(entry, forbidden)).toBe(false);
      }
      expect(entry.command).toBe(process.execPath);
      expect(entry).toMatchObject({ required: true, startup_timeout_sec: 10, startup_readiness: "connection" });
      expect(entry.enabled_tools).toEqual([...ops]);
      const tools = entry.tools as Record<string, Record<string, unknown>>;
      expect(Object.keys(tools).sort()).toEqual([...ops].sort());
      for (const op of ops) expect(tools[op]).toEqual({ approval_mode: "approve" });
      const args = entry.args as string[];
      expect(args).toHaveLength(5);
      expect([args[1], args[3]]).toEqual(["--bootstrap", "--port"]);
      expect(Object.isFrozen(entry)).toBe(true);
    });
  }
});
