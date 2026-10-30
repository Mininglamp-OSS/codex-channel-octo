import { randomUUID } from 'node:crypto';
import { ArtifactError, snapshotImage, type ArtifactScope } from './artifact-files.js';
import { MAX_IMAGE_ARTIFACTS, type ImageArtifact } from './artifacts.js';
import { uploadArtifact, sendNativeImage } from './octo/media.js';
import { confirmedMessageId } from './stream-relay.js';
import type { SessionStore } from './session-store.js';
import type { TurnContext } from './turn-context.js';

export interface ImageDelivery {
  id: string;
  generation: 'ready' | 'failed';
  upload: 'not_started' | 'unknown' | 'confirmed' | 'failed';
  delivery: 'not_started' | 'unknown' | 'confirmed' | 'external' | 'duplicate';
  clientMsgNo: string;
  messageId?: string;
}

/** One pass only. Durable intents prevent reentry/restart from becoming resends. */
export async function deliverImages(params: {
  artifacts: ReadonlyArray<ImageArtifact>; scope: ArtifactScope; maxBytes: number;
  apiUrl: string; botToken: string; channelId: string; channelType: number;
  turn: TurnContext; store: SessionStore;
}): Promise<ImageDelivery[]> {
  const { turn, store } = params;
  const check = () => turn.assertPublishable(); check();
  if (params.artifacts.length > MAX_IMAGE_ARTIFACTS) throw new Error('Image artifact count exceeds local limit');
  const previous = store.readImageDeliveries(turn.turnId);
  if (previous.length) return previous; // Never infer remote deduplication from client_msg_no.
  const report: ImageDelivery[] = [];
  const snapshots = new Map<string, ReturnType<typeof snapshotImage>>();
  // Validate every file before any upload; external entries suppress relay
  // copies by digest even when the external entry appears later in the array.
  const external = new Set<string>(); const seen = new Set<string>();
  for (const a of params.artifacts) {
    check();
    try { const image = snapshotImage(params.scope, a.path, params.maxBytes); snapshots.set(a.id, image); if (a.disposition === 'external') external.add(image.digest); }
    catch { /* Per-item generation failure is recorded below. */ }
  }
  for (const a of params.artifacts) {
    const image = snapshots.get(a.id);
    report.push({ id: a.id, clientMsgNo: randomUUID(), generation: image ? 'ready' : 'failed', upload: 'not_started',
      delivery: a.disposition === 'external' ? 'external' : 'not_started' });
  }
  check(); store.saveImageDeliveries(turn.turnId, report);
  const persist = (r: ImageDelivery) => { check(); store.updateImageDelivery(turn.turnId, r); };
  for (const [i, a] of params.artifacts.entries()) {
    check(); const r = report[i]; const image = snapshots.get(a.id);
    if (!image || a.disposition === 'external') continue;
    if (external.has(image.digest) || seen.has(image.digest)) { r.delivery = 'duplicate'; persist(r); continue; }
    seen.add(image.digest);
    r.upload = 'unknown'; persist(r);
    let url: string;
    try {
      url = await uploadArtifact({ ...params, name: image.name, mime: image.mime, bytes: image.bytes, signal: turn.signal, check });
      check(); r.upload = 'confirmed'; persist(r);
    } catch (error) {
      check(); r.upload = error instanceof ArtifactError && error.code === 'outcome_unknown' ? 'unknown' : 'failed'; persist(r); continue;
    }
    // Persist uncertainty BEFORE starting the message request; a lost ack or
    // cancellation must never turn an attempted delivery back into "not sent".
    r.delivery = 'unknown'; persist(r);
    try {
      const result = await sendNativeImage({ ...params, url, name: image.name, size: image.bytes.length,
        width: image.width, height: image.height, clientMsgNo: r.clientMsgNo, signal: turn.signal, check });
      check();
      const id = confirmedMessageId(result?.message_id);
      if (id) { r.delivery = 'confirmed'; r.messageId = id; persist(r); }
    } catch { check(); /* Keep unknown, never retry. Later distinct images remain independent. */ }
  }
  return report;
}

/** Numbered stage reports never include model-controlled names, paths or URLs. */
export function imageDeliverySummary(report: ReadonlyArray<ImageDelivery>): string {
  return report.map((r, i) => `Image ${i + 1}: generation=${r.generation}; upload=${r.upload}; delivery=${r.delivery}.`).join('\n');
}
