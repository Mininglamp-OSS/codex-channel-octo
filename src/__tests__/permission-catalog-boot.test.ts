import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { chmodSync, linkSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { catalogBootPin, verifyCatalogBoot, type CatalogBootPin } from '../permissions/catalog-boot.js';
import { canonicalControl } from '../permissions/control-client.js';
import { startPermissionCoordinator } from '../permissions/coordinator-process.js';

let root: string;
beforeEach(() => { root = realpathSync(mkdtempSync(join(tmpdir(), 'catalog-boot-'))); chmodSync(root, 0o700); });
afterEach(() => rmSync(root, { recursive: true, force: true }));
const v1 = { format: 'permission-release-manifest-v1', catalog_version: 'synthetic-v1', contract_revision: 2, semantics_version: '1' };
// Identity-only fixtures deliberately are not supported/complete packages. The
// MCP/server verifiers, not this endpoint preflight, own package conformance.
const v2 = { format: 'permission-catalog-package-v2', catalog_version: 'synthetic-v2', contract_revision: 3,
  semantics_version: '1', identity_index_sha256: 'a'.repeat(64), source_heads: {}, normalization: {}, limits: {}, files: [] };
function file(bytes: string | Buffer) {
  const path = join(root, 'manifest.json'); writeFileSync(path, bytes, { mode: 0o600 });
  return { release_path: path, release_sha256: createHash('sha256').update(bytes).digest('hex') };
}
function pin(host: ReturnType<typeof file>, format: CatalogBootPin['catalog_format'] = 'permission-catalog-package-v2', version = 'synthetic-v2') {
  return catalogBootPin({ catalog_format: format, catalog_version: version, catalog_digest: host.release_sha256 });
}

describe('v42 private catalog identity and format boot binding', () => {
  it('preserves legacy v1 identity and snapshots the explicit v2 pin, without a support or package-validity claim', () => {
    const legacy = file(canonicalControl(v1));
    expect(verifyCatalogBoot(legacy)).toEqual({ catalog_format: v1.format, catalog_version: v1.catalog_version, catalog_digest: legacy.release_sha256 });
    const packaged = file(canonicalControl(v2)); const selected = pin(packaged);
    expect(verifyCatalogBoot(packaged, selected)).toEqual(selected);
    expect(Object.isFrozen(verifyCatalogBoot(packaged, selected))).toBe(true);
    expect(() => verifyCatalogBoot(packaged)).toThrow('Explicit');
  });

  it.each(['format', 'version', 'digest', 'revision', 'semantics'] as const)('rejects %s skew instead of falling back to an old pin', fault => {
    const host = file(canonicalControl(v2)); const selected = pin(host);
    if (fault === 'format') selectedFormatMismatch();
    else if (fault === 'version') expect(() => verifyCatalogBoot(host, { ...selected, catalog_version: 'other' })).toThrow();
    else if (fault === 'digest') expect(() => verifyCatalogBoot({ ...host, release_sha256: 'f'.repeat(64) }, selected)).toThrow();
    else {
      const changed = file(canonicalControl({ ...v2, ...(fault === 'revision' ? { contract_revision: 2 } : { semantics_version: '2' }) }));
      expect(() => verifyCatalogBoot(changed, pin(changed))).toThrow();
    }
    function selectedFormatMismatch() { expect(() => verifyCatalogBoot(host, { ...selected, catalog_format: 'permission-release-manifest-v1' })).toThrow(); }
  });

  it('rejects changed bytes at the same path and never caches a path-only success', () => {
    const host = file(canonicalControl(v2)); const selected = pin(host);
    verifyCatalogBoot(host, selected);
    writeFileSync(host.release_path, canonicalControl({ ...v2, catalog_version: 'substituted' }));
    expect(() => verifyCatalogBoot(host, selected)).toThrow('digest');
  });

  it('rejects duplicate decoded identity keys, malformed framing, invalid UTF-8/BOM and unsupported formats', () => {
    for (const raw of [canonicalControl(v1).replace('"format":', '"format":"other","format":'),
      '\ufeff' + canonicalControl(v1), '{"format":', canonicalControl({ ...v1, format: 'unknown' }),
      canonicalControl(v1).replace('synthetic-v1', 'has space')]) {
      expect(() => verifyCatalogBoot(file(raw))).toThrow();
    }
    expect(() => verifyCatalogBoot(file(Buffer.from([0xff])))).toThrow();
  });

  it('does not apply packaging null/integer rules or control depth to inherited v1 values and raw strings', () => {
    const inherited = { profiles: [{ condition: { op: 'eq', argument: 'x', literal: null }, literal: 0.25 }],
      raw: ' {"z":null, "a":1e2,"macro":"$static_ref"}\n' };
    const host = file(JSON.stringify({ ...v1, ...inherited }));
    expect(verifyCatalogBoot(host).catalog_version).toBe('synthetic-v1');
    let nested: unknown = null; for (let i = 0; i < 16; i++) nested = [nested];
    expect(verifyCatalogBoot(file(JSON.stringify({ ...v1, inherited: nested }))).catalog_version).toBe('synthetic-v1');
  });

  it('enforces manifest versus v1 artifact bounds and only the manifest framing domain', () => {
    const manifest = file(canonicalControl({ ...v2, catalog_version: 'oversized', padding: 'x'.repeat(65536) }));
    expect(() => verifyCatalogBoot(manifest, pin(manifest, 'permission-catalog-package-v2', 'oversized'))).toThrow();
    expect(() => verifyCatalogBoot(file(Buffer.alloc(8388609, 32)))).toThrow();
    const noncanonical = file(JSON.stringify(v2));
    expect(() => verifyCatalogBoot(noncanonical, pin(noncanonical))).toThrow('framing');
    const extra = file(canonicalControl({ ...v2, added: null })); expect(() => verifyCatalogBoot(extra, pin(extra))).toThrow();
  });

  it('refuses symlinks, hardlink aliases and writable artifact bytes', () => {
    const host = file(canonicalControl(v1));
    symlinkSync(host.release_path, join(root, 'alias'));
    expect(() => verifyCatalogBoot({ ...host, release_path: join(root, 'alias') })).toThrow();
    linkSync(host.release_path, join(root, 'hardlink')); expect(() => verifyCatalogBoot(host)).toThrow();
    rmSync(join(root, 'hardlink')); chmodSync(host.release_path, 0o666); expect(() => verifyCatalogBoot(host)).toThrow();
  });

  it('rejects catalog mismatch before creating a coordinator process or a ready record', async () => {
    const host = file(canonicalControl(v2)); const selected = pin(host);
    const executable = join(root, 'synthetic-launcher'); writeFileSync(executable, '#!/bin/sh\nexit 70\n', { mode: 0o700 });
    await expect(startPermissionCoordinator({ root, executable,
      executableSha256: createHash('sha256').update('#!/bin/sh\nexit 70\n').digest('hex'),
      hostConfig: host, catalog: { ...selected, catalog_version: 'wrong' },
      origin: 'https://synthetic.invalid', botUid: 'bot', recipientId: 'endpoint', botToken: 'bf_synthetic',
      tls: {} as never })).rejects.toThrow('selection');
  });
});
