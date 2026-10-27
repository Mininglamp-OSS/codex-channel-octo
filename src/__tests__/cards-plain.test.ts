/**
 * WP-09 deterministic plain-text representation of a display card: the
 * `plain` fallback sent beside every authored card (AC-010.3).
 *
 * Evidence label: [UNIT]. Pure functions.
 */
import { describe, expect, it } from 'vitest';
import type { DisplayCardArgs } from '../cards/contracts.js';
import { PLAIN_MAX_BYTES, fitPlain, omittedBlocksText, renderDisplayPlain } from '../cards/plain.js';

const bytes = (s: string) => Buffer.byteLength(s, 'utf8');

const KITCHEN_SINK: DisplayCardArgs = {
  title: 'Build report',
  blocks: [
    { kind: 'heading', text: 'Summary', level: 1 },
    { kind: 'text', text: 'All checks passed.\nSecond line.' },
    { kind: 'rich_text', runs: [{ kind: 'strong', text: 'Note:' }, { kind: 'text', text: ' run ' }, { kind: 'code', text: 'npm test' },
      { kind: 'text', text: ' or read ' }, { kind: 'emphasis', text: 'the' }, { kind: 'text', text: ' ' }, { kind: 'link', label: 'docs', url: 'https://example.com/docs' }] },
    { kind: 'facts', items: [{ label: 'Branch', value: 'main' }, { label: 'Commit', value: 'abc' }] },
    { kind: 'columns', columns: [{ blocks: [{ kind: 'text', text: 'left' }] }, { blocks: [{ kind: 'text', text: 'right' }] }] },
    { kind: 'table', headers: ['Name', 'Result'], rows: [['lint', 'ok'], ['test', '']] },
    { kind: 'link', label: 'Open run', url: 'https://example.com/runs/1' },
    { kind: 'group', blocks: [{ kind: 'text', text: 'grouped' }] },
    { kind: 'collapsible', label: 'Details', blocks: [{ kind: 'text', text: 'hidden' }] },
    { kind: 'copy', label: 'Copy command', text: 'npm ci' },
  ],
};

describe('deterministic plain text (AC-010.3)', () => {
  it('renders every block kind in source order with fixed formatting', () => {
    expect(renderDisplayPlain(KITCHEN_SINK)).toBe([
      'Build report',
      '',
      'Summary',
      'All checks passed.',
      'Second line.',
      'Note: run `npm test` or read the docs (https://example.com/docs)',
      'Branch: main',
      'Commit: abc',
      'left',
      'right',
      'Name | Result',
      'lint | ok',
      'test | ',
      'Open run: https://example.com/runs/1',
      'grouped',
      'Details',
      '  hidden',
      'Copy command: npm ci',
    ].join('\n'));
  });

  it('is byte-identical across calls and does not depend on object identity', () => {
    expect(renderDisplayPlain(KITCHEN_SINK)).toBe(renderDisplayPlain(structuredClone(KITCHEN_SINK)));
  });

  it('omits the title separator when there is no title', () => {
    expect(renderDisplayPlain({ blocks: [{ kind: 'text', text: 'only' }] })).toBe('only');
  });

  it('indents nested collapsible content per level', () => {
    expect(renderDisplayPlain({ blocks: [{ kind: 'collapsible', label: 'A', blocks: [{ kind: 'collapsible', label: 'B', blocks: [{ kind: 'text', text: 'x\ny' }] }] }] }))
      .toBe('A\n  B\n    x\n    y');
  });

  it('appends the omission marker for blocks the card could not show', () => {
    expect(omittedBlocksText(1)).toBe('… 1 more block not shown');
    expect(omittedBlocksText(3)).toBe('… 3 more blocks not shown');
    expect(renderDisplayPlain({ blocks: [{ kind: 'text', text: 'a' }] }, { omittedBlocks: 2 })).toBe('a\n… 2 more blocks not shown');
  });

  it('neutralizes mentions defensively', () => {
    expect(renderDisplayPlain({ title: '@all', blocks: [{ kind: 'text', text: '@here' }] })).not.toContain('@');
  });
});

describe('plain fitting', () => {
  it('keeps text within the cap unchanged', () => {
    expect(fitPlain('short', 100)).toBe('short');
  });

  it('drops whole trailing lines and states how many were omitted', () => {
    const text = Array.from({ length: 50 }, (_, i) => `line ${i}`).join('\n');
    const fitted = fitPlain(text, 120);
    expect(bytes(fitted)).toBeLessThanOrEqual(120);
    expect(fitted.startsWith('line 0\nline 1\n')).toBe(true);
    const marker = fitted.split('\n').at(-1)!;
    const shown = fitted.split('\n').length - 1;
    expect(marker).toBe(`… ${50 - shown} more lines not shown`);
  });

  it('truncates a single over-long line on a scalar boundary', () => {
    const fitted = fitPlain('\u{1F600}'.repeat(100), 41);
    expect(bytes(fitted)).toBeLessThanOrEqual(41);
    expect(fitted).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
    expect(fitted.endsWith('…')).toBe(true);
  });

  it('caps the rendered card plain text at PLAIN_MAX_BYTES by default', () => {
    const big: DisplayCardArgs = { blocks: Array.from({ length: 200 }, (_, i) => ({ kind: 'text' as const, text: `${i} ${'x'.repeat(200)}` })) };
    const plain = renderDisplayPlain(big);
    expect(bytes(plain)).toBeLessThanOrEqual(PLAIN_MAX_BYTES);
    expect(plain).toMatch(/… \d+ more lines not shown$/);
  });
});
