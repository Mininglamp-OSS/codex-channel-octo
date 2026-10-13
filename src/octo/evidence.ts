/** Strict evidence reader over the existing supported Bot API sync operation. */
import { postJson } from './api.js';
import { isAllowedApiUrl } from '../url-policy.js';
import { createHash } from 'node:crypto';

export interface EvidenceOptions {
  apiUrl: string;
  botToken: string;
  channelId: string;
  channelType: number;
  pageSize?: number;
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
}

export async function readback(options: EvidenceOptions): Promise<ReadbackEvidence> {
  const pageSize = options.pageSize ?? 100;
  const lowWatermark = options.lowWatermark ?? 1;
  const maxPages = options.maxPages ?? 10000;
  if (!isAllowedApiUrl(options.apiUrl) || !options.channelId || ![1, 2].includes(options.channelType) ||
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
  let cursor = highWatermark + 1;
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
      if (seq >= cursor || seq > highWatermark || sequences.has(seq)) {
        throw new Error('Readback incomplete: page cursor/watermark violation');
      }
      const messageId = typeof row.message_id === 'string' ? row.message_id
        : Number.isSafeInteger(row.message_id) ? String(row.message_id) : '';
      if (!messageId || ids.has(messageId) ||
          typeof row.from_uid !== 'string' || !Number.isFinite(row.timestamp)) {
        throw new Error('Readback incomplete: invalid message identity');
      }
      sequences.add(seq); ids.add(messageId);
      next = Math.min(next, seq);
      let payload = row.payload ?? {};
      if (typeof payload === 'string') {
        if (payload.length > 256 * 1024 || !/^[A-Za-z0-9+/]*={0,2}$/.test(payload)) {
          throw new Error('Readback incomplete: invalid/oversized payload');
        }
        try { payload = JSON.parse(Buffer.from(payload, 'base64').toString('utf8')); }
        catch { throw new Error('Readback incomplete: malformed payload'); }
      }
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
        lowWatermark, pages, cursors, complete: true };
    }
    cursor = next;
  }
  throw new Error('Readback incomplete: explicit page budget exhausted');
}

function redact(value: unknown, secret: string): unknown {
  if (typeof value === 'string') return value.split(secret).join('[REDACTED]')
    .replace(/Bearer\s+\S+/gi, 'Bearer [REDACTED]').replace(/\b(?:bf_|app_|sk-)[A-Za-z0-9_-]+/g, '[REDACTED]');
  if (Array.isArray(value)) return value.map(v => redact(v, secret));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) =>
    [key, /authorization|token|secret|password|api.?key/i.test(key) ? '[REDACTED]' : redact(item, secret)]));
  return value;
}
