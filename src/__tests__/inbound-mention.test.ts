import { describe, expect, it } from 'vitest';
import { normalizeInboundMention, normalizeMessageId } from '../inbound-mention.js';

describe('transport mention normalization', () => {
  it('unions routing UIDs with independently rendered entity UIDs', () => {
    expect(normalizeInboundMention({ entities: [{ uid: 'other' }], uids: ['bot'] }, 'bot'))
      .toMatchObject({ mentioned_uids: ['other', 'bot'], mention_source: 'entities', is_explicitly_mentioned: true });
  });
  it.each([null, {}, 'bot', Array(129).fill('other')])('drops only the malformed array %j', (invalid) => {
    for (const mention of [
      { entities: invalid, uids: ['bot'] },
      { entities: [{ uid: 'bot' }], uids: invalid },
    ]) {
      expect(normalizeInboundMention({ ...mention, ais: 1, humans: true, all: 1 }, 'bot'))
        .toMatchObject({ mentioned_uids: ['bot'], is_explicitly_mentioned: true,
          mentioned_ais: true, mentioned_humans: true, mentioned_all: true, mention_source: 'invalid' });
    }
  });
  it.each(['uids', 'entities'])('preserves independent broadcast flags when %s is rejected', (field) => {
    expect(normalizeInboundMention({ [field]: Array(129), ais: 1, humans: true, all: 1 }, 'bot'))
      .toMatchObject({ mentioned_uids: [], is_explicitly_mentioned: false, mentioned_ais: true,
        mentioned_humans: true, mentioned_all: true, mention_source: 'invalid' });
  });
  it('deduplicates both lists without mutating them', () => {
    const mention = { entities: [{ uid: 'alice' }, { uid: 'bot' }], uids: ['bot', 'bob', 'alice'] };
    const before = JSON.stringify(mention);
    expect(normalizeInboundMention(mention, 'bot').mentioned_uids).toEqual(['alice', 'bot', 'bob']);
    expect(JSON.stringify(mention)).toBe(before);
  });
  it('bounds escaped UTF-8 snapshot bytes while preserving a late receiving bot', () => {
    const uids = Array.from({ length: 128 }, (_, n) => `${n}-` + '界"\\'.repeat(84));
    const bot = uids.at(-1)!;
    const result = normalizeInboundMention({ uids }, bot);
    expect(result).toMatchObject({ is_explicitly_mentioned: true, mentioned_uids_truncated: true });
    expect(result.mentioned_uids).toContain(bot);
    expect(result.mentioned_uids.length).toBeLessThanOrEqual(32);
    expect(Buffer.byteLength(JSON.stringify(result.mentioned_uids))).toBeLessThanOrEqual(4096);
    expect(result.mentioned_uids.every(uid => uids.includes(uid))).toBe(true);
    expect(normalizeInboundMention({ uids }, 'unmentioned').is_explicitly_mentioned).toBe(false);
  });
  it('keeps membership in either complete input list when their union is truncated', () => {
    const entities = Array.from({ length: 128 }, (_, n) => ({ uid: `entity-${n}` }));
    const uids = Array.from({ length: 128 }, (_, n) => `legacy-${n}`);
    for (const bot of ['entity-127', 'legacy-127']) {
      const result = normalizeInboundMention({ entities, uids }, bot);
      expect(result).toMatchObject({ is_explicitly_mentioned: true, mentioned_uids_truncated: true, mention_source: 'entities' });
      expect(result.mentioned_uids).toHaveLength(32);
      expect(result.mentioned_uids).toContain(bot);
    }
  });
  it('falls back to legacy UIDs only when no usable entity UID exists', () => {
    expect(normalizeInboundMention({ entities: [null, [], {}, { uid: 5 }, { uid: '' }], uids: ['bot'] }, 'bot'))
      .toMatchObject({ mentioned_uids: ['bot'], mention_source: 'uids', is_explicitly_mentioned: true });
  });
  it('deduplicates valid opaque identifiers and ignores malformed entries', () => {
    expect(normalizeInboundMention({ uids: ['张三', 'user+tag@corp', 'bot', 'bot', null, 42, '', 'x\ny'] }, 'bot')
      .mentioned_uids).toEqual(['张三', 'user+tag@corp', 'bot']);
  });
  it.each(['BOT', 'sOther_bot', ' bot', 'bot ', 'e\u0301'])('does not normalize identity %j into the receiving bot', (uid) => {
    expect(normalizeInboundMention({ uids: [uid] }, uid === 'e\u0301' ? 'é' : 'bot').is_explicitly_mentioned).toBe(false);
  });
  it.each([null, 123, [], 'bot', { uids: 'bot' }, { entities: {} }, { entities: null },
    { entities: Array(129).fill({ uid: 'bot' }) },
    { uids: Array(129).fill('bot') },
  ])('fails closed on malformed/oversized containers %j', (mention) => {
    expect(normalizeInboundMention(mention, 'bot')).toEqual({
      bot_uid: 'bot', mentioned_uids: [], mention_source: 'invalid',
      is_explicitly_mentioned: false, mentioned_ais: false, mentioned_humans: false, mentioned_all: false,
    });
  });
  it.each(['uids', 'entities'])('accepts the exact 128-entry %s limit', (field) => {
    const values = Array.from({ length: 128 }, (_, n) => n === 127 ? 'bot' : `user-${n}`);
    const result = normalizeInboundMention({ [field]: field === 'entities' ? values.map((uid) => ({ uid })) : values }, 'bot');
    expect(result.mentioned_uids).toHaveLength(32);
    expect(result.mentioned_uids).toContain('bot');
    expect(result.mentioned_uids_truncated).toBe(true);
    expect(result.is_explicitly_mentioned).toBe(true);
  });
  it('accepts the exact UID limit but rejects longer identifiers', () => {
    const uid = 'x'.repeat(256);
    expect(normalizeInboundMention({ uids: [uid] }, uid).is_explicitly_mentioned).toBe(true);
    expect(normalizeInboundMention({ uids: [uid + 'x'] }, uid + 'x')).toMatchObject({ bot_uid: null, mentioned_uids: [] });
  });
  it.each(['\u0000', '\u001f', '\u007f', '\u0085', '\u009f', '\u2028', '\u2029'])('ignores control/line separators in entity and legacy UIDs: %j', (separator) => {
    for (const mention of [{ entities: [{ uid: 'bot' + separator }] }, { uids: ['bot' + separator] }]) {
      expect(normalizeInboundMention(mention, 'bot')).toMatchObject({ mentioned_uids: [], is_explicitly_mentioned: false });
    }
  });
  it.each(['', null, undefined, 1, {}, 'x'.repeat(257), 'bot\u0000', 'bot\u007f',
    'bot\u0085', 'bot\u2028', 'bot\u2029'])('fails closed for invalid runtime bot UID %j', (bot) => {
    expect(normalizeInboundMention({ uids: ['bot'], ais: 1 }, bot)).toMatchObject({ bot_uid: null, is_explicitly_mentioned: false });
  });
  it.each([true, 1, false, 0, 2, -1, 'true', 'false', '1', {}, [], null, undefined])('parses broadcast flags strictly: %j', (value) => {
    const result = normalizeInboundMention({ ais: value, humans: value, all: value }, 'bot');
    const enabled = value === true || value === 1;
    expect(result).toMatchObject({ mentioned_ais: enabled, mentioned_humans: enabled, mentioned_all: enabled,
      is_explicitly_mentioned: false, mentioned_uids: [], mention_source: 'none' });
  });
  it('does not retain references to a mutable input or share empty arrays across calls', () => {
    const uids = ['bot'];
    const before = normalizeInboundMention({ uids }, 'bot');
    uids[0] = 'other';
    expect(before.mentioned_uids).toEqual(['bot']);
    const empty = normalizeInboundMention(undefined, 'bot');
    empty.mentioned_uids.push('forged');
    expect(normalizeInboundMention(undefined, 'bot').mentioned_uids).toEqual([]);
  });
  it('bounds message IDs without stringifying other types', () => {
    expect(normalizeMessageId('m'.repeat(512))).toHaveLength(512);
    for (const id of ['m'.repeat(513), '', null, 123, {}, 'id\nforged', 'id\u2028forged']) {
      expect(normalizeMessageId(id)).toBeNull();
    }
  });
});
