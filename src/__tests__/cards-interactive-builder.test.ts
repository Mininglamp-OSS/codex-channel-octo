import { describe, expect, it } from 'vitest';
import { buildInteractiveCard } from '../cards/interactive-builder.js';
import { validateInteractiveArgs } from '../cards/interactive-schema.js';
import { normalizeLimits } from '../cards/limits.js';

const args = { title: 'Decide', inputs: [{ id: 'c', kind: 'choice' as const, label: 'Pick', required: true, multiple: false, min: 1, max: 1, options: [{ id: 'a', label: 'Alpha' }] }], buttons: [{ id: 'ok', label: 'Continue' }] };
const caps = { inputs: new Set(['choice'] as const), limits: normalizeLimits(undefined).limits };
const route = { channelId: 'group', channelType: 2 as const };
describe('interactive builder', () => {
  it('preserves distinct submitted IDs and ordered visible choices in controls and plain text', () => {
    const schema = validateInteractiveArgs({ ...args, inputs: [{ ...args.inputs[0], options: [
      { id: 'A', label: 'www.example.com' }, { id: 'a', label: 'www.other.com' },
    ] }] });
    expect(schema.ok).toBe(true);
    if (!schema.ok) throw new Error('schema');
    const r = buildInteractiveCard(schema.value, { caps, route });
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error('build');
    expect(r.authored.card.body.find(e => e.type === 'Input.ChoiceSet')).toMatchObject({ choices: [
      { title: 'www[.]example.com', value: 'A' }, { title: 'www[.]other.com', value: 'a' },
    ] });
    expect(r.plain.split('\n')).toEqual(['Decide', 'For the original requester', 'Pick (choice, Required)', 'Selections: 1–1',
      'www[.]example.com', 'www[.]other.com', 'Continue', 'Respond using a card-capable client; this text does not submit a response.']);
  });
  it('keeps every control and provides ordered nonactionable plain text', () => {
    const schema = validateInteractiveArgs(args);
    if (!schema.ok) throw new Error('schema');
    const r = buildInteractiveCard(schema.value, { caps, route });
    expect(r).toMatchObject({ ok: true, authored: { profile: 'octo/v2', card: { actions: [{ type: 'Action.Submit', id: 'ok', title: 'Continue' }] } } });
    if (!r.ok) return;
    expect(r.plain).toContain('For the original requester');
    expect(r.plain).toContain('Pick (choice, Required)');
    expect(r.plain).toContain('Alpha');
    expect(r.plain.endsWith('Respond using a card-capable client; this text does not submit a response.')).toBe(true);
  });
  it('rejects unsupported input and every independently narrowed fit bound', () => {
    expect(buildInteractiveCard(args, { caps: { ...caps, inputs: new Set() }, route })).toMatchObject({ ok: false, error: { code: 'unavailable' } });
    for (const limits of [{ maxNodes: 3 }, { maxDepth: 1 }, { maxPayloadBytes: 200 }]) {
      expect(buildInteractiveCard(args, { caps: { ...caps, limits: { ...caps.limits, ...limits } }, route })).toMatchObject({ ok: false, error: { code: 'limit_exceeded' } });
    }
  });
});
