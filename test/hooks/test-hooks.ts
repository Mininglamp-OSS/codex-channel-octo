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
    const parsed = JSON.parse(env.CODEX_OCTO_TEST_FAULTS) as Array<{ point?: unknown; times?: unknown }>;
    if (!Array.isArray(parsed)) throw new Error('CODEX_OCTO_TEST_FAULTS must be a JSON array');
    for (const f of parsed) {
      const point = String(f.point ?? '');
      const m = KEY_RE.exec(point);
      if (!m || !(FAULT_POINT_NAMES as readonly string[]).includes(m[1])) throw new Error(`unknown fault point: ${point}`);
      const times = f.times === undefined ? 1 : Number(f.times);
      if (!Number.isInteger(times) || times < 1) throw new Error(`invalid times for ${point}`);
      faults.push({ point, times });
    }
  }
  let clockOffsetMs = 0;
  if (env.CODEX_OCTO_TEST_CLOCK !== undefined) {
    if (!/^-?\d+$/.test(env.CODEX_OCTO_TEST_CLOCK)) throw new Error('CODEX_OCTO_TEST_CLOCK must be an integer millisecond offset');
    clockOffsetMs = Number(env.CODEX_OCTO_TEST_CLOCK);
  }
  return { faults, clockOffsetMs };
}
