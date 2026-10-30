import { constants, closeSync, fstatSync, lstatSync, mkdtempSync, openSync, readSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

export interface ArtifactScope { readonly directory: string; readonly dev: number; readonly ino: number }
export interface FileSnapshot { bytes: Buffer; name: string; digest: string }
export interface ImageSnapshot extends FileSnapshot { mime: string; width: number; height: number }
/** Fixed diagnostic vocabulary: never attach fs errors, paths, content or URLs. */
export class ArtifactError extends Error {
  constructor(readonly stage: 'generation' | 'upload' | 'delivery', readonly code: string) { super(`${stage}: ${code}`); }
}
export function createArtifactScope(cwd: string): ArtifactScope {
  try {
    const directory = mkdtempSync(join(realpathSync(cwd), '.octo-output-'));
    const st = lstatSync(directory);
    return Object.freeze({ directory, dev: st.dev, ino: st.ino });
  } catch { throw new ArtifactError('generation', 'output_directory_unavailable'); }
}
const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, i) => {
  let n = i;
  for (let bit = 0; bit < 8; bit++) n = (n >>> 1) ^ ((n & 1) ? 0xedb88320 : 0);
  return n >>> 0;
});
function crc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ byte) & 0xff];
  return (crc ^ 0xffffffff) >>> 0;
}
function assertScope(scope: ArtifactScope): void {
  const st = lstatSync(scope.directory);
  if (!st.isDirectory() || st.isSymbolicLink() || st.dev !== scope.dev || st.ino !== scope.ino
    || realpathSync(scope.directory) !== scope.directory) throw new Error('scope changed');
}

/** Header/structure validation, not an image renderer. Server format policy is unknown. */
function imageMetadata(b: Buffer): { mime: string; width: number; height: number; extensions: string[] } {
  if (b.length >= 45 && b.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) {
    if (b.readUInt32BE(8) !== 13 || b.toString('ascii', 12, 16) !== 'IHDR') throw new Error('PNG IHDR');
    let offset = 8; let data = false; let end = false;
    while (offset + 12 <= b.length) {
      const length = b.readUInt32BE(offset); const tag = b.toString('ascii', offset + 4, offset + 8);
      if (length > b.length - offset - 12) throw new Error('PNG length');
      if (crc32(b.subarray(offset + 4, offset + 8 + length)) !== b.readUInt32BE(offset + 8 + length)) throw new Error('PNG CRC');
      if (tag === 'IDAT') data = true;
      offset += length + 12;
      if (tag === 'IEND') { end = length === 0 && offset === b.length; break; }
    }
    if (!data || !end) throw new Error('PNG incomplete');
    return { mime: 'image/png', width: b.readUInt32BE(16), height: b.readUInt32BE(20), extensions: ['png'] };
  }
  if (b.length >= 14 && ['GIF87a', 'GIF89a'].includes(b.toString('ascii', 0, 6)) && b[b.length - 1] === 0x3b) {
    let offset = 13 + ((b[10] & 0x80) ? 3 * (1 << ((b[10] & 7) + 1)) : 0);
    let frames = 0;
    const subBlocks = () => {
      while (offset < b.length) {
        const size = b[offset++]; if (size === 0) return;
        if (offset + size > b.length) throw new Error('GIF block'); offset += size;
      }
      throw new Error('GIF incomplete');
    };
    while (offset < b.length) {
      const tag = b[offset++];
      if (tag === 0x3b) { if (!frames || offset !== b.length) throw new Error('GIF frame'); break; }
      if (tag === 0x21) { offset++; subBlocks(); continue; }
      if (tag !== 0x2c || offset + 9 > b.length) throw new Error('GIF descriptor');
      const packed = b[offset + 8];
      if (!b.readUInt16LE(offset + 4) || !b.readUInt16LE(offset + 6)) throw new Error('GIF size');
      offset += 9 + ((packed & 0x80) ? 3 * (1 << ((packed & 7) + 1)) : 0);
      const codeSize = b[offset++]; if (codeSize < 2 || codeSize > 8) throw new Error('GIF code size');
      subBlocks(); frames++;
    }
    if (!frames || offset !== b.length) throw new Error('GIF incomplete');
    return { mime: 'image/gif', width: b.readUInt16LE(6), height: b.readUInt16LE(8), extensions: ['gif'] };
  }
  if (b.length >= 12 && b[0] === 0xff && b[1] === 0xd8 && b[b.length - 2] === 0xff && b[b.length - 1] === 0xd9) {
    let offset = 2; let dims: { width: number; height: number } | undefined;
    while (offset + 4 <= b.length) {
      if (b[offset++] !== 0xff) throw new Error('JPEG marker');
      while (b[offset] === 0xff) offset++;
      const marker = b[offset++];
      if (marker === 0xda) {
        if (dims) return { mime: 'image/jpeg', ...dims, extensions: ['jpg', 'jpeg'] };
        break;
      }
      const length = b.readUInt16BE(offset);
      if (length < 2 || offset + length > b.length) throw new Error('JPEG length');
      if ([0xc0,0xc1,0xc2].includes(marker) && length >= 8) dims = { height: b.readUInt16BE(offset + 3), width: b.readUInt16BE(offset + 5) };
      offset += length;
    }
  }
  throw new Error('unrecognized image');
}

