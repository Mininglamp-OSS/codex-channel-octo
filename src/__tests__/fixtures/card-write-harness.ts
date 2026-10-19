/**
 * Test-only controlled clock, timer port and scripted card transport for the
 * WP-03 pacer/write-queue suites. Never imported by production code.
 */

import type { TimerPort } from "../../cards/pacer.js";

interface ManualTimer {
  readonly id: number;
  readonly at: number;
  readonly callback: () => void;
}

/** Drain pending promise continuations, including chains through setImmediate. */
export async function flush(rounds = 20): Promise<void> {
  for (let i = 0; i < rounds; i++) await new Promise<void>((resolve) => setImmediate(resolve));
}

export interface ManualTime {
  readonly clock: { nowMono(): number };
  readonly wall: { nowUtcMs(): number };
  readonly timers: TimerPort;
  now(): number;
  /** Total timers ever scheduled (spin detector). */
  scheduled(): number;
  pending(): number;
  /** Advance to `now + ms`, firing due timers in order and flushing continuations after each. */
  advance(ms: number): Promise<void>;
  advanceTo(at: number): Promise<void>;
}

export function manualTime(start = 1_000, wallStart = Date.UTC(2026, 9, 19, 6, 0, 0)): ManualTime {
  let now = start;
  let nextId = 1;
  let scheduled = 0;
  const queue: ManualTimer[] = [];
  const timers: TimerPort = {
    setTimeout(callback, delayMs) {
      const timer = { id: nextId++, at: now + Math.max(0, delayMs), callback };
      scheduled++;
      queue.push(timer);
      return timer.id;
    },
    clearTimeout(handle) {
      const i = queue.findIndex((t) => t.id === handle);
      if (i >= 0) queue.splice(i, 1);
    },
  };
  async function advanceTo(at: number): Promise<void> {
    await flush();
    for (;;) {
      queue.sort((a, b) => a.at - b.at || a.id - b.id);
      const next = queue[0];
      if (next === undefined || next.at > at) break;
      queue.shift();
      now = Math.max(now, next.at);
      next.callback();
      await flush();
    }
    now = Math.max(now, at);
    await flush();
  }
  return {
    clock: { nowMono: () => now },
    wall: { nowUtcMs: () => wallStart + (now - start) },
    timers,
    now: () => now,
    scheduled: () => scheduled,
    pending: () => queue.length,
    advance: (ms) => advanceTo(now + ms),
    advanceTo,
  };
}

export interface RecordedRequest {
  readonly url: string;
  readonly path: string;
  readonly body: string;
  readonly authorization: string | null;
  readonly at: number;
}

export type ScriptedReply =
  | { readonly status: number; readonly body?: unknown; readonly headers?: Record<string, string> }
  | { readonly network: true }
  | { readonly hold: true };

/**
 * Scripted fetch for `createCardApi`. Replies are consumed in order; when the
 * script is empty, sends and edits are acknowledged with the expected
 * identity. A `hold` reply stays pending until `release()` or the request
 * signal aborts (an `ignoreAbort` transport never settles on abort).
 */
export function scriptedFetch(time: ManualTime, options: { ignoreAbort?: boolean } = {}) {
  const requests: RecordedRequest[] = [];
  const script: ScriptedReply[] = [];
  const held: { resolve: (r: Response) => void; record: RecordedRequest }[] = [];
  let messageNo = 0;

  function autoAck(path: string, body: string): Response {
    const parsed = JSON.parse(body) as Record<string, unknown>;
    if (path.endsWith("/v1/bot/sendMessage")) {
      messageNo++;
      return json(200, { message_id: `9${String(messageNo).padStart(17, "0")}`, client_msg_no: parsed.client_msg_no });
    }
    const seq = typeof parsed.card_seq === "number" ? parsed.card_seq
      : (JSON.parse(parsed.content_edit as string) as { card_seq: number }).card_seq;
    return json(200, { message_id: parsed.message_id, card_seq: seq });
  }

  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    const body = typeof init?.body === "string" ? init.body : "";
    const headers = new Headers(init?.headers);
    const path = new URL(url).pathname;
    const record = { url, path, body, authorization: headers.get("authorization"), at: time.now() };
    requests.push(record);
    const reply = script.shift();
    if (reply === undefined) return autoAck(path, body);
    if ("network" in reply) throw new TypeError("fetch failed");
    if ("hold" in reply) {
      return new Promise<Response>((resolve, reject) => {
        held.push({ resolve, record });
        if (!options.ignoreAbort) {
          init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
        }
      });
    }
    return json(reply.status, reply.body ?? {}, reply.headers);
  }) as typeof fetch;

  return {
    fetchImpl,
    requests,
    reply(...replies: ScriptedReply[]) { script.push(...replies); },
    /** Resolve the oldest held request with an acknowledgement of its own identity. */
    release(response?: { status: number; body?: unknown; headers?: Record<string, string> }) {
      const h = held.shift();
      if (h === undefined) throw new Error("nothing held");
      h.resolve(response ? json(response.status, response.body ?? {}, response.headers) : autoAck(h.record.path, h.record.body));
    },
    heldCount: () => held.length,
    edits: () => requests.filter((r) => r.path.endsWith("/v1/bot/message/edit")),
    sends: () => requests.filter((r) => r.path.endsWith("/v1/bot/sendMessage")),
  };
}

export function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

/** card_seq carried by a recorded registry or authored edit body. */
export function seqOf(request: RecordedRequest): number {
  const parsed = JSON.parse(request.body) as Record<string, unknown>;
  if (typeof parsed.card_seq === "number") return parsed.card_seq;
  return (JSON.parse(parsed.content_edit as string) as { card_seq: number }).card_seq;
}
