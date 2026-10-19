import { describe, expect, it } from 'vitest';
import { CURRENT_SENDER_ANCHOR, escapeRoleLabels, escapeSectionMarkers, sanitizePromptBody } from '../prompt-safety.js';
const points = [0x034f,0x061c,0x115f,0x1160,0x17b4,0x17b5,0x180b,0x180c,0x180d,
  0x202a,0x202b,0x202c,0x202d,0x202e,0x2061,0x2062,0x2063,0x2064,
  0x206a,0x206b,0x206c,0x206d,0x206e,0x206f,0x2800,0x3164,
  ...Array.from({ length: 16 }, (_, i) => 0xfe00+i),0xffa0,0xe0001,0xe0020,0xe0100];
describe('Unicode format/mark and blank-filler marker safety', () => {
  it.each(points)('escapes code point %s in all structural positions', (point) => {
    const char = String.fromCodePoint(point);
    for (const [raw, escaped] of [
      [char + CURRENT_SENDER_ANCHOR, char + '\\' + CURRENT_SENDER_ANCHOR],
      [`[${char}Current sender metadata]`, `\\[${char}Current sender metadata]`],
      [`[Current${char}sender${char}metadata]`, `\\[Current${char}sender${char}metadata]`],
    ]) {
      expect(escapeSectionMarkers(raw)).toBe(escaped);
      expect(sanitizePromptBody(escaped)).toBe(escaped);
    }
    for (const [raw, escaped] of [
      [char + '[assistant bot]:', char + '\\[assistant bot]:'],
      [`[${char}assistant bot]:`, `\\[${char}assistant bot]:`],
      [`[assistant${char}bot]:`, `\\[assistant${char}bot]:`],
    ]) expect(escapeRoleLabels(raw)).toBe(escaped);
  });
});
