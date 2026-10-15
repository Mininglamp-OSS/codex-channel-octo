/**
 * Contract leaf shape. Type assertions here are enforced by a type-inclusive
 * compile of the test files; the runtime assertions guard the type-only leaf.
 */
import { describe, expect, expectTypeOf, it } from "vitest";
import * as contracts from "../cards/contracts.js";
import type {
  AuthoredCard,
  CardResourceOwner,
  CardResourceRegistry,
  CardToolResult,
  CardWrite,
  DeliveryReport,
  DisplayAdaptiveCard,
  RegistryData,
  ResourceDrainReport,
  ShutdownFence,
  TrustedTurnContext,
  TurnSignal,
  WireState,
} from "../cards/contracts.js";

describe("contracts leaf", () => {
  it("has no runtime exports", () => {
    expect(Object.keys(contracts)).toEqual([]);
  });

  it("keeps the normative §3.1 CardWrite fields with closed bodies", () => {
    expectTypeOf<Extract<CardWrite, { k: "registry_send" }>>().toHaveProperty("ref");
    expectTypeOf<Extract<CardWrite, { k: "registry_send" }>["state"]>().toEqualTypeOf<WireState>();
    expectTypeOf<Extract<CardWrite, { k: "registry_edit" }>["data"]>().toEqualTypeOf<RegistryData>();
    expectTypeOf<Extract<CardWrite, { k: "authored_send" }>>().toHaveProperty("plain");
    expectTypeOf<Extract<CardWrite, { k: "authored_edit" }>["contentEdit"]>().toMatchTypeOf<{
      profile: "octo/v1" | "octo/v2"; plain: string; card_seq: number; transient: boolean;
    }>();

    const display: DisplayAdaptiveCard = {
      type: "AdaptiveCard", version: "1.5", $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
      body: [{ type: "TextBlock", text: "x", wrap: true }],
    };
    const ok: AuthoredCard = { profile: "octo/v1", card: display };
    expect(ok.profile).toBe("octo/v1");

    // @ts-expect-error a display profile cannot carry an input element
    const withInput: DisplayAdaptiveCard = { ...display, body: [{ type: "Input.Text", id: "a" }] };
    // @ts-expect-error arbitrary objects are not card bodies
    const open: AuthoredCard = { profile: "octo/v1", card: { anything: true } };
    // @ts-expect-error Registry wire state is the template state, not the view name
    const view: WireState = "active";
    expect([withInput, open, view]).toHaveLength(3);
  });

  it("models closed result, signal and trusted context shapes", () => {
    expectTypeOf<Extract<CardToolResult, { status: "error" }>["error"]["code"]>()
      .toEqualTypeOf<"policy_denied" | "unavailable" | "invalid_route" | "validation_failed" | "limit_exceeded" | "capacity_full" | "send_unconfirmed">();
    expectTypeOf<Extract<TurnSignal, { t: "delivery_report" }>["report"]>().toEqualTypeOf<DeliveryReport>();
    expectTypeOf<TrustedTurnContext["origin"]>().toEqualTypeOf<Readonly<{ kind: "user" } | { kind: "card_continuation"; admissionId: string }>>();
    expectTypeOf<TrustedTurnContext>().not.toHaveProperty("botToken");
  });

  it("exposes a type-only resource-owner shutdown port", async () => {
    const closed: string[] = [];
    const owner: CardResourceOwner = {
      kind: "write_queue",
      close(fence) { closed.push(fence.reason); },
      async drain(fence): Promise<ResourceDrainReport> {
        return { settled: fence.signal.aborted ? 0 : 1, aborted: 0, unresolved: 0 };
      },
    };
    const registered: CardResourceOwner[] = [];
    let closing = false;
    const registry: CardResourceRegistry = {
      register(o) {
        if (closing) return null;
        registered.push(o);
        return { unregister: () => { registered.splice(registered.indexOf(o), 1); } };
      },
    };
    const registration = registry.register(owner);
    expect(registration).not.toBeNull();
    closing = true;
    expect(registry.register(owner)).toBeNull();

    const fence: ShutdownFence = { reason: "shutdown", deadlineMono: 3_000, signal: new AbortController().signal };
    owner.close(fence);
    expect(await owner.drain(fence)).toEqual({ settled: 1, aborted: 0, unresolved: 0 });
    expect(closed).toEqual(["shutdown"]);
    registration?.unregister();
    expect(registered).toHaveLength(0);

    // @ts-expect-error resource classes are closed
    const unknownKind: CardResourceOwner["kind"] = "socket";
    expect(unknownKind).toBe("socket");
  });
});
