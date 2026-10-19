/**
 * Test-build-only hook module (R8 §10.4). Compiled by `npm run build:test` to
 * dist-test/, which the package `files` whitelist excludes; pack-smoke asserts
 * it is absent from the tarball. Parses CODEX_OCTO_TEST_FAULTS (JSON array of
 * {point, times}) and CODEX_OCTO_TEST_CLOCK (integer offset ms). Fails closed.
 */
import { FAULT_POINT_NAMES } from '../../src/seams/fault-plan.js';

export interface TestHookConfig { faults: Array<{ point: string; times: number }>; clockOffsetMs: number }

const KEY_RE = /^([a-zA-Z]+\.[a-zA-Z]+)(?:\(([^)]*)\))?$/;

export function parseTestHookEnv(env: Record<string, string | undefined>): TestHookConfig {
  const faults: TestHookConfig['faults'] = [];
  if (env.CODEX_OCTO_TEST_FAULTS) {
    let parsedValue: unknown;
    try { parsedValue = JSON.parse(env.CODEX_OCTO_TEST_FAULTS); } catch { throw new Error('CODEX_OCTO_TEST_FAULTS must be valid JSON'); }
    const parsed = parsedValue as Array<{ point?: unknown; times?: unknown }>;
    if (!Array.isArray(parsed)) throw new Error('CODEX_OCTO_TEST_FAULTS must be a JSON array');
    for (const f of parsed) {
      if (!f || typeof f !== 'object' || typeof f.point !== 'string') throw new Error('invalid fault entry');
      const point = f.point;
      const m = KEY_RE.exec(point);
      if (!m || !(FAULT_POINT_NAMES as readonly string[]).includes(m[1])) throw new Error(`unknown fault point: ${point}`);
      if (m[1] === 'egress.afterSegment' ? !/^\d+$/.test(m[2] ?? '') || !Number.isSafeInteger(Number(m[2])) || Number(m[2]) < 1
        : m[1] === 'api.forceStatus' ? !/^[A-Za-z][A-Za-z0-9_-]*$/.test(m[2] ?? '') : m[2] !== undefined) throw new Error(`invalid fault parameter: ${point}`);
      const times = f.times === undefined ? 1 : Number(f.times);
      if (!Number.isSafeInteger(times) || times < 1) throw new Error(`invalid times for ${point}`);
      faults.push({ point, times });
    }
  }
  let clockOffsetMs = 0;
  if (env.CODEX_OCTO_TEST_CLOCK !== undefined && env.CODEX_OCTO_TEST_CLOCK !== '') {
    if (!/^-?\d+$/.test(env.CODEX_OCTO_TEST_CLOCK)) throw new Error('CODEX_OCTO_TEST_CLOCK must be an integer millisecond offset');
    clockOffsetMs = Number(env.CODEX_OCTO_TEST_CLOCK);
    if (!Number.isSafeInteger(clockOffsetMs)) throw new Error("CODEX_OCTO_TEST_CLOCK must be a safe integer");
  }
  return { faults, clockOffsetMs };
}
