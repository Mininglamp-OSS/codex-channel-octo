/**
 * WP-09 display schema: semantic rules over the structurally accepted C.1
 * display grammar (AC-010.1/.2), safe links, mention neutralization and
 * authored-content redaction (AC-019.1, authored scope).
 *
 * Evidence label: [UNIT]. Pure functions; no store, transport or network.
 */
import { describe, expect, it } from 'vitest';
import type { DisplayBlock, DisplayCardArgs } from '../cards/contracts.js';
import {
  DISPLAY_BOUNDS, REDACTED, neutralizeMentions, redactAuthored, safeLinkUrl, validateDisplayArgs,
} from '../cards/display-schema.js';

const DIAG_PATH = /^\$[A-Za-z0-9_.[\]*]{0,127}$/;
const DIAG_RULE = /^[a-z0-9_]{1,64}$/;

const ok = (args: DisplayCardArgs): DisplayCardArgs => {
  const r = validateDisplayArgs(args);
  if (!r.ok) throw new Error(`rejected: ${JSON.stringify(r.error)}`);
  return r.value;
};
const err = (args: DisplayCardArgs) => {
  const r = validateDisplayArgs(args);
  if (r.ok) throw new Error('accepted');
  for (const d of r.error.diagnostics) {
    expect(d.path).toMatch(DIAG_PATH);
    expect(d.rule).toMatch(DIAG_RULE);
  }
  return r.error;
};
const text = (t: string): DisplayBlock => ({ kind: 'text', text: t });

describe('accepted display cards (AC-010.1)', () => {
  it('accepts every block kind and returns a normalized frozen copy', () => {
    const args: DisplayCardArgs = {
      title: 'Build report',
      blocks: [
        { kind: 'heading', text: 'Summary', level: 2 },
        text('All checks passed.'),
        { kind: 'rich_text', runs: [{ kind: 'strong', text: 'Note:' }, { kind: 'text', text: ' see ' }, { kind: 'link', label: 'docs', url: 'https://example.com/docs' }] },
        { kind: 'facts', items: [{ label: 'Branch', value: 'main' }] },
        { kind: 'columns', columns: [{ blocks: [text('left')] }, { blocks: [text('right')] }] },
        { kind: 'table', headers: ['Name', 'Result'], rows: [['lint', 'ok'], ['test', 'ok']] },
        { kind: 'link', label: 'Open run', url: 'https://example.com/runs/1' },
        { kind: 'group', blocks: [text('grouped')] },
        { kind: 'collapsible', label: 'Details', blocks: [text('hidden')], expanded: false },
        { kind: 'copy', label: 'Copy command', text: 'npm test' },
      ],
    };
    const value = ok(args);
    expect(value).toEqual(args);
    expect(value).not.toBe(args);
    expect(Object.isFrozen(value)).toBe(true);
    expect(Object.isFrozen(value.blocks[4])).toBe(true);
  });

  it('is deterministic and never mutates its input', () => {
    const args: DisplayCardArgs = { title: ' Title ', blocks: [text('a​b @x')] };
    const snapshot = structuredClone(args);
    expect(ok(args)).toEqual(ok(args));
    expect(args).toEqual(snapshot);
  });

  it('trims labels and strips control and format characters from text', () => {
    const value = ok({ title: '  Report‮  ', blocks: [text('line 1\nline\u00002‏\tend')] });
    expect(value.title).toBe('Report');
    expect((value.blocks[0] as { text: string }).text).toBe('line 1\nline2 end');
  });
});

