/** Strict evidence reader over the existing supported Bot API sync operation. */
import { postJson } from './api.js';
import { isAllowedApiUrl } from '../url-policy.js';
import { createHash } from 'node:crypto';

/** Same canonical, positive signed-int64 contract as the capture send oracle. */
function canonicalMessageId(value: unknown): string | undefined {
  const id = typeof value === 'string' ? value
    : typeof value === 'number' && Number.isSafeInteger(value) ? String(value) : '';
  return /^[1-9]\d{0,18}$/.test(id) && BigInt(id) <= 9223372036854775807n ? id : undefined;
}

/** Evidence must contain the server payload, never a fabricated replacement. */
function decodePayload(value: unknown): Record<string, unknown> {
  if (typeof value === 'string') {
    if (!value.length || value.length > 256 * 1024 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value) ||
        Buffer.from(value, 'base64').toString('base64') !== value) {
      throw new Error('Readback incomplete: invalid/oversized payload');
    }
    try { value = JSON.parse(Buffer.from(value, 'base64').toString('utf8')); }
    catch { throw new Error('Readback incomplete: malformed payload'); }
  }
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Buffer.byteLength(JSON.stringify(value)) > 256 * 1024) {
    throw new Error('Readback incomplete: invalid/oversized payload');
  }
  return value as Record<string, unknown>;
}

export interface EvidenceOptions {
  apiUrl: string;
  botToken: string;
  channelId: string;
  channelType: number;
  pageSize?: number;
  /** Supported Bot API includes start_message_seq; exclusive is explicit legacy compatibility. */
  cursorMode?: 'inclusive' | 'exclusive';
  /** Required lower sequence boundary; default 1. Retention truncation fails closed. */
  lowWatermark?: number;
  maxPages?: number;
  signal?: AbortSignal;
}
export interface EvidenceMessage {
  message_seq: number;
  messageId: string;
  senderUid: string;
  serverTimestamp: number;
  payloadHash: string;
  payload: unknown;
  channelId: string;
  channelType: number;
}
export interface ReadbackEvidence {
  messages: EvidenceMessage[];
  highWatermark: number;
  lowWatermark: number;
  pages: number;
  cursors: number[];
  complete: true;
  cursorMode: 'inclusive' | 'exclusive';
}

export async function readback(options: EvidenceOptions): Promise<ReadbackEvidence> {
  const pageSize = options.pageSize ?? 100;
  const cursorMode = options.cursorMode ?? 'inclusive';
  const lowWatermark = options.lowWatermark ?? 1;
  const maxPages = options.maxPages ?? 10000;
  if (!['inclusive', 'exclusive'].includes(cursorMode) || !isAllowedApiUrl(options.apiUrl) || typeof options.botToken !== 'string' || !options.botToken || !options.channelId || ![1, 2].includes(options.channelType) ||
      !Number.isInteger(pageSize) || pageSize < 1 || pageSize > 1000 ||
      !Number.isSafeInteger(lowWatermark) || lowWatermark < 1 ||
      !Number.isSafeInteger(maxPages) || maxPages < 1) throw new Error('Invalid evidence readback options');
  async function page(cursor: number, limit: number): Promise<Record<string, unknown>[]> {
    let response: { messages?: Record<string, unknown>[] } | undefined;
    try {
      response = await postJson(options.apiUrl, options.botToken, '/v1/bot/messages/sync', {
        channel_id: options.channelId, channel_type: options.channelType,
        start_message_seq: cursor, end_message_seq: 0, pull_mode: 0, limit,
      }, options.signal);
    } catch {
      // API error bodies can contain credentials. Never surface them as evidence.
      throw new Error('Readback incomplete: transport/API failure');
    }
    if (!Array.isArray(response?.messages) || response.messages.length > limit) {
      throw new Error('Readback incomplete: malformed or oversized page');
    }
    for (const message of response.messages) {
      decodePayload(message?.payload);
      if (!message || typeof message !== 'object' || !canonicalMessageId(message.message_id)) {
        throw new Error('Readback incomplete: invalid message identity');
      }
      if (!Number.isSafeInteger(message.message_seq) || Number(message.message_seq) < 1) {
        throw new Error('Readback incomplete: invalid sequence');
      }
    }
    return response.messages;
  }
  const latest = await page(0, 1);
  if (!latest.length) throw new Error('Readback incomplete: no authoritative high watermark');
  const highWatermark = Number(latest[0].message_seq);
  if (highWatermark < lowWatermark || highWatermark >= Number.MAX_SAFE_INTEGER) {
    throw new Error('Readback incomplete: invalid high watermark');
  }
  let cursor = cursorMode === 'inclusive' ? highWatermark : highWatermark + 1;
  const messages: EvidenceMessage[] = [];
  const sequences = new Set<number>();
  const ids = new Set<string>();
  const cursors: number[] = [];
  for (let pages = 1; pages <= maxPages; pages++) {
    cursors.push(cursor);
    const rows = await page(cursor, pageSize);
    if (!rows.length) throw new Error('Readback incomplete: retention/cap before lower watermark');
    let next = cursor;
    for (const row of rows) {
      const seq = Number(row.message_seq);
      if ((cursorMode === 'inclusive' ? seq > cursor : seq >= cursor) || seq > highWatermark || sequences.has(seq)) {
        throw new Error('Readback incomplete: page cursor/watermark violation');
      }
      const messageId = canonicalMessageId(row.message_id);
      if (!messageId || ids.has(messageId) ||
          typeof row.from_uid !== 'string' || !row.from_uid.trim() || !Number.isFinite(row.timestamp)) {
        throw new Error('Readback incomplete: invalid message identity');
      }
      sequences.add(seq); ids.add(messageId);
      next = Math.min(next, seq);
      const payload = decodePayload(row.payload);
      if (seq >= lowWatermark) messages.push({ message_seq: seq, messageId,
        senderUid: redact(row.from_uid, options.botToken) as string, serverTimestamp: Number(row.timestamp),
        channelId: options.channelId, channelType: options.channelType,
        payloadHash: createHash('sha256').update(JSON.stringify(payload)).digest('hex'),
        payload: redact(payload, options.botToken) });
    }
    if (pages === 1 && !sequences.has(highWatermark)) throw new Error('Readback incomplete: omitted high watermark');
    if (next <= lowWatermark) {
      if (!sequences.has(lowWatermark)) throw new Error('Readback incomplete: omitted lower watermark');
      if (messages.length !== highWatermark - lowWatermark + 1) {
        throw new Error('Readback incomplete: sequence gap requires retention/deletion reconciliation');
      }
      return { messages: messages.sort((a, b) => a.message_seq - b.message_seq), highWatermark,
        lowWatermark, pages, cursors, cursorMode, complete: true };
    }
    cursor = cursorMode === 'inclusive' ? next - 1 : next;
  }
  throw new Error('Readback incomplete: explicit page budget exhausted');
}

function redact(value: unknown, secret: string): unknown {
  if (typeof value === 'string') return value.split(secret).join('[REDACTED]')
    .replace(/Bearer\s+\S+/gi, 'Bearer [REDACTED]').replace(/\b(?:bf_|app_|sk-)[A-Za-z0-9_-]+/g, '[REDACTED]');
  if (Array.isArray(value)) return value.map(v => redact(v, secret));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value)
    .filter(([key]) => !/authorization|token|secret|password|api.?key/i.test(key) && redact(key, secret) === key)
    .map(([key, item]) => [key, redact(item, secret)]));
  return value;
}
