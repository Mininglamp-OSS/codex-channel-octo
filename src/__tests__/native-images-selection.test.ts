import { describe, expect, it } from 'vitest';
import { OutputCollector } from '../output-selection.js';

const envelope = (requestId = 'current') => JSON.stringify({ octo_output: 1, requestId,
  text: 'Here are your images.', artifacts: [{ id: 'one', kind: 'image', path: '画.png', disposition: 'relay' }] });
function collect(text: string, terminal: 'completed' | 'no_terminal' = 'completed') {
  const c = new OutputCollector();
  c.push({ kind: 'attempt_start', attempt: 1, continues: null, reason: 'initial' });
  c.push({ kind: 'message', attempt: 1, itemId: 'final', seq: 1, phase: 'final_answer', text });
  c.push({ kind: 'attempt_end', attempt: 1, terminal });
  return c;
}
describe('explicit final image envelope', () => {
  it('extracts only a bound envelope before capping visible text', () => {
    const selected = collect(envelope()).select({ mode: 'final', maxChars: 4, artifactRequestId: 'current' });
    expect(selected.text).toBe('Here');
    expect(selected.artifacts).toHaveLength(1);
    expect(selected.artifacts[0].path).toBe('画.png');
  });
  it('does not scan paths, markdown or URLs', () => {
    const text = '/tmp/x.png ![x](file:///tmp/y.png) https://example.com/z.png';
    expect(collect(text).select({ mode: 'final', maxChars: 1000, artifactRequestId: 'current' })).toMatchObject({ text, artifacts: [] });
  });
  it('rejects stale, partial and disabled envelopes', () => {
    expect(collect(envelope('old')).select({ mode: 'final', maxChars: 1000, artifactRequestId: 'current' }).artifacts).toEqual([]);
    expect(collect(envelope(), 'no_terminal').select({ mode: 'final', maxChars: 1000, artifactRequestId: 'current' }).artifacts).toEqual([]);
    expect(collect(envelope()).select({ mode: 'final', maxChars: 1000 }).text).toBe(envelope());
  });
  it('never delivers artifacts from unselected commentary', () => {
    const c = collect(envelope());
    c.push({ kind: 'message', attempt: 1, itemId: 'final', seq: 1, phase: 'commentary', text: envelope() });
    c.push({ kind: 'message', attempt: 1, itemId: 'answer', seq: 2, phase: 'final_answer', text: 'No image requested.' });
    expect(c.select({ mode: 'final', maxChars: 1000, artifactRequestId: 'current' })).toMatchObject({ text: 'No image requested.', artifacts: [] });
  });
  it('rejects too many images and duplicate artifact IDs atomically', () => {
    const base = JSON.parse(envelope());
    base.artifacts.push(base.artifacts[0]);
    expect(collect(JSON.stringify(base)).select({ mode: 'final', maxChars: 1000, artifactRequestId: 'current' }).artifacts).toEqual([]);
    base.artifacts = Array.from({ length: 5 }, (_, i) => ({ ...base.artifacts[0], id: `id${i}` }));
    expect(collect(JSON.stringify(base)).select({ mode: 'final', maxChars: 1000, artifactRequestId: 'current' }).artifacts).toEqual([]);
  });
  it.each(['```json\n' + envelope() + '\n```', '{"octo_output":1,', envelope() + '\n' + envelope()])('RVW-2: hides malformed/fenced/joined protocol text', text => {
    const selected = collect(text).select({ mode: 'final', maxChars: 1000, artifactRequestId: 'current' });
    expect(selected.artifacts).toEqual([]);
    expect(selected.text).toBe('[Image generation: invalid or stale artifact envelope; no images sent.]');
  });
  it('RVW-2: does not decode JSON assembled from multiple selected final messages', () => {
    const c = collect('{"octo_output":1,"requestId":"current",');
    c.push({ kind: 'message', attempt: 1, itemId: 'part2', seq: 2, phase: 'final_answer',
      text: '"text":"hello","artifacts":[{"id":"one","kind":"image","path":"x.png","disposition":"relay"}]}' });
    const selected = c.select({ mode: 'final', maxChars: 1000, artifactRequestId: 'current' });
    expect(selected.artifacts).toEqual([]);
    expect(selected.text).toContain('invalid or stale artifact envelope');
  });
});
