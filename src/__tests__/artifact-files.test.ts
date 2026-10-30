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
});
