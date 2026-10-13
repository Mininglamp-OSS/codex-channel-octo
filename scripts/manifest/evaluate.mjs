/**
 * Milestone gate evaluator (R8 §10.8): passed only when every required item
 * passed on the verified head/profile/manifest with independently re-runnable
 * evidence; failed and pending are distinct and neither approves a gate.
 */
const LISTS = ['requiresGate', 'requiredCases', 'requiredSpikes', 'requiredSuites', 'requiredDiscoveriesConsumed',
  'requiredArtifacts', 'dependencyBuilds', 'requiredContractCases', 'requiredOracleCases'];

export function evaluateMilestone(manifest, milestone, evidence, provenance) {
  const sel = manifest[milestone];
  const items = [];
  for (const list of LISTS) {
    for (const id of sel?.[list] ?? []) {
      const ev = evidence[id];
      let status = 'pending';
      let reason = 'no evidence';
      if (ev) {
        if (ev.status === 'failed') { status = 'failed'; reason = 'failed evidence'; }
        else if (ev.status !== 'passed') reason = `evidence status ${ev.status}`;
        else if (ev.manifestSha256 !== provenance.manifestSha256) reason = 'manifest hash mismatch';
        else if (ev.head !== provenance.head) reason = 'stale head';
        else if (ev.profile !== provenance.profile) reason = 'profile mismatch';
        else if (ev.source === 'implementer') reason = 'implementer-only assertion';
        else { status = 'passed'; reason = ''; }
      }
      items.push({ id, list, status, reason });
    }
  }
  const status = items.some((i) => i.status === 'failed') ? 'failed'
    : items.some((i) => i.status === 'pending') ? 'pending' : 'passed';
  return { milestone, status, items };
}
