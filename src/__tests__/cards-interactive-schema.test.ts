import { describe, expect, it } from 'vitest';
import { validateInteractiveArgs } from '../cards/interactive-schema.js';

const base = { title: 'Decide', buttons: [{ id: 'ok', label: 'Continue' }] };
describe('interactive author grammar', () => {
  it.each([
    ['www.example.com', 'www[.]example.com'],
    ['https://example.com', 'https[:]//example.com'],
    ['x](y)', 'x] (y)'],
    ['x][y]', 'x] [y]'],
    ['e\u0301', 'é'],
    ['A\u200b', 'A'],
    ['@all', '＠all'],
  ])('rejects choice labels that collide after visible sanitation: %j / %j', (first, second) => {
    const r = validateInteractiveArgs({ ...base, inputs: [{ id: 'pick', kind: 'choice', label: 'Pick', required: true, multiple: false, min: 1, max: 1,
      options: [{ id: 'a', label: first }, { id: 'b', label: second }] }] });
    expect(r).toEqual({ ok: false, error: { code: 'validation_failed', diagnostics: [{ path: '$.inputs[0].options[1].label', rule: 'label_duplicate' }] } });
  });
  it('keeps label uniqueness scoped to each choice input', () => {
    const choice = { kind: 'choice' as const, label: 'Pick', required: true, multiple: false, min: 1, max: 1,
      options: [{ id: 'a', label: 'www.example.com' }, { id: 'b', label: 'www.other.com' }] };
    expect(validateInteractiveArgs({ ...base, inputs: [{ ...choice, id: 'first' }, { ...choice, id: 'second' }] }).ok).toBe(true);
  });
  it('normalizes and freezes literal labels without losing decisions', () => {
    const r = validateInteractiveArgs({ ...base, title: '  Cafe\u0301 @all  ' });
    expect(r).toMatchObject({ ok: true, value: { title: 'Café ＠all' } });
    if (r.ok) expect(Object.isFrozen(r.value.buttons)).toBe(true);
  });
  it.each([
    { ...base, buttons: [] },
    { ...base, buttons: [{ id: 'reasoning_stop', label: 'Stop' }] },
    { ...base, buttons: [{ id: 'ok', label: ' ' }] },
    { ...base, buttons: [{ id: 'ok', label: 'x'.repeat(81) }] },
    { ...base, buttons: [{ id: 'ok', label: 'x' }, { id: 'ok', label: 'y' }] },
    { ...base, inputs: [{ id: 'a', kind: 'number', label: 'n', required: true, min: 2, max: 1 }] },
    { ...base, inputs: [{ id: 'a', kind: 'choice', label: 'c', required: false, multiple: false, min: 1, max: 1, options: [{ id: 'a', label: 'a' }] }] },
    { ...base, inputs: [{ id: 'a', kind: 'choice', label: 'c', required: true, multiple: false, min: 1, max: 1, options: [{ id: 'a', label: 'é' }, { id: 'b', label: ' e\u0301 ' }] }] },
    { ...base, sections: Array.from({ length: 21 }, () => ({ text: 'section' })) },
    { ...base, title: '\ud800' },
    { ...base, buttons: [{ id: '__proto__', label: 'x' }] },
    { ...base, buttons: [{ id: 'ghp_AbcDef1234567890', label: 'x' }] },
    { ...base, buttons: Array.from({ length: 7 }, (_, i) => ({ id: `b${i}`, label: 'x' })) },
    { ...base, inputs: Array.from({ length: 6 }, (_, i) => ({ id: `i${i}`, kind: 'toggle', label: 'x', required: false })) },
    { ...base, buttons: [{ id: 'ok', label: 'x', data: { reasoning_stop: 'no' } }] },
    { ...base, buttons: [{ id: 'ok', label: 'x', data: { value: 'a'.repeat(2048) } }] },
    { ...base, buttons: [{ id: 'ok', label: 'x', data: { token: 'secret' } }] },
  ])('rejects an invalid decision without echoing authored content', args => {
    const r = validateInteractiveArgs(args as never);
    expect(r.ok).toBe(false);
    expect(JSON.stringify(r)).not.toContain('secret');
  });
  it('rejects routing and unknown fields at every depth', () => {
    expect(validateInteractiveArgs({ ...base, channel_id: 'victim' } as never)).toMatchObject({ ok: false, error: { code: 'invalid_route' } });
    expect(validateInteractiveArgs({ ...base, extra: 'value' } as never)).toMatchObject({ ok: false, error: { code: 'validation_failed' } });
  });
  it('preserves empty/whitespace application strings and checks normalized aggregate data bytes', () => {
    const data = { empty: '', spaces: '  ', flags: [null, false, 0] };
    expect(validateInteractiveArgs({ ...base, buttons: [{ id: 'ok', label: 'Continue', data }] })).toMatchObject({ ok: true, value: { buttons: [{ data }] } });
    expect(validateInteractiveArgs({ ...base, buttons: [{ id: 'ok', label: 'Continue', data: { text: '@'.repeat(1000) } }] })).toMatchObject({ ok: false, error: { code: 'limit_exceeded' } });
  });
});
