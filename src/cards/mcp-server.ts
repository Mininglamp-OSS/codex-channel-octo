/**
 * Packaged stdio MCP proxy for explicit cards (TD v3 §2.4 as amended by AM-08 v4 §4, WP-08).
 *
 * Launched by Codex as `node <abs>/dist/cards/mcp-server.js --bootstrap <abs ticket> --port <n>`:
 * - redeems the single-use ticket before answering `initialize`: open with
 *   `O_NOFOLLOW`, `fstat` (regular file, our uid, mode 0600, one link, exact
 *   size), read, unlink, connect to `127.0.0.1:<port>`, send the bootstrap
 *   frame and receive `{authority, ops}`;
 * - on any failure, a 3 s redemption timeout or a missing file it answers
 *   `initialize` with zero tools (inert). It never exits before answering
 *   `initialize`, never writes the ticket or authority to stdout or stderr,
 *   and spawns no children;
 * - `tools/call` forwards `{v:1, request_id, authority, op, args}` over the
 *   same connection and returns the parent's correlated `CardToolResult`.
 *
 * stdout carries newline-delimited JSON-RPC only. It imports nothing but the
 * protocol module: no config, database, runtime or credentials.
 */

import { randomBytes } from "node:crypto";
import { closeSync, constants, fstatSync, openSync, readSync, realpathSync, unlinkSync } from "node:fs";
import { connect, type Socket } from "node:net";
import { isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";
import {
  MAX_FRAME_BODY_BYTES,
  encodeBootstrapFrame,
  parseBootstrapReply,
  parseReplyFrame,
  readFrame,
} from "./protocol.js";
import type { CardToolResult, ToolOpcode } from "./contracts.js";

/** Redemption must finish within this bound, or the proxy stays inert. */
export const REDEMPTION_TIMEOUT_MS = 3_000;
const TICKET_BYTES = 64;
const MAX_LINE_BYTES = 1_048_576;
const SUPPORTED_PROTOCOLS: readonly string[] = ["2025-06-18", "2025-03-26", "2024-11-05"];

const UNAVAILABLE: CardToolResult = Object.freeze({ status: "error", error: Object.freeze({ code: "unavailable" }) });
const TOO_LARGE: CardToolResult = Object.freeze({ status: "error", error: Object.freeze({ code: "limit_exceeded" }) });

export interface ProxyIo {
  readonly argv: readonly string[];
  readonly stdin: NodeJS.ReadableStream;
  readonly write: (line: string) => void;
  readonly uid?: number;
}

interface Redeemed {
  readonly authority: string;
  readonly ops: readonly ToolOpcode[];
  readonly socket: Socket;
}

function parseArgs(argv: readonly string[]): { ticket: string; port: number } | null {
  if (argv.length !== 4 || argv[0] !== "--bootstrap" || argv[2] !== "--port") return null;
  const ticket = argv[1] as string;
  const port = Number(argv[3]);
  if (!isAbsolute(ticket) || !/^[1-9][0-9]{0,4}$/.test(argv[3] as string) || port > 65_535) return null;
  return { ticket, port };
}

/** Read and unlink the ticket; null on any deviation from the owner-only single-link contract. */
function takeTicket(path: string, uid: number | undefined): string | null {
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  } catch {
    return null;
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile() || st.nlink !== 1 || st.size !== TICKET_BYTES) return null;
    if (process.platform !== "win32" && ((st.mode & 0o777) !== 0o600 || (uid !== undefined && st.uid !== uid))) return null;
    const buf = Buffer.alloc(TICKET_BYTES + 1);
    let len = 0;
    for (;;) {
      const n = readSync(fd, buf, len, buf.length - len, null);
      if (n === 0) break;
      len += n;
      if (len > TICKET_BYTES) return null;
    }
    const text = buf.subarray(0, len).toString("utf8");
    buf.fill(0);
    return /^[0-9a-f]{64}$/.test(text) ? text : null;
  } catch {
    return null;
  } finally {
    try { closeSync(fd); } catch { /* closed */ }
    try { unlinkSync(path); } catch { /* the parent unlinks too */ }
  }
}

