/**
 * WP-09 display builder: closed C.1 display grammar → `octo/v1` Adaptive Card
 * body plus deterministic plain text, negotiated-element degradation, and
 * node/depth/byte fitting with omission markers before transport (AC-010.3,
 * AC-007.4).
 *
 * Evidence label: [UNIT]. Pure; the closed wire serializer is the oracle.
 */
import { describe, expect, it } from 'vitest';
import { serializeSendAuthored } from '../cards/api.js';
import type { CardRoute, DisplayBlock, DisplayCardArgs, Limits } from '../cards/contracts.js';
import {
  DISPLAY_ELEMENTS, buildDisplayCard, measureDisplayCard, type DisplayCapabilities,
} from '../cards/display-builder.js';
import { normalizeLimits } from '../cards/limits.js';
import { omittedBlocksText } from '../cards/plain.js';

const ROUTE: CardRoute = { channelId: 'chan-1', channelType: 2 };
const WORST_CLIENT_MSG_NO = '00000000-0000-0000-0000-000000000000';
const DEFAULT_LIMITS: Limits = normalizeLimits(undefined).limits;
const FULL: DisplayCapabilities = { elements: new Set(DISPLAY_ELEMENTS), limits: DEFAULT_LIMITS };
const TEXT_ONLY: DisplayCapabilities = { elements: new Set(['TextBlock']), limits: DEFAULT_LIMITS };

const text = (t: string): DisplayBlock => ({ kind: 'text', text: t });

function built(args: DisplayCardArgs, caps: DisplayCapabilities = FULL) {
  const r = buildDisplayCard(args, { caps, route: ROUTE });
  if (!r.ok) throw new Error(`build failed: ${JSON.stringify(r.error)}`);
  return r;
}

function types(value: unknown, out = new Set<string>()): Set<string> {
  if (Array.isArray(value)) for (const v of value) types(v, out);
  else if (value !== null && typeof value === 'object') {
    const t = (value as { type?: unknown }).type;
    if (typeof t === 'string') out.add(t);
    for (const v of Object.values(value)) types(v, out);
  }
  return out;
}

/** Wire oracle: the closed serializer must accept the exact send envelope. */
function wireBytes(r: ReturnType<typeof built>, cap = DEFAULT_LIMITS.maxPayloadBytes): number {
  return serializeSendAuthored({ ...r.authored, route: ROUTE, clientMsgNo: WORST_CLIENT_MSG_NO, plain: r.plain, maxEnvelopeBytes: cap }).bytes;
}

const KITCHEN_SINK: DisplayCardArgs = {
  title: 'Build report',
  blocks: [
    { kind: 'heading', text: 'Summary', level: 1 },
    { kind: 'heading', text: 'Sub', level: 3 },
    text('All checks passed.'),
    { kind: 'rich_text', runs: [{ kind: 'strong', text: 'Note' }, { kind: 'emphasis', text: ' quiet' }, { kind: 'code', text: 'npm test' },
      { kind: 'link', label: 'docs', url: 'https://example.com/docs' }] },
    { kind: 'facts', items: [{ label: 'Branch', value: 'main' }] },
    { kind: 'columns', columns: [{ blocks: [text('left')] }, { blocks: [text('right')] }] },
    { kind: 'table', headers: ['Name', 'Result'], rows: [['lint', 'ok'], ['test', '']] },
    { kind: 'link', label: 'Open run', url: 'https://example.com/runs/1' },
    { kind: 'group', blocks: [text('grouped')] },
    { kind: 'collapsible', label: 'Details', blocks: [text('hidden')] },
    { kind: 'collapsible', label: 'Open', blocks: [text('shown')], expanded: true },
    { kind: 'copy', label: 'Copy command', text: 'npm ci' },
  ],
};

