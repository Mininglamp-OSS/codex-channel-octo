/**
 * OC schedule goldens (R8 §3.4.6, §3.4.8, §10.3): produced by
 * scripts/goldens/gen-oc-schedule.mjs executing pinned OC source
 * (openclaw @ f6065d6) with croner@10.0.1. DEV-01 verifies provenance and the
 * R8-normative values; DEV-09 binds the codex-buddy port to the same file.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { pins } from '../harness/pins.js';

const raw = readFileSync(new URL('./oc/schedule.json', import.meta.url));
const golden = JSON.parse(raw.toString('utf8')) as OcGolden;

interface ScheduleCase { id: string; tz: string; expr?: string; everyMs?: number; anchorMs?: number; now: string; next: string | null; previous: string | null }
interface OcGolden {
  generator: string;
  source: { repo: string; commit: string; files: Record<string, string> };
  croner: string;
  runtime: { node: string; tz: string | null; icu: string | null };
  ocVerbatim: ScheduleCase[];
  fixedInstant: ScheduleCase[];
  stagger: {
    offsets: Array<{ jobId: string; staggerMs: number; offsetMs: number; wholeDigestModulo: string }>;
    defaults: Array<{ expr: string; resolvedStaggerMs: number }>;
    effective: Array<{ id: string; jobId: string; expr: string; tz: string; staggerMs: number; now: string; next: string | null; previousInclusive: string | null }>;
  };
}

const iso = (s: string | null) => (s === null ? null : new Date(s).toISOString());

describe('OC schedule golden provenance', () => {
  it('GOC-00: golden bytes match the committed sha256, pinned OC source and croner 10.0.1', () => {
    const recorded = readFileSync(new URL('./oc/schedule.json.sha256', import.meta.url), 'utf8').trim().split(/\s+/)[0];
    expect(createHash('sha256').update(raw).digest('hex')).toBe(recorded);
    expect(golden.source.repo).toBe('openclaw/openclaw');
    expect(golden.source.commit).toBe(pins.OC);
    expect(golden.croner).toBe(pins.croner);
    for (const f of ['src/cron/schedule.ts', 'src/cron/stagger.ts', 'src/cron/service/jobs-scheduling.ts']) {
      expect(golden.source.files[f], f).toMatch(/^[0-9a-f]{64}$/);
    }
    expect(golden.generator).toBe('scripts/goldens/gen-oc-schedule.mjs');
    expect(existsSync(new URL('../../scripts/goldens/gen-oc-schedule.mjs', import.meta.url))).toBe(true);
    expect(golden.runtime.tz, 'IANA tzdata version must be recorded').toMatch(/^\d{4}[a-z]$/);
  });
});

describe('CR-2.3 DST contract: generated values equal the R8 §3.4.6 verbatim table', () => {
  // R8 §3.4.6 table, copied from OC schedule.test.ts:25-128. These are the
  // normative expectations; the generated golden must reproduce them.
  const R8_TABLE: Array<Omit<ScheduleCase, 'id'> & { id: string }> = [
    { id: 'lord-howe-repeated-half-hour', tz: 'Australia/Lord_Howe', expr: '* * * * * *', now: '2026-04-04T15:10:00Z', next: '2026-04-04T15:30:00Z', previous: '2026-04-04T14:59:59Z' },
    { id: 'ny-last-valid-second-before-gap', tz: 'America/New_York', expr: '59 59 1,2 * * *', now: '2027-03-14T07:05:00Z', next: '2027-03-15T05:59:59Z', previous: '2027-03-14T06:59:59Z' },
    { id: 'oslo-skips-nonexistent-reminder', tz: 'Europe/Oslo', expr: '30 2 * * *', now: '2026-03-29T00:45:00Z', next: '2026-03-30T00:30:00Z', previous: '2026-03-28T01:30:00Z' },
    { id: 'ny-sun2-future-nonexistent', tz: 'America/New_York', expr: '30 2 * 3 SUN#2', now: '2026-01-01T00:00:00Z', next: null, previous: '2006-03-12T07:30:00Z' },
    { id: 'year-limited-nonexistent', tz: 'America/New_York', expr: '0 30 2 14 3 * 2027', now: '2026-07-01T00:00:00Z', next: null, previous: null },
    { id: 'year-limited-repeated-hour', tz: 'America/New_York', expr: '0 30 1 1 11 * 2026', now: '2026-11-01T06:15:00Z', next: null, previous: '2026-11-01T05:30:00Z' },
    { id: 'retry-rejects-real-gap-a', tz: 'America/New_York', expr: '30 2 * * *', now: '2027-03-14T06:45:00Z', next: '2027-03-15T06:30:00Z', previous: null },
    { id: 'retry-rejects-real-gap-b', tz: 'America/New_York', expr: '30 2 * * *', now: '2027-03-13T23:45:00Z', next: '2027-03-15T06:30:00Z', previous: null },
  ];

  it.each(R8_TABLE)('GOC-01 $id', (row) => {
    const g = golden.ocVerbatim.find((c) => c.id === row.id);
    expect(g, `golden row ${row.id}`).toBeDefined();
    expect(g!.tz).toBe(row.tz);
    expect(g!.expr).toBe(row.expr);
    expect(iso(g!.now)).toBe(iso(row.now));
    expect(iso(g!.next)).toBe(iso(row.next));
    // R8 lists "—" for previous in the retry rows: only next is normative there.
    if (!row.id.startsWith('retry-')) expect(iso(g!.previous)).toBe(iso(row.previous));
  });
});

describe('SF-4 fixed-instant DST cases (generated, never hand-computed)', () => {
  const localParts = (instant: string, tz: string) => {
    const parts = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour12: false, hour: '2-digit', minute: '2-digit' }).formatToParts(new Date(instant));
    return `${parts.find((p) => p.type === 'hour')!.value}:${parts.find((p) => p.type === 'minute')!.value}`;
  };

  it('GOC-02: London, New York and Shanghai cron cases plus an every-schedule are all present', () => {
    const tzs = new Set(golden.fixedInstant.map((c) => c.tz));
    expect([...tzs].sort()).toEqual(['America/New_York', 'Asia/Shanghai', 'Europe/London', 'UTC']);
    expect(golden.fixedInstant.some((c) => c.everyMs !== undefined)).toBe(true);
    expect(golden.fixedInstant.filter((c) => c.tz === 'Europe/London').length).toBeGreaterThanOrEqual(4);
    expect(golden.fixedInstant.filter((c) => c.tz === 'America/New_York').length).toBeGreaterThanOrEqual(4);
  });

  it('GOC-03: every generated cron instant lands on the expression wall time (gap skipped, never the transition instant)', () => {
    for (const c of golden.fixedInstant.filter((x) => x.expr)) {
      const [min, hour] = c.expr!.split(' ');
      const want = `${hour.padStart(2, '0')}:${min.padStart(2, '0')}`;
      for (const t of [c.next, c.previous]) {
        if (t === null) continue;
        expect(localParts(t, c.tz), `${c.id} ${t}`).toBe(want);
      }
      if (c.next) expect(Date.parse(c.next)).toBeGreaterThan(Date.parse(c.now));
      if (c.previous) expect(Date.parse(c.previous)).toBeLessThan(Date.parse(c.now));
    }
  });

  it('GOC-04: every schedules are pure UTC arithmetic across a DST transition', () => {
    for (const c of golden.fixedInstant.filter((x) => x.everyMs !== undefined)) {
      const now = Date.parse(c.now);
      const steps = Math.floor((now - c.anchorMs!) / c.everyMs!) + 1;
      expect(iso(c.next)).toBe(new Date(c.anchorMs! + steps * c.everyMs!).toISOString());
    }
  });
});

describe('CR-2.6 effective stagger (R8 §3.4.8)', () => {
  it('GOC-05 (STAG arithmetic): j7f3k2q/300000 → 253353 via uint32BE of the first four digest bytes, not the whole digest', () => {
    const digest = createHash('sha256').update('j7f3k2q', 'utf8').digest();
    const independent = digest.readUInt32BE(0) % 300000;
    expect(independent).toBe(253353);
    const g = golden.stagger.offsets.find((o) => o.jobId === 'j7f3k2q' && o.staggerMs === 300000)!;
    expect(g.offsetMs).toBe(253353);
    const whole = (BigInt('0x' + digest.toString('hex')) % 300000n).toString();
    expect(g.wholeDigestModulo).toBe(whole);
    expect(whole).not.toBe('253353');
  });

  it('GOC-06: default-width normalization matches R8 examples (top-of-hour wildcard → 300000; fixed daily 09:00 → 0)', () => {
    const d = new Map(golden.stagger.defaults.map((x) => [x.expr, x.resolvedStaggerMs]));
    expect(d.get('0 * * * *')).toBe(300000);
    expect(d.get('0 0 * * * *')).toBe(300000);
    expect(d.get('0 9 * * *')).toBe(0);
    expect(d.get('30 * * * *')).toBe(0);
  });

  it('GOC-07: the R8 §3.4.8 boundary walk-through is reproduced by the pinned effective wrappers', () => {
    const e = new Map(golden.stagger.effective.map((x) => [x.id, x]));
    expect(e.get('before-boundary')).toMatchObject({ now: '2026-10-13T10:04:13.352Z', next: '2026-10-13T10:04:13.353Z' });
    expect(e.get('at-boundary')).toMatchObject({ now: '2026-10-13T10:04:13.353Z', previousInclusive: '2026-10-13T10:04:13.353Z', next: '2026-10-13T11:04:13.353Z' });
    expect(e.get('after-boundary')).toMatchObject({ now: '2026-10-13T10:04:13.354Z', previousInclusive: '2026-10-13T10:04:13.353Z' });
    expect(e.get('exact')).toMatchObject({ staggerMs: 0, next: '2026-10-13T10:00:00.000Z' });
  });

  it.todo('DEV-09: the codex-buddy schedule port reproduces every OC golden row (pending: no port exists at DEV-01)');
});