function redeem(argv: readonly string[], uid: number | undefined): Promise<Redeemed | null> {
  const args = parseArgs(argv);
  if (args === null) return Promise.resolve(null);
  const ticket = takeTicket(args.ticket, uid);
  if (ticket === null) return Promise.resolve(null);
  return new Promise((resolve) => {
    let done = false;
    let buffer: Buffer = Buffer.alloc(0);
    const socket = connect({ host: "127.0.0.1", port: args.port });
    const finish = (value: Redeemed | null): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      socket.off("data", onData);
      if (value === null) socket.destroy();
      resolve(value);
    };
    const timer = setTimeout(() => finish(null), REDEMPTION_TIMEOUT_MS);
    const onData = (chunk: Buffer): void => {
      buffer = buffer.length === 0 ? chunk : Buffer.concat([buffer, chunk]);
      const r = readFrame(buffer);
      if (r.kind === "incomplete") return;
      if (r.kind === "error") { finish(null); return; }
      const reply = parseBootstrapReply(r.body);
      if (reply === null) { finish(null); return; }
      if (buffer.length > r.consumed) { finish(null); return; }
      finish({ authority: reply.authority, ops: reply.ops, socket });
    };
    socket.setNoDelay(true);
    socket.on("data", onData);
    socket.on("error", () => finish(null));
    socket.on("close", () => finish(null));
    socket.once("connect", () => {
      try { socket.write(Buffer.from(encodeBootstrapFrame({ v: 1, bootstrap: ticket }))); } catch { finish(null); }
    });
  });
}