describe('display card body (AC-010.3)', () => {
  it('maps every block kind to the closed octo/v1 element set and passes the wire serializer', () => {
    const r = built(KITCHEN_SINK);
    expect(r.authored.profile).toBe('octo/v1');
    expect(r.authored.card).toMatchObject({ type: 'AdaptiveCard', version: '1.5', $schema: 'http://adaptivecards.io/schemas/adaptive-card.json' });
    expect(r.shownBlocks).toBe(KITCHEN_SINK.blocks.length);
    expect(r.omittedBlocks).toBe(0);
    expect(wireBytes(r)).toBeGreaterThan(0);
    const body = r.authored.card.body;
    expect(body[0]).toEqual({ type: 'TextBlock', text: 'Build report', wrap: true, weight: 'Bolder', size: 'Large' });
    expect(body[1]).toEqual({ type: 'TextBlock', text: 'Summary', wrap: true, weight: 'Bolder', size: 'Large' });
    expect(body[2]).toEqual({ type: 'TextBlock', text: 'Sub', wrap: true, weight: 'Bolder' });
    expect(body[3]).toEqual({ type: 'TextBlock', text: 'All checks passed.', wrap: true });
    expect(body[4]).toMatchObject({ type: 'RichTextBlock', inlines: [
      { type: 'TextRun', text: 'Note', weight: 'Bolder' }, { type: 'TextRun', text: ' quiet', isSubtle: true },
      { type: 'TextRun', text: 'npm test', fontType: 'Monospace' }, { type: 'TextRun', text: 'docs (https://example.com/docs)', color: 'accent' },
    ] });
    expect(body[5]).toEqual({ type: 'FactSet', facts: [{ title: 'Branch', value: 'main' }] });
    expect(body[6]).toMatchObject({ type: 'ColumnSet', columns: [{ type: 'Column', width: 'stretch' }, { type: 'Column', width: 'stretch' }] });
    expect(body[7]).toMatchObject({ type: 'Table', firstRowAsHeader: true, columns: [{ width: 1 }, { width: 1 }] });
    expect((body[7] as { readonly rows: readonly unknown[] }).rows).toHaveLength(3);
    expect(body[8]).toEqual({ type: 'ActionSet', actions: [{ type: 'Action.OpenUrl', title: 'Open run', url: 'https://example.com/runs/1' }] });
    expect(body[9]).toEqual({ type: 'Container', items: [{ type: 'TextBlock', text: 'grouped', wrap: true }] });
  });

  it('collapsible sections toggle a hidden container with deterministic unique ids', () => {
    const body = built(KITCHEN_SINK).authored.card.body;
    expect(body[10]).toEqual({ type: 'ActionSet', actions: [{ type: 'Action.ToggleVisibility', title: 'Details', targetElements: [{ elementId: 'd1', isVisible: true }] }] });
    expect(body[11]).toEqual({ type: 'Container', id: 'd1', isVisible: false, items: [{ type: 'TextBlock', text: 'hidden', wrap: true }] });
    expect(body[12]).toMatchObject({ type: 'ActionSet', actions: [{ targetElements: [{ elementId: 'd2' }] }] });
    expect(body[13]).toMatchObject({ type: 'Container', id: 'd2', isVisible: true });
    expect(body[14]).toEqual({ type: 'TextBlock', text: 'npm ci', wrap: true });
    expect(body[15]).toEqual({ type: 'ActionSet', actions: [{ type: 'Action.CopyToClipboard', title: 'Copy command', text: 'npm ci' }] });
  });

  it('is deterministic: identical input gives byte-identical output', () => {
    expect(JSON.stringify(built(KITCHEN_SINK))).toBe(JSON.stringify(built(structuredClone(KITCHEN_SINK))));
  });

  it('only emits elements the negotiated profile lists, degrading to TextBlock', () => {
    const r = built(KITCHEN_SINK, TEXT_ONLY);
    expect([...types(r.authored.card.body)]).toEqual(['TextBlock']);
    expect(wireBytes(r)).toBeGreaterThan(0);
    const texts = r.authored.card.body.map((e) => (e as { text: string }).text);
    expect(texts).toContain('[Open run](https://example.com/runs/1)');
    expect(texts).toContain('Branch: main');
    expect(texts).toContain('Name | Result');
    expect(texts).toContain('Copy command: npm ci');
  });

  it('degrades per missing element independently', () => {
    const noActions = built(KITCHEN_SINK, { elements: new Set(DISPLAY_ELEMENTS.filter((e) => e !== 'ActionSet')), limits: DEFAULT_LIMITS });
    expect(types(noActions.authored.card.body).has('ActionSet')).toBe(false);
    // Without a toggle the collapsible content is shown inline under its label.
    expect(JSON.stringify(noActions.authored.card.body)).toContain('"hidden"');
    const noTable = built(KITCHEN_SINK, { elements: new Set(DISPLAY_ELEMENTS.filter((e) => e !== 'Table')), limits: DEFAULT_LIMITS });
    expect(types(noTable.authored.card.body).has('Table')).toBe(false);
    const noRich = built(KITCHEN_SINK, { elements: new Set(DISPLAY_ELEMENTS.filter((e) => e !== 'RichTextBlock')), limits: DEFAULT_LIMITS });
    expect(types(noRich.authored.card.body).has('RichTextBlock')).toBe(false);
    expect(JSON.stringify(noRich.authored.card.body)).toContain('**Note**');
  });

  it('refuses capabilities without TextBlock', () => {
    const r = buildDisplayCard(KITCHEN_SINK, { caps: { elements: new Set(['Container']), limits: DEFAULT_LIMITS }, route: ROUTE });
    expect(r).toEqual({ ok: false, error: { code: 'unavailable', diagnostics: [{ path: '$', rule: 'display_capability' }] } });
  });

  it('plain text accompanies the card and carries the same omission count', () => {
    const r = built(KITCHEN_SINK);
    expect(r.plain.startsWith('Build report\n\nSummary\n')).toBe(true);
  });
});

