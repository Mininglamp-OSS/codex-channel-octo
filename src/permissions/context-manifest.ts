import { createHash } from 'node:crypto';
import { canonicalControl, object, type ControlMethod } from './control-client.js';

export interface PrivateControl {
  call(method: ControlMethod, payload: Record<string, unknown>): Promise<Record<string, unknown>>;
}

/** The hash domain is the complete canonical core, with no carrier fields.
 * Snapshot before the first await; never truncate, substitute or retry chunks. */
export async function bindContextManifest(control: PrivateControl, capsuleId: string,
  core: { context_id: string; context_generation: string; originals: readonly unknown[] }, signal: AbortSignal): Promise<void> {
  if (!/^[0-9a-f]{32}$/.test(capsuleId) || !/^[0-9a-f]{32}$/.test(core.context_id)
    || !/^[0-9a-f]{32}$/.test(core.context_generation) || core.originals.length < 1 || core.originals.length > 256) {
    throw new Error('Complete contributor bound exceeded');
  }
  const bytes = Buffer.from(canonicalControl(core));
  if (bytes.length > 1024 * 1024) throw new Error('Complete contributor bound exceeded');
  const generation = core.context_generation;
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const inline = { capsule_id: capsuleId, manifest: { ...JSON.parse(bytes.toString()) as Record<string, unknown>, bytes: bytes.length, sha256 } };
  // Include the entire fixed outer envelope, not just the manifest size.
  const frameSize = Buffer.byteLength(canonicalControl({ control_version: 1, request_id: '0'.repeat(32),
    session_id: '0'.repeat(32), method: 'bind_context', payload: inline }));
  if (frameSize <= 65536) {
    signal.throwIfAborted();
    const reply = object(await control.call('bind_context', inline), ['context_generation']);
    signal.throwIfAborted();
    if (reply.context_generation !== generation) throw new Error('Context generation conflict');
    return;
  }
  for (let offset = 0; offset < bytes.length; offset += 32768) {
    signal.throwIfAborted();
    const data = bytes.subarray(offset, offset + 32768);
    const reply = await control.call('bind_context', { capsule_id: capsuleId,
      manifest: { carrier: 'canonical-json-chunks-v1', bytes: bytes.length, sha256, offset, data_base64: data.toString('base64') } });
    signal.throwIfAborted();
    const end = offset + data.length;
    if (end === bytes.length) {
      if (object(reply, ['context_generation']).context_generation !== generation) throw new Error('Context generation conflict');
    } else if (object(reply, ['accepted_bytes']).accepted_bytes !== end) throw new Error('Manifest offset conflict');
  }
}
