import type { TranscriptEntry } from './jsonl-client.js';

/** Methods whose request/response pairs form the protocol subset DEV-03 consumes (R8 §3.3.6). */
const REQUESTS = new Set(['initialize', 'thread/start', 'thread/resume', 'turn/start', 'turn/interrupt', 'thread/unsubscribe']);

/**
 * Normalize an App Server transcript to the server's turn-protocol shape: the
 * incoming responses (labelled by request method) and turn/item lifecycle notifications (item type and turn
 * status kept; ids, timestamps and unrelated notifications dropped).
 */
export function normalizeTranscript(transcript: TranscriptEntry[]): string[] {
  const methodById = new Map<number | string, string>();
  const out: string[] = [];
  for (const e of transcript) {
    const m = e.message;
    if (e.dir === 'out') {
      // Outgoing requests only label their responses; client write timing is not part of the server's shape.
      if (m.method && m.id !== undefined && REQUESTS.has(m.method)) methodById.set(m.id, m.method);
      continue;
    }
    if (m.method === undefined && m.id !== undefined && methodById.has(m.id)) {
      out.push(`${m.error ? 'error' : 'response'}:${methodById.get(m.id)}`);
      continue;
    }
    const p = m.params as { item?: { type?: string }; turn?: { status?: string } } | undefined;
    switch (m.method) {
      case 'thread/started':
      case 'turn/started':
        out.push(m.method);
        break;
      case 'item/started':
      case 'item/completed':
        out.push(`${m.method}:${p?.item?.type}`);
        break;
      case 'turn/completed':
        out.push(`turn/completed:${p?.turn?.status}`);
        break;
      default:
        break;
    }
  }
  return out;
}
