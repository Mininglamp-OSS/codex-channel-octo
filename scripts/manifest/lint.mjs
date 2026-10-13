#!/usr/bin/env node
/** All four R8 selections share schema validation with the gate evaluator. */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { MILESTONES, record, normalizeId, FAMILY_RANGES, rootIssues, parseSelection, M3_DESCRIPTORS } from './selection.mjs';
export { normalizeId, FAMILY_RANGES };
export function lintManifestReport(manifest, catalog) {
  const issues = rootIssues(manifest), placeholders = [];
  const entries = Array.isArray(catalog?.entries) ? catalog.entries.filter(record) : [];
  if (!Array.isArray(catalog?.entries)) issues.push({ code: 'wrong-type', id: 'catalog', where: 'catalog' });
  const byId = new Map(entries.map(e => [e.id, e]));
  for (const milestone of MILESTONES) {
    const parsed = parseSelection(manifest, milestone);
    issues.push(...parsed.issues);
    const selected = new Set(parsed.requirements.map(r => normalizeId(r.id)));
    for (const { id, where } of parsed.requirements) {
      const entry = byId.get(id);
      if (!entry) {
        if (milestone.startsWith('M3-') && M3_DESCRIPTORS.has(id)) placeholders.push({ milestone, id, where, readiness: 'not-ready' });
        else issues.push({ code: 'unbound-case', id, where });
      } else if (!entry.procedure || !entry.evidenceOracle) issues.push({ code: 'missing-oracle', id, where });
    }
    for (const p of parsed.placeholders) placeholders.push({ milestone, id: p.id, where: p.where, readiness: 'not-ready' });
    for (const e of entries) if (Array.isArray(e.mandatoryFor) && e.mandatoryFor.includes(milestone) && !selected.has(e.id))
      issues.push({ code: 'omitted-mandatory-case', id: e.id, where: milestone });
  }
  return { issues, placeholders };
}
export const lintManifest = (manifest, catalog) => lintManifestReport(manifest, catalog).issues;
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const manifest = JSON.parse(readFileSync(process.argv[2] ?? 'test/milestone-manifest.json', 'utf8'));
  const catalog = JSON.parse(readFileSync(process.argv[3] ?? 'test/acceptance/case-catalog.json', 'utf8'));
  const report = lintManifestReport(manifest, catalog);
  console.log(JSON.stringify(report, null, 2));
  process.exit(report.issues.length ? 1 : 0);
}