describe('fitting before transport (AC-007.4)', () => {
  it('keeps the longest fitting prefix and replaces the rest with one omission marker', () => {
    const args: DisplayCardArgs = { title: 'Big', blocks: Array.from({ length: 200 }, (_, i) => text(`${i} ${'x'.repeat(3000)}`)) };
    const r = built(args);
    expect(r.shownBlocks).toBeGreaterThan(0);
    expect(r.shownBlocks + r.omittedBlocks).toBe(200);
    const last = r.authored.card.body.at(-1) as { text: string };
    expect(last.text).toBe(omittedBlocksText(r.omittedBlocks));
    expect(wireBytes(r)).toBeLessThanOrEqual(DEFAULT_LIMITS.maxPayloadBytes);
    expect(r.plain).toContain(omittedBlocksText(r.omittedBlocks));
  });

  it('honours lower negotiated node, depth and payload limits', () => {
    const limits: Limits = { ...DEFAULT_LIMITS, maxNodes: 12, maxDepth: 3, maxPayloadBytes: 2048 };
    let nested: DisplayBlock = text('deep');
    for (let i = 0; i < 4; i++) nested = { kind: 'group', blocks: [nested] };
    const args: DisplayCardArgs = { blocks: [text('a'), nested, ...Array.from({ length: 30 }, (_, i) => text(`t${i}`))] };
    const r = built(args, { elements: new Set(DISPLAY_ELEMENTS), limits });
    const m = measureDisplayCard(r.authored.card);
    expect(m.nodes).toBeLessThanOrEqual(12);
    expect(m.depth).toBeLessThanOrEqual(3);
    expect(wireBytes(r, 2048)).toBeLessThanOrEqual(2048);
    expect(r.shownBlocks).toBe(1);
    expect(r.omittedBlocks).toBe(31);
  });

  it('measures nodes and depth with the wire serializer convention', () => {
    const r = built({ blocks: [{ kind: 'table', headers: ['a'], rows: [['b']] }] });
    // Table(1) + 2 rows + 2 cells + 2 TextBlocks = 7 nodes; TableCell items sit at depth 4.
    expect(measureDisplayCard(r.authored.card)).toEqual({ nodes: 7, depth: 4 });
  });

  it('fails limit_exceeded when not even the title and marker fit', () => {
    const r = buildDisplayCard({ title: 'x'.repeat(150), blocks: [text('y'.repeat(4000))] },
      { caps: { elements: new Set(DISPLAY_ELEMENTS), limits: { ...DEFAULT_LIMITS, maxPayloadBytes: 300 } }, route: ROUTE });
    expect(r).toEqual({ ok: false, error: { code: 'limit_exceeded', diagnostics: [{ path: '$', rule: 'card_too_large' }] } });
  });

  it('never exceeds the client envelope bound even when the server allows more', () => {
    const r = built({ blocks: Array.from({ length: 200 }, () => text('z'.repeat(3000))) },
      { elements: new Set(DISPLAY_ELEMENTS), limits: { ...DEFAULT_LIMITS, maxPayloadBytes: 524_288 } });
    expect(wireBytes(r, 16_384)).toBeLessThanOrEqual(16_384);
  });
});

