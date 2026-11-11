/** Explicit artifact protocol. Paths in ordinary prose are never instructions. */
export interface FileArtifact {
  id: string;
  path: string;
  /** External tools own delivery when explicitly declared; relay must abstain. */
  disposition: 'relay' | 'external';
}
export interface ImageArtifact extends FileArtifact { kind: 'image' }
export const MAX_IMAGE_ARTIFACTS = 4;
export const DEFAULT_IMAGE_BYTES = 10 * 1024 * 1024;
export interface NativeImageConfig { enabled?: boolean; maxBytes?: number }

export function validateNativeImages(value?: NativeImageConfig): void {
  if (value === undefined) return;
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some(k => !['enabled', 'maxBytes'].includes(k))
    || (value.enabled !== undefined && typeof value.enabled !== 'boolean')
    || (value.maxBytes !== undefined && (!Number.isSafeInteger(value.maxBytes) || value.maxBytes < 1 || value.maxBytes > 50 * 1024 * 1024))) {
    throw new Error('sdk.nativeImages requires enabled:boolean and maxBytes:1..52428800');
  }
}

export function decodeArtifactEnvelope(text: string, requestId: string, singleMessage = true): { text: string; artifacts: ImageArtifact[] } {
  const invalid = { text: '[Image generation: invalid or stale artifact envelope; no images sent.]', artifacts: [] };
  // Only a bare object-shaped output can opt into the reserved protocol.
  // Prose, fences and fragments remain ordinary text, even when quoting its key.
  const t = text.trim();
  if (!t.startsWith('{') || !t.endsWith('}') || !/"octo_output"\s*:/.test(t)) return { text, artifacts: [] };
  let value: unknown;
  try { value = JSON.parse(t); } catch { return invalid; }
  if (!value || typeof value !== 'object' || Array.isArray(value) || !('octo_output' in value)) return { text, artifacts: [] };
  if (!singleMessage) return invalid;
  const v = value as Record<string, unknown>;
  if (v.octo_output !== 1 || v.requestId !== requestId || typeof v.text !== 'string'
    || !Array.isArray(v.artifacts) || v.artifacts.length > MAX_IMAGE_ARTIFACTS) return invalid;
  const artifacts: ImageArtifact[] = [];
  const ids = new Set<string>();
  for (const raw of v.artifacts) {
    if (!raw || typeof raw !== 'object') return invalid;
    const a = raw as Record<string, unknown>;
    if (a.kind !== 'image' || typeof a.id !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(a.id)
      || ids.has(a.id) || typeof a.path !== 'string' || a.path.length > 255
      || (a.disposition !== 'relay' && a.disposition !== 'external')) return invalid;
    ids.add(a.id);
    artifacts.push({ id: a.id, kind: 'image', path: a.path, disposition: a.disposition });
  }
  return { text: v.text || (artifacts.length ? `[Image artifacts: ${artifacts.length}; delivery report follows.]` : ''), artifacts };
}

export function imageArtifactInstructions(requestId: string, directory: string): string {
  return '\n[Channel native image output protocol]\n'
    + `Only when the current user requests image delivery, write the requested PNG/JPEG/GIF files directly in ${JSON.stringify(directory)}. `
    + 'No subdirectories, symlinks, hardlinks, credentials or configuration files. Copy an existing authorized image into this directory if needed. '
    + `Return your final answer as ONE bare JSON object (no Markdown fences): ${JSON.stringify({ octo_output: 1, requestId, text: 'Accompanying text', artifacts: [{ id: 'image1', kind: 'image', path: 'image.png', disposition: 'relay' }] })}. `
    + `At most ${MAX_IMAGE_ARTIFACTS} images. Text is delivered first, then images in array order. `
    + 'Do not claim delivery before the channel reports it. If you used an explicit external sending tool for an image, set disposition:"external" for that same image; the channel will not send it again. '
    + 'Never both explicitly send an image and declare it for relay. External delivery is not verified by the channel. Ordinary text answers need no envelope.\n';
}
