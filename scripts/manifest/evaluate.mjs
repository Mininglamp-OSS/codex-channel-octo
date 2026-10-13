/** Milestone evidence evaluation; unsupported or unselected gates never approve. */
import { MILESTONES, own, record, parseSelection, rootIssues } from './selection.mjs';
import { readFileSync } from 'node:fs';
const defaultCatalog = JSON.parse(readFileSync(new URL('../../test/acceptance/case-catalog.json', import.meta.url), 'utf8'));
export function evaluateMilestone(manifest, milestone, evidence, provenance, catalog = defaultCatalog) {
  if (!MILESTONES.includes(milestone)) return { milestone, status: 'failed', reason: 'unknown-milestone', items: [] };
  const selection = parseSelection(manifest, milestone);
  const issues = [...rootIssues(manifest), ...selection.issues];
  if (issues.length) return { milestone, status: 'failed', reason: 'invalid-selection', items: [], issues };
  const validProvenance = record(provenance) && ['manifestSha256', 'head', 'profile'].every(k => typeof provenance[k] === 'string' && provenance[k].trim());
  const entries = Array.isArray(catalog?.entries) ? catalog.entries.filter(record) : [];
  const byId = new Map(entries.map(entry => [entry.id, entry]));
  const items = selection.requirements.map(({ id, list, where }) => {
    if (milestone === 'M3-G6' || where.includes('conditionalCaseRequirements'))
      return { id, list, status: 'pending', reason: 'no reviewed item-level selection/profile binding' };
    const ev = own(evidence, id) ? evidence[id] : undefined;
    let status = 'pending', reason = 'no evidence';
    const entry = byId.get(id);
    if ((milestone === 'M1' || milestone === 'M2') && (!entry?.procedure || !entry?.evidenceOracle)) {
      reason = 'unbound requirement or missing procedure/evidence oracle';
    } else if (record(ev)) {
      if (ev.status === 'failed') { status = 'failed'; reason = 'failed evidence'; }
      else if (ev.status !== 'passed') reason = `evidence status ${ev.status}`;
      else if (!validProvenance) reason = 'missing verified provenance';
      else if (ev.manifestSha256 !== provenance.manifestSha256) reason = 'manifest hash mismatch';
      else if (ev.head !== provenance.head) reason = 'stale head';
      else if (ev.profile !== provenance.profile) reason = 'profile mismatch';
      else if (typeof ev.source !== 'string' || !ev.source.startsWith('independent-')) reason = 'evidence is not independent';
      else { status = 'passed'; reason = ''; }
    }
    return { id, list, status, reason };
  });
  const selected = new Set(selection.requirements.map(item => item.id));
  for (const entry of entries) {
    if (Array.isArray(entry.mandatoryFor) && entry.mandatoryFor.includes(milestone) && !selected.has(entry.id))
      items.push({ id: entry.id, list: 'omittedMandatory', status: 'failed', reason: 'mandatory case omitted from selection' });
  }
  // No owner waiver is authenticated by this harness. Caller booleans, source
  // labels and look-alike dispositions never authorize dropping all M3 items.
  items.push(...selection.placeholders.map(p => ({ ...p, status: 'pending' })));
  const status = items.some(i => i.status === 'failed') ? 'failed'
    : !items.length || items.some(i => i.status === 'pending') ? 'pending' : 'passed';
  return { milestone, status, items };
}