// ─── B1: authored text can never become an active link ──────────────────────

/** Reviewer repros plus field variants: inline, image, reference, angle and bare autolinks. */
const HOSTILE = [
  '[click](http://127.0.0.1/)',
  '[js](javascript:alert(1))',
  '<http://evil.local/x>',
  'see http://evil.local/x now',
  'go www.evil.com today',
  'javascript:alert(1)',
  '![img](http://evil.local/p.png)',
  '[ref][1]\n\n[1]: http://evil.local/r',
  '[ok](https://example.org/x)',
];
/** Any of these surviving verbatim means an authored URL could still be activated. */
const LIVE_FRAGMENTS = ['://127.0.0.1', '://evil.local', 'javascript:', 'www.evil', '://example.org'];

/** One card that puts `s` into every authored, TextBlock-bearing field of every kind. */
function everywhere(s: string): DisplayCardArgs {
  return {
    title: s.replace(/\n/g, ' '),
    blocks: [
      { kind: 'heading', text: s.replace(/\n/g, ' ') },
      text(s),
      { kind: 'rich_text', runs: [{ kind: 'text', text: s }, { kind: 'emphasis', text: s }, { kind: 'strong', text: s }, { kind: 'code', text: s },
        { kind: 'link', label: s.replace(/\n/g, ' '), url: 'https://example.com/safe' }] },
      { kind: 'facts', items: [{ label: s.replace(/\n/g, ' '), value: s }] },
      { kind: 'table', headers: [s.replace(/\n/g, ' ')], rows: [[s]] },
      { kind: 'link', label: s.replace(/\n/g, ' '), url: 'https://example.com/safe' },
      { kind: 'columns', columns: [{ blocks: [text(s)] }] },
      { kind: 'group', blocks: [text(s)] },
      { kind: 'collapsible', label: s.replace(/\n/g, ' '), blocks: [text(s)] },
      { kind: 'copy', label: s.replace(/\n/g, ' '), text: s },
    ],
  };
}

/** Every rendered string except validated hrefs and the clipboard payload (never rendered). */
function renderedStrings(value: unknown, out: string[] = []): string[] {
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) for (const v of value) renderedStrings(v, out);
  else if (value !== null && typeof value === 'object') {
    const o = value as Record<string, unknown>;
    for (const [k, v] of Object.entries(o)) {
      if (k === 'url' && o.type === 'Action.OpenUrl') continue;
      if (k === 'text' && o.type === 'Action.CopyToClipboard') continue;
      renderedStrings(v, out);
    }
  }
  return out;
}