/** Read one bounded immutable snapshot. Upload never reopens an agent-owned path. */
export function snapshotArtifact(scope: ArtifactScope, name: string, maxBytes: number): FileSnapshot {
  let fd: number | undefined;
  try {
    // Flat exports only: denies traversal/URLs, hidden files, config/credential
    // names and platform separators. No ambient workspace or additional roots.
    if (!name || name.length > 255 || name.startsWith('.') || /[/\\:\x00-\x1f\x7f]/.test(name)
      || /(?:credential|config|secret|token|private.?key|\.env)/i.test(name)) throw new Error('name');
    assertScope(scope);
    const path = join(scope.directory, name);
    const before = lstatSync(path);
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size < 1 || before.size > maxBytes) throw new Error('file');
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const opened = fstatSync(fd);
    if (!opened.isFile() || opened.nlink !== 1 || opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size) throw new Error('changed');
    const bytes = Buffer.alloc(opened.size);
    let position = 0;
    while (position < bytes.length) {
      const n = readSync(fd, bytes, position, bytes.length - position, position);
      if (n === 0) throw new Error('short read');
      position += n;
    }
    const after = fstatSync(fd); const pathAfter = lstatSync(path);
    assertScope(scope);
    if (after.nlink !== 1 || pathAfter.dev !== opened.dev || pathAfter.ino !== opened.ino
      || after.size !== opened.size || after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs) throw new Error('changed');
    return { bytes, name, digest: createHash('sha256').update(bytes).digest('hex') };
  } catch { throw new ArtifactError('generation', 'file_rejected'); }
  finally { if (fd !== undefined) closeSync(fd); }
}

/** Image-specific policy layered on the reusable authorized file snapshot. */
export function snapshotImage(scope: ArtifactScope, name: string, maxBytes: number): ImageSnapshot {
  try {
    if (!/\.(?:png|jpe?g|gif)$/i.test(name)) throw new Error('extension');
    const snapshot = snapshotArtifact(scope, name, maxBytes);
    const meta = imageMetadata(snapshot.bytes);
    if (!meta.extensions.includes(name.split('.').at(-1)!.toLowerCase()) || meta.width < 1 || meta.height < 1
      || meta.width > 16384 || meta.height > 16384 || meta.width * meta.height > 40_000_000) throw new Error('dimensions/type');
    return { ...snapshot, mime: meta.mime, width: meta.width, height: meta.height };
  } catch { throw new ArtifactError('generation', 'file_rejected'); }
}
