#!/usr/bin/env node
/**
 * Milestone manifest linter (R8 §10.9 "Validation and verification").
 *   node scripts/manifest/lint.mjs [manifest] [catalog]
 * Fails on unknown/duplicate/non-canonical IDs, unbound cases, catalog entries
 * without procedure or evidence oracle, and mandatory procedure cases omitted
 * from a milestone's selection.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** R8-defined numeric ranges per case family. */
export const FAMILY_RANGES = {
  'M1': 38, 'M2': 20, SB: 14, SR: 7, SO: 18, D: 8, MAN: 10, STAG: 8, REPLAY: 8, BOUNDARY: 3, OP: 8, ORACLE: 8, RTN: 8,
};
const CASE_LISTS = ['requiredCases', 'requiredSpikes', 'requiredContractCases', 'requiredOracleCases'];
const NAMED_LISTS = ['requiresGate', 'requiredSuites', 'requiredDiscoveriesConsumed', 'requiredArtifacts', 'dependencyBuilds'];
const MILESTONES = ['M1', 'M2'];

/** Canonical zero-padded form: SO-3 → SO-03, D1 → D-01. Non-case strings pass through. */
export function normalizeId(id) {
  let m = /^(M[123])-(\d+)$/.exec(id);
  if (m) return `${m[1]}-${m[2].padStart(2, '0')}`;
  m = /^([A-Z]+)-?(\d+)$/.exec(id);
  if (m) return `${m[1]}-${m[2].padStart(2, '0')}`;
  return id;
}
const familyOf = (id) => (/^(M[123])-\d+$/.exec(id)?.[1]) ?? (/^([A-Z]+)-?\d+$/.exec(id)?.[1]);

export function lintManifest(manifest, catalog) {
  const issues = [];
  const byId = new Map(catalog.entries.map((e) => [e.id, e]));
  const push = (code, id, where) => issues.push({ code, id, where });
  for (const ms of MILESTONES) {
    const sel = manifest[ms];
    if (!sel) { push('missing-milestone', ms, ms); continue; }
    const selected = new Set();
    for (const list of [...CASE_LISTS, ...NAMED_LISTS]) {
      const seen = new Set();
      for (const raw of sel[list] ?? []) {
        const where = `${ms}.${list}`;
        if (seen.has(raw)) push('duplicate-id', raw, where);
        seen.add(raw);
        selected.add(normalizeId(raw));
        if (CASE_LISTS.includes(list)) {
          const fam = familyOf(raw);
          if (!fam || !(fam in FAMILY_RANGES)) { push('unknown-family', raw, where); continue; }
          if (normalizeId(raw) !== raw) { push('non-canonical-id', raw, where); continue; }
          const n = Number(raw.slice(raw.lastIndexOf('-') + 1));
          if (n < 1 || n > FAMILY_RANGES[fam]) { push('unknown-id', raw, where); continue; }
        }
        const entry = byId.get(raw);
        if (!entry) { push('unbound-case', raw, where); continue; }
        if (!entry.procedure || !entry.evidenceOracle) push('missing-oracle', raw, where);
      }
    }
    for (const e of catalog.entries) {
      if (e.mandatoryFor.includes(ms) && !selected.has(e.id)) push('omitted-mandatory-case', e.id, ms);
    }
  }
  return issues;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const manifest = JSON.parse(readFileSync(process.argv[2] ?? 'test/milestone-manifest.json', 'utf8'));
  const catalog = JSON.parse(readFileSync(process.argv[3] ?? 'test/acceptance/case-catalog.json', 'utf8'));
  const issues = lintManifest(manifest, catalog);
  console.log(JSON.stringify({ issues }, null, 2));
  process.exit(issues.length ? 1 : 0);
}