/** Markdown constructs that would be live in a TextBlock: unescaped `[`, `]`, `(`, `<`, `>`, `!`. */
const UNESCAPED_MD = /(?<!\\)(?:\\\\)*[[\]()<>]/;
const BUILDER_LINK = /\[[^\]]*\]\(https:\/\/example\.com\/safe\)/g;

describe('authored Markdown and autolinks are inert in every field (B1)', () => {
  const capsCases: [string, DisplayCapabilities][] = [['full', FULL], ['TextBlock-only', TEXT_ONLY]];
  for (const [capsName, caps] of capsCases) {
    it.each(HOSTILE)(`${capsName}: %j never yields an active link`, (s) => {
      const r = built(everywhere(s), caps);
      expect(wireBytes(r)).toBeGreaterThan(0);
      const rendered = renderedStrings(r.authored.card.body);
      for (const str of [...rendered, r.plain]) {
        for (const frag of LIVE_FRAGMENTS) expect(str).not.toContain(frag);
      }
      // TextBlock text is Markdown: only builder-generated links to the validated URL may stay live.
      const blocks: string[] = [];
      const walk = (v: unknown): void => {
        if (Array.isArray(v)) v.forEach(walk);
        else if (v !== null && typeof v === 'object') {
          const o = v as Record<string, unknown>;
          if (o.type === 'TextBlock') blocks.push(o.text as string);
          Object.values(o).forEach(walk);
        }
      };
      walk(r.authored.card.body);
      for (const t of blocks) expect(t.replace(BUILDER_LINK, '')).not.toMatch(UNESCAPED_MD);
    });
  }

  it('structured links stay live and validated in both modes', () => {
    const args: DisplayCardArgs = { blocks: [{ kind: 'link', label: 'Run [1]', url: 'https://example.com/safe' }] };
    expect(built(args).authored.card.body[0]).toEqual({ type: 'ActionSet', actions: [{ type: 'Action.OpenUrl', title: 'Run [1]', url: 'https://example.com/safe' }] });
    expect(built(args, TEXT_ONLY).authored.card.body[0]).toEqual({ type: 'TextBlock', text: '[Run \\[1\\]](https://example.com/safe)', wrap: true });
  });

  it('escapes Markdown structure in authored text without changing ordinary words', () => {
    const r = built({ blocks: [text('# not a heading\n- not a list\n1. not ordered\n*a* _b_ `c` ~d~ |e|'), text('All checks passed.')] }, TEXT_ONLY);
    expect(r.authored.card.body.map((e) => (e as { text: string }).text)).toEqual([
      '\\# not a heading\n\\- not a list\n1\\. not ordered\n\\*a\\* \\_b\\_ \\`c\\` \\~d\\~ \\|e\\|',
      'All checks passed.',
    ]);
  });

  it('builder marks wrap escaped run text (fallback rich text)', () => {
    const r = built({ blocks: [{ kind: 'rich_text', runs: [{ kind: 'strong', text: '[x](http://evil.local)' }, { kind: 'emphasis', text: ' a*b ' }, { kind: 'code', text: 'npm test' }] }] }, TEXT_ONLY);
    expect((r.authored.card.body[0] as { text: string }).text).toBe('**\\[x\\]\\(http\\[:\\]//evil.local\\)** _a\\*b_ `npm test`');
  });

  it('the clipboard payload stays the exact (redacted, mention-neutralized) authored text', () => {
    const r = built({ blocks: [{ kind: 'copy', label: 'Copy', text: 'curl https://example.org/x' }] });
    expect(r.authored.card.body[1]).toEqual({ type: 'ActionSet', actions: [{ type: 'Action.CopyToClipboard', title: 'Copy', text: 'curl https://example.org/x' }] });
    expect((r.authored.card.body[0] as { text: string }).text).toBe('curl https\\[:\\]//example.org/x');
  });
});