describe('rejected display cards (AC-010.2)', () => {
  it('rejects an empty card, empty containers and empty text', () => {
    expect(err({ blocks: [] })).toMatchObject({ code: 'validation_failed', diagnostics: [{ path: '$.blocks', rule: 'empty' }] });
    expect(err({ blocks: [{ kind: 'group', blocks: [] }] }).diagnostics).toContainEqual({ path: '$.blocks[0].blocks', rule: 'empty' });
    expect(err({ blocks: [{ kind: 'columns', columns: [] }] }).diagnostics).toContainEqual({ path: '$.blocks[0].columns', rule: 'empty' });
    expect(err({ blocks: [{ kind: 'facts', items: [] }] }).diagnostics).toContainEqual({ path: '$.blocks[0].items', rule: 'empty' });
    expect(err({ blocks: [text('   ')] }).diagnostics).toContainEqual({ path: '$.blocks[0].text', rule: 'text_empty' });
    expect(err({ blocks: [{ kind: 'rich_text', runs: [] }] }).diagnostics).toContainEqual({ path: '$.blocks[0].runs', rule: 'empty' });
  });

  it('rejects empty, multi-line and over-long labels', () => {
    expect(err({ title: ' ', blocks: [text('x')] }).diagnostics).toContainEqual({ path: '$.title', rule: 'label_empty' });
    expect(err({ blocks: [{ kind: 'link', label: 'a\nb', url: 'https://example.com' }] }).diagnostics)
      .toContainEqual({ path: '$.blocks[0].label', rule: 'label_multiline' });
    const long = 'x'.repeat(DISPLAY_BOUNDS.labelScalars + 1);
    expect(err({ blocks: [{ kind: 'copy', label: long, text: 'y' }] })).toMatchObject({ code: 'limit_exceeded',
      diagnostics: [{ path: '$.blocks[0].label', rule: 'label_too_long' }] });
  });

  it('counts Unicode scalars, not UTF-16 units, for text bounds', () => {
    const emoji = '\u{1F600}'.repeat(DISPLAY_BOUNDS.textScalars);
    expect(validateDisplayArgs({ blocks: [text(emoji)] }).ok).toBe(true);
    expect(err({ blocks: [text(`${emoji}x`)] })).toMatchObject({ code: 'limit_exceeded', diagnostics: [{ rule: 'text_too_long' }] });
  });

  it('bounds total source blocks, nesting, columns, facts, runs and tables', () => {
    expect(err({ blocks: Array.from({ length: DISPLAY_BOUNDS.sourceBlocks + 1 }, () => text('x')) }))
      .toMatchObject({ code: 'limit_exceeded', diagnostics: [{ path: '$.blocks', rule: 'too_many_blocks' }] });
    let nested: DisplayBlock = text('deep');
    for (let i = 0; i < DISPLAY_BOUNDS.nesting + 1; i++) nested = { kind: 'group', blocks: [nested] };
    expect(err({ blocks: [nested] }).diagnostics.map((d) => d.rule)).toContain('nesting_too_deep');
    expect(err({ blocks: [{ kind: 'columns', columns: Array.from({ length: DISPLAY_BOUNDS.columns + 1 }, () => ({ blocks: [text('c')] })) }] }).diagnostics)
      .toContainEqual({ path: '$.blocks[0].columns', rule: 'too_many_columns' });
    expect(err({ blocks: [{ kind: 'facts', items: Array.from({ length: DISPLAY_BOUNDS.facts + 1 }, () => ({ label: 'k', value: 'v' })) }] }).diagnostics)
      .toContainEqual({ path: '$.blocks[0].items', rule: 'too_many_facts' });
    expect(err({ blocks: [{ kind: 'rich_text', runs: Array.from({ length: DISPLAY_BOUNDS.runs + 1 }, () => ({ kind: 'text' as const, text: 'r' })) }] }).diagnostics)
      .toContainEqual({ path: '$.blocks[0].runs', rule: 'too_many_runs' });
    expect(err({ blocks: [{ kind: 'table', headers: Array.from({ length: DISPLAY_BOUNDS.tableColumns + 1 }, () => 'h'), rows: [] }] }).diagnostics)
      .toContainEqual({ path: '$.blocks[0].headers', rule: 'too_many_columns' });
    expect(err({ blocks: [{ kind: 'table', headers: ['a'], rows: Array.from({ length: DISPLAY_BOUNDS.tableRows + 1 }, () => ['x']) }] }).diagnostics)
      .toContainEqual({ path: '$.blocks[0].rows', rule: 'too_many_rows' });
  });

  it('rejects a table row whose width differs from the headers', () => {
    expect(err({ blocks: [{ kind: 'table', headers: ['a', 'b'], rows: [['1', '2'], ['3']] }] }).diagnostics)
      .toContainEqual({ path: '$.blocks[0].rows[1]', rule: 'row_width' });
  });

  it('diagnostics never echo authored content and stay within the reply bounds', () => {
    const canary = 'CANARY_DISPLAY_7f3a';
    const e = err({ title: '', blocks: [{ kind: 'link', label: canary, url: `javascript:${canary}` }, text('')] });
    expect(JSON.stringify(e)).not.toContain(canary);
    expect(e.diagnostics.length).toBeLessThanOrEqual(16);
  });

  it('prefers validation_failed over limit_exceeded when both apply', () => {
    expect(err({ title: '', blocks: [text('x'.repeat(DISPLAY_BOUNDS.textScalars + 1))] }).code).toBe('validation_failed');
  });
});

