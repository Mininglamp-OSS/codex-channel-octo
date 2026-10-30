/** Presigned transport contract: openclaw-channel-octo 3cdb7e794ba40ae617fb0215177d1493dd26460a. */
import { ArtifactError } from '../artifact-files.js';
import { assertPublicUrl } from '../url-policy.js';
import { postJson } from './api.js';
import type { SendMessageResult } from './types.js';

interface MediaRequest { apiUrl: string; botToken: string; signal: AbortSignal; check: () => void }
async function validateStorageUrl(raw: unknown, apiUrl: string): Promise<string> {
  if (typeof raw !== 'string' || raw.length > 16384) throw new Error('url');
  const u = new URL(raw); const api = new URL(apiUrl);
  if (u.username || u.password || u.hash) throw new Error('url');
  // Explicit localhost API configurations may use their own local storage.
  // Remote presigns never widen that exception to arbitrary internal targets.
  if (u.origin === api.origin && ['127.0.0.1', 'localhost', '[::1]'].includes(api.hostname)) return raw;
  if (u.protocol !== 'https:') throw new Error('url');
  await assertPublicUrl(u.toString());
  return raw;
}

/** Generic file upload transport; caller supplies already authorized byte snapshots. */
export async function uploadArtifact(params: MediaRequest & { name: string; mime: string; bytes: Buffer }): Promise<string> {
  let code = 'presign_failed';
  try {
    params.check();
    const signal = AbortSignal.any([params.signal, AbortSignal.timeout(30_000)]);
    const query = new URLSearchParams({ filename: params.name, fileSize: String(params.bytes.length), contentType: params.mime });
    const response = await fetch(`${params.apiUrl.replace(/\/+$/, '')}/v1/bot/upload/presigned?${query}`, {
      headers: { Authorization: `Bearer ${params.botToken}` }, signal, redirect: 'error',
    });
    if (!response.ok) { await response.body?.cancel(); throw new Error('presign'); }
    // Bound credential responses without ever including their body in an error.
    const reader = response.body?.getReader(); if (!reader) throw new Error('presign');
    const chunks: Uint8Array[] = []; let length = 0;
    try {
      while (true) {
        const { done, value } = await reader.read(); if (done) break;
        length += value.length; if (length > 65536) throw new Error('presign'); chunks.push(value);
      }
    } finally { await reader.cancel().catch(() => {}); }
    const data = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
    if ((data.method !== undefined && data.method !== 'PUT') || typeof data.contentType !== 'string'
      || /[\r\n]/.test(data.contentType)
      || (data.contentDisposition !== undefined && (typeof data.contentDisposition !== 'string' || /[\r\n]/.test(data.contentDisposition)))
      || (data.maxFileSize !== undefined && (typeof data.maxFileSize !== 'number' || data.maxFileSize < params.bytes.length))) throw new Error('presign');
    const uploadUrl = await validateStorageUrl(data.uploadUrl, params.apiUrl);
    const downloadUrl = await validateStorageUrl(data.downloadUrl, params.apiUrl);
    params.check(); signal.throwIfAborted();
    // The small presign request must not spend the upload's independent budget.
    // The parent turn signal still bounds both stages and every late callback.
    const uploadSignal = AbortSignal.any([params.signal, AbortSignal.timeout(120_000)]);
    const headers: Record<string, string> = { 'Content-Type': data.contentType, 'Content-Length': String(params.bytes.length) };
    if (typeof data.contentDisposition === 'string') headers['Content-Disposition'] = data.contentDisposition;
    code = 'outcome_unknown';
    const uploaded = await fetch(uploadUrl, { method: 'PUT', headers, body: new Uint8Array(params.bytes), signal: uploadSignal, redirect: 'error' });
    await uploaded.body?.cancel();
    if (!uploaded.ok) { code = 'put_rejected'; throw new Error('put'); }
    params.check();
    return downloadUrl;
  } catch {
    params.check(); // Preserve revocation/cancellation as control flow.
    throw new ArtifactError('upload', code);
  }
}

export async function sendNativeImage(params: MediaRequest & {
  channelId: string; channelType: number; url: string; name: string; size: number;
  width: number; height: number; clientMsgNo: string;
}): Promise<SendMessageResult | undefined> {
  params.check();
  return postJson(params.apiUrl, params.botToken, '/v1/bot/sendMessage', {
    channel_id: params.channelId, channel_type: params.channelType, client_msg_no: params.clientMsgNo,
    payload: { type: 2, url: params.url, name: params.name, size: params.size, width: params.width, height: params.height },
  }, params.signal);
}
