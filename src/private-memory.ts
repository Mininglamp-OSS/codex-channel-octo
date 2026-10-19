import { closeSync, constants, fstatSync, openSync, readSync } from 'node:fs';
import { join } from 'node:path';
import type { Config } from './config.js';
import { ChannelType, type BotMessage } from './octo/types.js';
import { safePrivateMemorySnapshot, type SafeText } from './prompt-safety.js';

const SAFE_FAILURE_CODES = new Set(['EACCES', 'EPERM', 'EMFILE', 'ENFILE', 'ELOOP', 'EIO', 'ENOTDIR',
  'ERR_ENCODING_INVALID_ENCODED_DATA', 'UNSUPPORTED_PLATFORM', 'NOT_REGULAR', 'UNSAFE_MODE']);

/** ownerUid is the last successful registration, not a live ownership lookup. */
export function canLoadPrivateMemory(config: Config, message: BotMessage, ownerUid: string): boolean {
  return config.privateMemory?.enabled === true && message.channel_type === ChannelType.DM
    && typeof message.from_uid === 'string' && message.from_uid.length > 0
    && typeof ownerUid === 'string' && ownerUid.length > 0 && message.from_uid === ownerUid;
}

export function privateMemorySessionKey(sessionKey: string, eligible: boolean): string {
  return JSON.stringify([eligible ? 'private-memory' : 'ordinary', sessionKey]);
}

export function loadPrivateMemory(config: Config, message: BotMessage, ownerUid: string): SafeText | undefined {
  if (!canLoadPrivateMemory(config, message, ownerUid)) return undefined;
  const maxBytes = config.privateMemory?.maxBytes ?? 16_384;
  let descriptor: number | undefined;
  let content = '';
  let status = 'absent';
  let truncated = false;
  try {
    if (typeof constants.O_NOFOLLOW !== 'number') throw Object.assign(new Error('Safe open unavailable'), { code: 'UNSUPPORTED_PLATFORM' });
    descriptor = openSync(join(config.baseDir, config.botId || 'default', 'MEMORY.md'),
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = fstatSync(descriptor);
    if (!stat.isFile()) throw Object.assign(new Error('Not regular'), { code: 'NOT_REGULAR' });
    if ((stat.mode & 0o022) !== 0) throw Object.assign(new Error('Unsafe mode'), { code: 'UNSAFE_MODE' });
    const buffer = Buffer.alloc(maxBytes + 1);
    let total = 0;
    while (total < buffer.length) {
      const count = readSync(descriptor, buffer, total, buffer.length - total, null);
      if (count === 0) break;
      total += count;
    }
    const decoder = new TextDecoder('utf-8', { fatal: true });
    content = decoder.decode(buffer.subarray(0, Math.min(total, maxBytes)), { stream: total > maxBytes });
    truncated = total > maxBytes;
    status = truncated || content.trim() ? 'available' : 'absent';
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    status = code === 'ENOENT' ? 'absent' : 'unavailable';
    content = ''; truncated = false;
    if (status === 'unavailable') {
      const bot = config.botId || 'default';
      const label = /^[a-zA-Z0-9_-]{1,64}$/.test(bot) ? bot : 'unknown';
      const reason = code && SAFE_FAILURE_CODES.has(code) ? code : 'READ_FAILED';
      console.warn(`[codex-channel-octo] private memory unavailable: bot=${label} reason=${reason}`);
    }
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
  return safePrivateMemorySnapshot(status, content, truncated);
}