describe('safe link schemes', () => {
  it('accepts https and returns the normalized href', () => {
    expect(safeLinkUrl('https://Example.com/a b'.replace(' ', '%20'))).toEqual({ ok: true, url: 'https://example.com/a%20b' });
    expect(safeLinkUrl('https://example.com/u/@me')).toEqual({ ok: true, url: 'https://example.com/u/%40me' });
  });

  it.each([
    ['http://example.com', 'link_scheme'],
    ['javascript:alert(1)', 'link_scheme'],
    ['data:text/html,hi', 'link_scheme'],
    ['file:///etc/passwd', 'link_scheme'],
    ['mailto:a@example.com', 'link_scheme'],
    ['ftp://example.com/x', 'link_scheme'],
    ['octo://internal/route', 'link_scheme'],
    ['https://user:pw@example.com/', 'link_credentials'],
    ['https://user@example.com/', 'link_credentials'],
    ['https://127.0.0.1/', 'link_host'],
    ['https://[::1]/', 'link_host'],
    ['https://localhost/', 'link_host'],
    ['https://example.com/a b', 'link_invalid'],
    ['https://example.com/‮evil', 'link_invalid'],
    ['not a url', 'link_invalid'],
    ['', 'link_invalid'],
    ['https://example.com/?access_token=abc', 'link_secret'],
    ['https://example.com/?api_key=abc', 'link_secret'],
    ['https://example.com/ghp_0123456789abcdefABCDEF', 'link_secret'],
  ])('rejects %s as %s', (url, rule) => {
    expect(safeLinkUrl(url)).toEqual({ ok: false, rule });
  });

  it('bounds link length', () => {
    expect(safeLinkUrl(`https://example.com/${'a'.repeat(DISPLAY_BOUNDS.urlBytes)}`)).toEqual({ ok: false, rule: 'link_too_long' });
  });

  it('rejects unsafe links in link blocks and rich-text runs at their path', () => {
    expect(err({ blocks: [{ kind: 'link', label: 'x', url: 'http://example.com' }] }).diagnostics)
      .toContainEqual({ path: '$.blocks[0].url', rule: 'link_scheme' });
    expect(err({ blocks: [{ kind: 'rich_text', runs: [{ kind: 'link', label: 'x', url: 'javascript:void(0)' }] }] }).diagnostics)
      .toContainEqual({ path: '$.blocks[0].runs[0].url', rule: 'link_scheme' });
  });
});

describe('mention neutralization', () => {
  it('replaces every @ so no mention, broadcast or structured mention survives', () => {
    expect(neutralizeMentions('@all hi @[u1:Alice] mail a@b.co')).toBe('＠all hi ＠[u1:Alice] mail a＠b.co');
    expect(neutralizeMentions('no mentions')).toBe('no mentions');
  });

  it('applies to every authored string in the card', () => {
    const value = ok({ title: '@all', blocks: [
      text('@everyone'), { kind: 'facts', items: [{ label: '@k', value: '@v' }] },
      { kind: 'table', headers: ['@h'], rows: [['@c']] }, { kind: 'copy', label: '@l', text: '@t' },
      { kind: 'rich_text', runs: [{ kind: 'code', text: '@x' }, { kind: 'link', label: '@y', url: 'https://example.com/@z' }] },
      { kind: 'collapsible', label: '@c', blocks: [{ kind: 'heading', text: '@h' }] },
    ] });
    expect(JSON.stringify(value)).not.toContain('@');
  });
});

describe('authored-content redaction (AC-019.1)', () => {
  const secrets = [
    'ghp_0123456789abcdefghijABCDEFGHIJ012345',
    'sk-proj-abcdefghijklmnop0123456789',
    'AKIAABCDEFGHIJKLMNOP',
    'xoxb-1234567890-abcdefghij',
    'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.c2lnbmF0dXJlMTIzNDU2',
    'DB_PASSWORD=hunter2hunter2',
    'postgres://admin:pw@db.internal/app',
  ];

  it.each(secrets)('redacts %s and keeps the surrounding text', (secret) => {
    expect(redactAuthored(`before ${secret} after`)).toBe(`before ${REDACTED} after`);
  });

  it('redacts bearer credentials and private key blocks', () => {
    expect(redactAuthored('Authorization: Bearer abcdefghijklmnop')).toBe(`Authorization: Bearer ${REDACTED}`);
    expect(redactAuthored('k: -----BEGIN RSA PRIVATE KEY-----\nMIIabc\n-----END RSA PRIVATE KEY----- done'))
      .toBe(`k: ${REDACTED} done`);
  });

  it('leaves ordinary prose untouched', () => {
    const prose = 'Export the report, then run npm test and open the dashboard.';
    expect(redactAuthored(prose)).toBe(prose);
  });

  it('no secret canary reaches any field of the normalized card', () => {
    const s = secrets[0];
    const value = ok({ title: `t ${s}`, blocks: [
      text(s), { kind: 'heading', text: s }, { kind: 'facts', items: [{ label: `k ${s}`, value: s }] },
      { kind: 'table', headers: [`h ${s}`], rows: [[s]] }, { kind: 'copy', label: `c ${s}`, text: s },
      { kind: 'rich_text', runs: [{ kind: 'strong', text: s }, { kind: 'link', label: `l ${s}`, url: 'https://example.com' }] },
      { kind: 'columns', columns: [{ blocks: [text(s)] }] },
      { kind: 'collapsible', label: `x ${s}`, blocks: [{ kind: 'group', blocks: [text(s)] }] },
    ] });
    expect(JSON.stringify(value)).not.toContain(s);
    expect(JSON.stringify(value)).toContain(REDACTED);
  });
});
