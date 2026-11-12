import { createHash } from 'node:crypto';
import { constants, openSync, closeSync, fstatSync, readSync } from 'node:fs';
import { dirname } from 'node:path';
import { canonicalControl, object } from './control-client.js';
import { privateDirectory } from './private-files.js';

export type CatalogFormat = 'permission-release-manifest-v1' | 'permission-catalog-package-v2';
export interface CatalogBootPin {
  readonly catalog_format: CatalogFormat;
  readonly catalog_version: string;
  readonly catalog_digest: string;
}

export function catalogBootPin(value: unknown): Readonly<CatalogBootPin> {
  const pin = object(value, ['catalog_format', 'catalog_version', 'catalog_digest']);
  if (!['permission-release-manifest-v1', 'permission-catalog-package-v2'].includes(String(pin.catalog_format))
    || typeof pin.catalog_version !== 'string' || !/^[\x21-\x7e]{1,64}$/.test(pin.catalog_version)
    || typeof pin.catalog_digest !== 'string' || !/^[0-9a-f]{64}$/.test(pin.catalog_digest)) throw new Error('Catalog boot pin unavailable');
  return Object.freeze({ ...pin }) as unknown as Readonly<CatalogBootPin>;
}

/** Only framing/identity preflight, not a third catalog verifier. Keep inherited
 * values and raw payload strings outside the packaging integer/null domain. */
function identityDocument(bytes: Buffer): Record<string, unknown> {
  if (bytes.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]))) throw new Error('Catalog boot bytes unavailable');
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  let depth = 0;
  let key = true;
  const keys = new Set<string>();
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"') {
      const start = i++;
      for (; i < text.length; i++) {
        if (text[i] === '\\') { i++; continue; }
        if (text[i] === '"') break;
      }
      if (depth === 1 && key) {
        const name = JSON.parse(text.slice(start, i + 1)) as string;
        if (keys.has(name)) throw new Error('Duplicate catalog boot field');
        keys.add(name);
      }
    } else if (ch === '{' || ch === '[') {
      if (++depth > 32) throw new Error('Catalog boot depth exceeded');
    } else if (ch === '}' || ch === ']') depth--;
    else if (depth === 1 && ch === ':') key = false;
    else if (depth === 1 && ch === ',') key = true;
  }
  return object(JSON.parse(text));
}

/** Read the actual selected artifact/manifest through an owned fd. The pinned
 * CLI must independently verify/support the complete package before readiness.
 * No body, catalog capability, cached allow or supported-pin claim escapes. */
export function verifyCatalogBoot(hostConfig: Readonly<Record<string, unknown>>, expected?: Readonly<CatalogBootPin>): Readonly<CatalogBootPin> {
  const selected = expected && catalogBootPin(expected);
  const limit = selected?.catalog_format === 'permission-catalog-package-v2' ? 65536 : 8388608;
  const path = hostConfig.release_path;
  if (typeof path !== 'string' || typeof hostConfig.release_sha256 !== 'string'
    || !/^[0-9a-f]{64}$/.test(hostConfig.release_sha256)
    || selected && selected.catalog_digest !== hostConfig.release_sha256) throw new Error('Catalog boot binding conflict');
  privateDirectory(dirname(path));
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  let bytes: Buffer;
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid!() || (stat.mode & 0o022) !== 0
      || stat.size < 1 || stat.size > limit) throw new Error('Catalog boot file unavailable');
    const storage = Buffer.alloc(limit + 1);
    let length = 0;
    while (length < storage.length) {
      const count = readSync(fd, storage, length, storage.length - length, null);
      if (!count) break;
      length += count;
    }
    if (length !== stat.size || length > limit) throw new Error('Catalog boot file changed');
    bytes = storage.subarray(0, length);
  } finally { closeSync(fd); }
  const digest = createHash('sha256').update(bytes).digest('hex');
  if (digest !== hostConfig.release_sha256) throw new Error('Catalog boot digest conflict');
  const document = identityDocument(bytes);
  const pin = catalogBootPin({ catalog_format: document.format, catalog_version: document.catalog_version, catalog_digest: digest });
  if (document.semantics_version !== '1' || document.contract_revision !== (pin.catalog_format === 'permission-catalog-package-v2' ? 3 : 2)) {
    throw new Error('Catalog boot contract unavailable');
  }
  if (selected && (selected.catalog_format !== pin.catalog_format || selected.catalog_version !== pin.catalog_version)
    || !selected && pin.catalog_format !== 'permission-release-manifest-v1') throw new Error('Explicit catalog boot selection required');
  if (pin.catalog_format === 'permission-catalog-package-v2') {
    object(document, ['format', 'contract_revision', 'catalog_version', 'semantics_version', 'identity_index_sha256',
      'source_heads', 'normalization', 'limits', 'files']);
    // This is the shallow manifest only; profiles/inherited Conditions/raw
    // Roots are not recursively parsed under control/packaging restrictions.
    if (canonicalControl(document) !== bytes.toString('utf8')) throw new Error('Catalog manifest framing conflict');
  }
  return pin;
}
