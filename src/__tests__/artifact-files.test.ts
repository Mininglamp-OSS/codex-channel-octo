import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync, symlinkSync, linkSync, rmSync, renameSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createArtifactScope, snapshotImage } from '../artifact-files.js';

// A real 1x1 PNG; validation must not rely on the extension alone.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAAAAAA6fptVAAAACklEQVR4nGNgAAAAAgABSK+kcQAAAABJRU5ErkJggg==', 'base64');
const roots: string[] = [];
afterEach(() => roots.splice(0).forEach(p => rmSync(p, { recursive: true, force: true })));
function setup() {
  const root = mkdtempSync(join(tmpdir(), 'artifact-test-')); roots.push(root);
  return { root, scope: createArtifactScope(root) };
}
describe('image authorization and snapshots', () => {
  it('reads exact bytes, sniffs MIME and extracts dimensions', () => {
    const { scope } = setup(); writeFileSync(join(scope.directory, '图片.png'), PNG);
    expect(snapshotImage(scope, '图片.png', 1024)).toMatchObject({ bytes: PNG, mime: 'image/png', width: 1, height: 1 });
  });
  it.each(['../x.png', '/tmp/x.png', 'https://example.com/x.png', '.env.png', 'credentials.png', 'nested/x.png'])('rejects unauthorized filename %s', name => {
    const { scope } = setup();
    expect(() => snapshotImage(scope, name, 1024)).toThrow('generation:');
  });
  it('rejects missing, empty, oversized, disguised and truncated files', () => {
    const { scope } = setup();
    expect(() => snapshotImage(scope, 'missing.png', 1024)).toThrow('generation:');
    for (const bytes of [Buffer.alloc(0), Buffer.from('secret'), PNG.subarray(0, 24)]) {
      writeFileSync(join(scope.directory, 'x.png'), bytes);
      expect(() => snapshotImage(scope, 'x.png', 1024)).toThrow('generation:');
    }
    writeFileSync(join(scope.directory, 'x.jpg'), PNG);
    expect(() => snapshotImage(scope, 'x.jpg', 1024)).toThrow('generation:');
    writeFileSync(join(scope.directory, 'x.png'), PNG);
    expect(() => snapshotImage(scope, 'x.png', 10)).toThrow('generation:');
  });
  it('rejects symlinks, hardlinks and a replaced scope directory', () => {
    const { root, scope } = setup(); const source = join(root, 'source.png'); writeFileSync(source, PNG);
    symlinkSync(source, join(scope.directory, 'link.png'));
    linkSync(source, join(scope.directory, 'hard.png'));
    for (const p of ['link.png', 'hard.png']) expect(() => snapshotImage(scope, p, 1024)).toThrow('generation:');
    renameSync(scope.directory, scope.directory + '-old');
    symlinkSync(scope.directory + '-old', scope.directory);
    expect(() => snapshotImage(scope, 'hard.png', 1024)).toThrow('generation:');
  });
  it('keeps a byte snapshot independent of subsequent path replacement', () => {
    const { scope } = setup(); const p = join(scope.directory, 'x.png'); writeFileSync(p, PNG);
    const image = snapshotImage(scope, 'x.png', 1024); writeFileSync(p, 'replaced');
    expect(image.bytes).toEqual(PNG);
  });
  it('rejects corrupt PNG chunks even with correct magic bytes', () => {
    const { scope } = setup(); const b = Buffer.from(PNG); b[29] ^= 1;
    writeFileSync(join(scope.directory, 'broken.png'), b);
    expect(() => snapshotImage(scope, 'broken.png', 1024)).toThrow('generation:');
  });
  it('accepts a real GIF with dimensions, and rejects a header-only disguise', () => {
    const { scope } = setup();
    const gif = Buffer.from('R0lGODdhAQABAIEAAP///wAAAAAAAAAAACwAAAAAAQABAAAIBAABBAQAOw==', 'base64');
    writeFileSync(join(scope.directory, 'x.gif'), gif);
    expect(snapshotImage(scope, 'x.gif', 1024)).toMatchObject({ mime: 'image/gif', width: 1, height: 1 });
    const fake = Buffer.concat([gif.subarray(0, 13), Buffer.from([0x3b])]);
    writeFileSync(join(scope.directory, 'fake.gif'), fake);
    expect(() => snapshotImage(scope, 'fake.gif', 1024)).toThrow('generation:');
  });
  it('extracts JPEG dimensions from SOF without guessing from the filename', () => {
    const { scope } = setup();
    // Fixture: 1x1 RGB white JPEG produced with Pillow, not an extension-only stub.
    const jpeg = readFileSync(new URL('./fixtures/native-image.jpg', import.meta.url));
    writeFileSync(join(scope.directory, 'x.jpeg'), jpeg);
    expect(snapshotImage(scope, 'x.jpeg', 2048)).toMatchObject({ mime: 'image/jpeg', width: 1, height: 1, bytes: jpeg });
  });
  it('ADV-95-001: rejects the 16-byte fake JPEG before upload', () => {
    const { scope } = setup();
    writeFileSync(join(scope.directory, 'fake.jpg'), Buffer.from('ffd8ffc00008080001000100ffdaffd9', 'hex'));
    expect(() => snapshotImage(scope, 'fake.jpg', 1024)).toThrow('generation:');
  });
  it.each([
    { width: 65535, height: 65535, left: 0, top: 0 },
    { width: 1, height: 1, left: 1, top: 0 },
    { width: 1, height: 1, left: 0, top: 1 },
  ])('ADV-95-002: rejects GIF frames outside the canvas/limits (%j)', frame => {
    const { scope } = setup();
    const gif = Buffer.from('R0lGODdhAQABAIEAAP///wAAAAAAAAAAACwAAAAAAQABAAAIBAABBAQAOw==', 'base64');
    const descriptor = gif.indexOf(0x2c);
    gif.writeUInt16LE(frame.left, descriptor + 1); gif.writeUInt16LE(frame.top, descriptor + 3);
    gif.writeUInt16LE(frame.width, descriptor + 5); gif.writeUInt16LE(frame.height, descriptor + 7);
    writeFileSync(join(scope.directory, 'fake.gif'), gif);
    expect(() => snapshotImage(scope, 'fake.gif', 1024)).toThrow('generation:');
  });
  it.each(['sof-count', 'sof-length', 'sos-length', 'sos-selector', 'scan-empty', 'scan-truncated', 'late-sos', 'early-eoi'])('ADV-95-001: rejects malformed JPEG %s', change => {
    const { scope } = setup();
    let jpeg = Buffer.from(readFileSync(new URL('./fixtures/native-image.jpg', import.meta.url)));
    const sof = jpeg.indexOf(Buffer.from([0xff, 0xc0])); const sos = jpeg.indexOf(Buffer.from([0xff, 0xda]));
    const data = sos + 2 + jpeg.readUInt16BE(sos + 2);
    if (change === 'sof-count') jpeg[sof + 9] = 4;
    if (change === 'sof-length') jpeg.writeUInt16BE(8, sof + 2);
    if (change === 'sos-length') jpeg.writeUInt16BE(6, sos + 2);
    if (change === 'sos-selector') jpeg[sos + 7] = jpeg[sos + 5];
    if (change === 'scan-empty') jpeg = Buffer.concat([jpeg.subarray(0, data), Buffer.from([0xff, 0xd9])]);
    if (change === 'scan-truncated') jpeg = jpeg.subarray(0, -2);
    if (change === 'late-sos') jpeg = Buffer.concat([jpeg.subarray(0, -2), Buffer.from('ffdaffd9', 'hex')]);
    if (change === 'early-eoi') jpeg = Buffer.concat([jpeg, Buffer.from('00ffd9', 'hex')]);
    writeFileSync(join(scope.directory, 'bad.jpg'), jpeg);
    expect(() => snapshotImage(scope, 'bad.jpg', 2048)).toThrow('generation:');
  });
  it('ADV-95-001: validates all scans of a real progressive JPEG', () => {
    const { scope } = setup();
    const jpeg = readFileSync(new URL('./fixtures/native-image-progressive.jpg', import.meta.url));
    writeFileSync(join(scope.directory, 'progressive.jpg'), jpeg);
    expect(snapshotImage(scope, 'progressive.jpg', 2048)).toMatchObject({ mime: 'image/jpeg', width: 2, height: 2 });
    const corrupt = Buffer.from(jpeg); const lastSOS = corrupt.lastIndexOf(Buffer.from([0xff, 0xda]));
    corrupt[lastSOS + 5] = 0xff; // A later scan refers to no frame component.
    writeFileSync(join(scope.directory, 'bad-progressive.jpg'), corrupt);
    expect(() => snapshotImage(scope, 'bad-progressive.jpg', 2048)).toThrow('generation:');
  });
  it('ADV-95-002: validates every descriptor, including later GIF frames', () => {
    const { scope } = setup();
    const gif = Buffer.from('R0lGODdhAQABAIEAAP///wAAAAAAAAAAACwAAAAAAQABAAAIBAABBAQAOw==', 'base64');
    const multi = Buffer.concat([gif.subarray(0, -1), gif.subarray(gif.indexOf(0x2c))]);
    writeFileSync(join(scope.directory, 'two.gif'), multi);
    expect(snapshotImage(scope, 'two.gif', 1024)).toMatchObject({ width: 1, height: 1 });
    multi.writeUInt16LE(65535, gif.length - 1 + 5);
    writeFileSync(join(scope.directory, 'two-bad.gif'), multi);
    expect(() => snapshotImage(scope, 'two-bad.gif', 1024)).toThrow('generation:');
  });
});
