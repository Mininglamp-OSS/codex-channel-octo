import { constants, closeSync, fstatSync, lstatSync, openSync, readFileSync, readSync } from 'node:fs';
import { dirname, isAbsolute } from 'node:path';
import { createHash } from 'node:crypto';

/** Validate every path component; read through the checked O_NOFOLLOW fd.
 * The worker must additionally be isolated from the host UID/mount namespace. */
export function privateDirectory(path: string): void {
  if (!isAbsolute(path) || typeof process.getuid !== 'function') throw new Error('Private directory unavailable');
  for (let cursor = path; ; cursor = dirname(cursor)) {
    const stat = lstatSync(cursor);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('Private directory unavailable');
    if (cursor === path && (stat.uid !== process.getuid() || (stat.mode & 0o777) !== 0o700)) throw new Error('Private directory unavailable');
    if (dirname(cursor) === cursor) break;
  }
}

export function privateFile(path: string, maxBytes: number): Buffer {
  privateDirectory(dirname(path));
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid!() || (stat.mode & 0o777) !== 0o600
      || stat.size > maxBytes) throw new Error('Private file unavailable');
    const data = Buffer.alloc(maxBytes + 1);
    let length = 0;
    while (length < data.length) {
      const count = readSync(fd, data, length, data.length - length, null);
      if (!count) break;
      length += count;
    }
    if (length > maxBytes || length !== stat.size) throw new Error('Private file unavailable');
    return data.subarray(0, length);
  } finally { closeSync(fd); }
}

export function verifyExecutable(path: string, digest: string): void {
  if (!isAbsolute(path) || !/^[0-9a-f]{64}$/.test(digest)) throw new Error('Pinned executable unavailable');
  // Ancestors must not redirect the named executable. Ownership of the pinned
  // installation is separate from the private host-data directory policy.
  for (let cursor = path; ; cursor = dirname(cursor)) {
    const stat = lstatSync(cursor);
    if (stat.isSymbolicLink() || cursor === path && (!stat.isFile() || (stat.mode & 0o111) === 0)
      || (stat.mode & 0o022) !== 0 && !(cursor !== path && stat.uid === 0 && (stat.mode & 0o1000) !== 0)) {
      throw new Error('Pinned executable unavailable');
    }
    if (dirname(cursor) === cursor) break;
  }
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || createHash('sha256').update(readFileSync(fd)).digest('hex') !== digest) throw new Error('Pinned executable unavailable');
  } finally { closeSync(fd); }
}
