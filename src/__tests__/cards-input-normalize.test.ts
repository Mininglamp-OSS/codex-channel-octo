import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createInputNormalizer } from '../cards/input-normalize.js';
import { SUPPORTED_TZ_VERSIONS } from '../cards/tz-support.js';
import type { InputSpec } from '../cards/contracts.js';

const date: InputSpec = { id: 'date', kind: 'date', label: 'Date', required: true };
const time: InputSpec = { id: 'time', kind: 'time', label: 'Time', required: false };
describe('strict input normalization', () => {
  const normalize = createInputNormalizer();
  it.each(['2024-02-29', '2000-02-29', '0001-01-01'])('accepts Gregorian %s without conversion', value => {
    expect(normalize([date], { date: value })).toEqual({ ok: true, value: { date: value } });
  });
  it.each(['2023-02-29', '1900-02-29', '0000-01-01', '2024-13-01', '2024-2-01', '2024-02-29T00:00Z'])('rejects %s', value => {
    expect(normalize([date], { date: value }).ok).toBe(false);
  });
  it('preserves optional absence and strict present types', () => {
    expect(normalize([time], {})).toEqual({ ok: true, value: {} });
    for (const value of [null, '24:00', '12:00:00', 0]) expect(normalize([time], { time: value }).ok).toBe(false);
    expect(normalize([{ id: 't', kind: 'toggle', label: 'Consent', required: true }], { t: false })).toEqual({ ok: true, value: { t: false } });
    const n: InputSpec = { id: 'n', kind: 'number', label: 'n', required: true, min: 0, max: 2 };
    for (const value of ['1', NaN, Infinity, 3]) expect(normalize([n], { n: value }).ok).toBe(false);
    expect(normalize([n], { n: 0 }).ok).toBe(true);
  });
  it('enforces choice membership, duplicates, unknown IDs and byte limits', () => {
    const c: InputSpec = { id: 'c', kind: 'choice', label: 'c', required: true, multiple: true, min: 1, max: 2, options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }] };
    for (const value of [[], ['a', 'a'], ['z'], 'a']) expect(normalize([c], { c: value }).ok).toBe(false);
    expect(normalize([c], { c: ['a', 'b'] }).ok).toBe(true);
    expect(normalize([], { unknown: 'sensitive' })).toMatchObject({ ok: false, error: { diagnostics: [{ path: '$', rule: 'unknown_input' }] } });
    expect(normalize([{ id: 's', kind: 'text', label: 's', required: true }], { s: '界'.repeat(1400) }).ok).toBe(false);
  });
});

describe('tz version contract on every runtime', () => {
  const fixture = JSON.parse(readFileSync(new URL('../cards/__fixtures__/tzdb-expectations.v1.json', import.meta.url), 'utf8')) as Record<string, { tz: string; observedOn: string[]; outcomes: { zone: string; date: string; time: string; valid: boolean }[] }>;
  const outcomes = (normalize: ReturnType<typeof createInputNormalizer>, version: string) => {
    for (const o of fixture[version].outcomes) {
      // Independent wall/calendar values, never paired for conversion (TD v3 C.1).
      const value = { date: o.date, time: o.time };
      const result = normalize([{ ...date, timezone: o.zone }, { ...time, timezone: o.zone }], value);
      expect(result.ok).toBe(o.valid);
      if (result.ok) expect(result.value).toEqual(value);
    }
  };
  it('keeps the shipped set identical to reviewed fixture keys', () => {
    expect([...SUPPORTED_TZ_VERSIONS].sort()).toEqual(Object.keys(fixture).sort());
  });
  for (const version of [...SUPPORTED_TZ_VERSIONS, 'unsupported', undefined, '', 42]) {
    it(`exercises injected tz version ${String(version)}`, () => {
      const normalize = createInputNormalizer({ tzVersion: () => version as string | undefined });
      expect(normalize([date], { date: '2024-02-29' }).ok).toBe(true);
      if (typeof version === 'string' && SUPPORTED_TZ_VERSIONS.has(version)) {
        outcomes(normalize, version);
      } else {
        expect(normalize([{ ...date, timezone: 'America/New_York' }], { date: '2024-02-29' })).toMatchObject({ ok: false, error: { code: 'validation_failed', diagnostics: [{ rule: typeof version !== 'string' || version === '' ? 'timezone_db_unavailable' : 'timezone_db_unsupported' }] } });
      }
    });
  }
  it('exercises real ICU or its fail-closed boundary and records content-free version evidence', () => {
    const actual = process.versions.tz;
    console.info(`TZ runtime=${process.version} tz=${actual ?? 'unavailable'} supported=${SUPPORTED_TZ_VERSIONS.has(actual ?? '')}`);
    const normalize = createInputNormalizer();
    if (actual && SUPPORTED_TZ_VERSIONS.has(actual)) {
      outcomes(normalize, actual);
    } else expect(normalize([{ ...date, timezone: 'UTC' }], { date: '2024-02-29' }).ok).toBe(false);
  });
});