/** Run the proxy over the given stdio; resolves when stdin ends. */
export function runMcpProxy(io: ProxyIo): Promise<void> {
  const redemption = redeem(io.argv, io.uid);
  let session: Redeemed | null = null;
  let initialized = false;
  const pending = new Map<string, (r: CardToolResult) => void>();
  let socketBuffer: Buffer = Buffer.alloc(0);

  const send = (msg: unknown): void => { try { io.write(`${JSON.stringify(msg)}\n`); } catch { /* stdout gone */ } };
  const failAll = (): void => { for (const resolve of pending.values()) resolve(UNAVAILABLE); pending.clear(); };

  void redemption.then((r) => {
    session = r;
    if (r === null) return;
    r.socket.on("data", (chunk: Buffer) => {
      socketBuffer = socketBuffer.length === 0 ? chunk : Buffer.concat([socketBuffer, chunk]);
      for (;;) {
        const f = readFrame(socketBuffer);
        if (f.kind === "incomplete") return;
        if (f.kind === "error") { r.socket.destroy(); return; }
        socketBuffer = socketBuffer.subarray(f.consumed);
        const reply = parseReplyFrame(f.body);
        if (!reply.ok) continue;
        const resolve = pending.get(reply.frame.request_id);
        if (resolve === undefined) continue;
        pending.delete(reply.frame.request_id);
        resolve(reply.frame.result);
      }
    });
    r.socket.on("close", () => { session = null; failAll(); });
    r.socket.on("error", () => { /* close follows */ });
  });

  const call = (op: ToolOpcode, args: unknown): Promise<CardToolResult> => {
    const s = session;
    if (s === null || s.socket.destroyed) return Promise.resolve(UNAVAILABLE);
    const requestId = randomBytes(16).toString("hex");
    const body = Buffer.from(JSON.stringify({ v: 1, request_id: requestId, authority: s.authority, op, args }), "utf8");
    if (body.byteLength > MAX_FRAME_BODY_BYTES) return Promise.resolve(TOO_LARGE);
    const frame = Buffer.alloc(4 + body.byteLength);
    frame.writeUInt32BE(body.byteLength, 0);
    body.copy(frame, 4);
    return new Promise((resolve) => {
      pending.set(requestId, resolve);
      try { s.socket.write(frame); } catch { pending.delete(requestId); resolve(UNAVAILABLE); }
    });
  };

  const toolResult = (result: CardToolResult) => ({
    content: [{ type: "text", text: JSON.stringify(result) }],
    structuredContent: result,
    isError: result.status === "error",
  });

  const handle = async (msg: Record<string, unknown>): Promise<void> => {
    const id = msg.id;
    const method = msg.method;
    if (typeof method !== "string") return;
    const isRequest = typeof id === "string" || typeof id === "number";
    if (!isRequest) return; // notifications carry nothing for us
    const params = (msg.params !== null && typeof msg.params === "object" ? msg.params : {}) as Record<string, unknown>;
    switch (method) {
      case "initialize": {
        await redemption;
        initialized = true;
        const requested = typeof params.protocolVersion === "string" ? params.protocolVersion : "";
        send({ jsonrpc: "2.0", id, result: {
          protocolVersion: SUPPORTED_PROTOCOLS.includes(requested) ? requested : SUPPORTED_PROTOCOLS[0],
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: "octo-cards", version: "1" },
        } });
        return;
      }
      case "ping":
        send({ jsonrpc: "2.0", id, result: {} });
        return;
      case "tools/list": {
        const ops = initialized && session !== null ? session.ops : [];
        send({ jsonrpc: "2.0", id, result: { tools: ops.map((op) => ({
          name: op,
          description: op === "display" ? "Send a display card to the current conversation." : "Send an interactive card to the current requester.",
          inputSchema: { type: "object" },
        })) } });
        return;
      }
      case "tools/call": {
        const name = params.name;
        const ops = initialized && session !== null ? session.ops : [];
        if (typeof name !== "string" || !(ops as readonly string[]).includes(name)) {
          send({ jsonrpc: "2.0", id, result: toolResult(UNAVAILABLE) });
          return;
        }
        const args = params.arguments === undefined ? {} : params.arguments;
        send({ jsonrpc: "2.0", id, result: toolResult(await call(name as ToolOpcode, args)) });
        return;
      }
      default:
        send({ jsonrpc: "2.0", id, error: { code: -32601, message: "Method not found" } });
    }
  };

  return new Promise((resolve) => {
    let carry = "";
    io.stdin.setEncoding?.("utf8");
    io.stdin.on("data", (chunk: string | Buffer) => {
      carry += typeof chunk === "string" ? chunk : chunk.toString("utf8");
      let nl: number;
      while ((nl = carry.indexOf("\n")) >= 0) {
        const line = carry.slice(0, nl).trim();
        carry = carry.slice(nl + 1);
        if (line.length === 0) continue;
        let msg: unknown;
        try { msg = JSON.parse(line); } catch { continue; }
        if (msg !== null && typeof msg === "object" && !Array.isArray(msg)) void handle(msg as Record<string, unknown>).catch(() => undefined);
      }
      if (carry.length > MAX_LINE_BYTES) carry = "";
    });
    const end = (): void => {
      void redemption.then((r) => { try { r?.socket.destroy(); } catch { /* closed */ } });
      failAll();
      resolve();
    };
    io.stdin.on("end", end);
    io.stdin.on("close", end);
  });
}

function isEntry(): boolean {
  try { return Boolean(process.argv[1]) && import.meta.url === pathToFileURL(realpathSync(process.argv[1] as string)).href; }
  catch { return false; }
}

if (isEntry()) {
  // Never let an unexpected fault print anything: stdout is protocol-only and stderr stays empty.
  process.on("uncaughtException", () => { /* inert */ });
  process.on("unhandledRejection", () => { /* inert */ });
  const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
  void runMcpProxy({
    argv: process.argv.slice(2),
    stdin: process.stdin,
    write: (line) => { process.stdout.write(line); },
    ...(uid !== undefined ? { uid } : {}),
  }).then(() => { process.exitCode = 0; });
}
