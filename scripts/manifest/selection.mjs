/** Shared, fail-closed parser for the four R8 milestone selections. */
export const MILESTONES = ['M1', 'M2', 'M3-dispatch', 'M3-G6'];
export const CASE_LISTS = ['requiredCases', 'requiredSpikes', 'requiredContractCases', 'requiredOracleCases'];
export const NAMED_LISTS = ['requiresGate', 'requiredSuites', 'requiredDiscoveriesConsumed', 'requiredArtifacts', 'dependencyBuilds'];
export const LISTS = [...CASE_LISTS, ...NAMED_LISTS];
export const FAMILY_RANGES = { M1: 38, M2: 20, SB: 14, SR: 7, SO: 18, D: 8, MAN: 10, STAG: 8, REPLAY: 8, BOUNDARY: 3, OP: 8, ORACLE: 8, RTN: 8 };
const META = new Set(['schemaVersion', 'revision', 'file', 'policies']);
export const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
export const own = (object, key) => record(object) && Object.hasOwn(object, key);
export function normalizeId(id) {
  let match = /^(M[123])-(\d+)$/.exec(id);
  if (match) return `${match[1]}-${match[2].padStart(2, '0')}`;
  match = /^([A-Z]+)-?(\d+)$/.exec(id);
  return match ? `${match[1]}-${match[2].padStart(2, '0')}` : id;
}
const familyOf = id => /^(M[123])-\d+$/.exec(id)?.[1] ?? /^([A-Z]+)-?\d+$/.exec(id)?.[1];
export function rootIssues(manifest) {
  if (!record(manifest)) return [{ code: 'wrong-type', id: 'manifest', where: 'manifest' }];
  return Object.keys(manifest).filter(k => !META.has(k) && !MILESTONES.includes(k))
    .map(id => ({ code: 'unknown-milestone', id, where: 'manifest' }));
}
export function parseSelection(manifest, milestone) {
  const issues = [], requirements = [], placeholders = [];
  const add = (code, id, where = milestone) => issues.push({ code, id: String(id), where });
  if (!MILESTONES.includes(milestone)) { add('unknown-milestone', milestone); return { issues, requirements, placeholders }; }
  if (!own(manifest, milestone)) { add('missing-milestone', milestone); return { issues, requirements, placeholders }; }
  const selection = manifest[milestone];
  if (!record(selection)) { add('wrong-type', milestone); return { issues, requirements, placeholders }; }
  const fields = (object, allowed, where) => {
    for (const key of Object.keys(object)) if (!allowed.includes(key)) add('unsupported-field', key, where);
  };
  const list = (object, key, where, cases = false, collect = true) => {
    if (!own(object, key)) { add('missing-list', key, where); return []; }
    const values = object[key];
    if (!Array.isArray(values)) { add('wrong-type', key, where); return []; }
    if (!values.length) add('empty-list', key, where);
    const seen = new Set();
    for (const id of values) {
      if (typeof id !== 'string' || !id.trim()) { add('wrong-type', id, where); continue; }
      if (seen.has(id)) add('duplicate-id', id, where);
      seen.add(id);
      if (cases) {
        const family = familyOf(id);
        if (!family || !own(FAMILY_RANGES, family)) add('unknown-family', id, where);
        else if (normalizeId(id) !== id) add('non-canonical-id', id, where);
        else if (Number(id.slice(id.lastIndexOf('-') + 1)) < 1 || Number(id.slice(id.lastIndexOf('-') + 1)) > FAMILY_RANGES[family]) add('unknown-id', id, where);
      }
      if (collect) requirements.push({ id, list: key, where });
    }
    return [...seen];
  };
  const text = (object, key, where) => {
    if (!own(object, key)) add('missing-field', key, where);
    else if (typeof object[key] !== 'string' || !object[key].trim()) add('wrong-type', key, where);
  };
  if (milestone === 'M1' || milestone === 'M2') {
    fields(selection, LISTS, milestone);
    for (const key of LISTS) list(selection, key, `${milestone}.${key}`, CASE_LISTS.includes(key));
  } else if (milestone === 'M3-dispatch') {
    fields(selection, ['requiresGate', 'requiredArtifacts', 'conditionalCaseRequirements'], milestone);
    for (const key of ['requiresGate', 'requiredArtifacts']) list(selection, key, `${milestone}.${key}`);
    const conditions = selection.conditionalCaseRequirements;
    if (!own(selection, 'conditionalCaseRequirements')) add('missing-list', 'conditionalCaseRequirements');
    else if (!Array.isArray(conditions)) add('wrong-type', 'conditionalCaseRequirements');
    else {
      if (!conditions.length) add('empty-list', 'conditionalCaseRequirements');
      conditions.forEach((condition, index) => {
        const where = `${milestone}.conditionalCaseRequirements[${index}]`;
        if (!record(condition)) { add('wrong-type', 'conditionalCaseRequirements', where); return; }
        fields(condition, ['whenAnySelected', 'profile', 'requiredCases', 'beforeDEV12Dispatch', 'beforeTST03Dispatch', 'missingEvidence'], where);
        list(condition, 'whenAnySelected', where, false, false);
        text(condition, 'profile', where);
        const cases = list(condition, 'requiredCases', where, true);
        for (let n = 1; n <= 8; n++) {
          const id = `RTN-${String(n).padStart(2, '0')}`;
          if (!cases.includes(id)) add('omitted-mandatory-case', id, where);
        }
        list(condition, 'beforeDEV12Dispatch', where);
        list(condition, 'beforeTST03Dispatch', where);
        if (condition.missingEvidence !== 'pending') add('unsupported-missing-evidence-policy', condition.missingEvidence, where);
        placeholders.push({ id: `conditional-${index}`, list: 'conditionalCaseRequirements', where,
          reason: 'reviewed item-level selection and profile binding are not implemented' });
      });
    }
  } else {
    fields(selection, ['selection', 'emptySelection', 'conditionalRequiredCases'], milestone);
    text(selection, 'selection', milestone);
    if (!own(selection, 'emptySelection')) add('missing-field', 'emptySelection');
    else if (selection.emptySelection !== 'pending-unless-owner-explicitly-dropped-all-M3-items') add('unsupported-empty-selection-policy', selection.emptySelection);
    const conditions = selection.conditionalRequiredCases;
    if (!own(selection, 'conditionalRequiredCases')) add('missing-field', 'conditionalRequiredCases');
    else if (!record(conditions)) add('wrong-type', 'conditionalRequiredCases');
    else {
      if (!Object.keys(conditions).length) add('empty-list', 'conditionalRequiredCases');
      const dispatch = record(manifest['M3-dispatch']) ? manifest['M3-dispatch'].conditionalCaseRequirements : undefined;
      const expected = new Map((Array.isArray(dispatch) ? dispatch : []).filter(record)
        .filter(c => Array.isArray(c.whenAnySelected) && Array.isArray(c.requiredCases)).map(c => [c.whenAnySelected.join('/'), c.requiredCases]));
      for (const key of new Set([...expected.keys(), ...Object.keys(conditions)])) {
        const cases = list(conditions, key, `${milestone}.conditionalRequiredCases`, true);
        if (!expected.has(key) || JSON.stringify([...cases].sort()) !== JSON.stringify([...expected.get(key)].sort())) add('conditional-mismatch', key);
      }
    }
    placeholders.push({ id: 'selection', list: 'selection', where: milestone,
      reason: 'item-level selection is not implemented; owner drop-all disposition requires an authenticated external verifier' });
  }
  return { issues, requirements, placeholders };
}
/** Normative pending descriptors, never executable catalog procedures. */
export const M3_DESCRIPTORS = new Set([
  'OD-01-selected-items-recorded', 'item-level-selected-tier-case-manifest-reviewed', 'TST-03-exact-cases-and-evidence-bindings',
  'SP-T1-reviewed-branch-for-DEV14', 'SO-11-consumer-before-DEV12', 'SO-12/13-target-cases-before-DEV13/16',
  'reviewed-NormV1-schema-concrete-mixed-fixture-hashes-and-UTF16-assertions', 'case-catalog-RTN01..08-and-negative-control-specs',
  'candidate-head-server-normalized-readback-and-request-message-capture', 'web-mobile-mention-image-correlation-evidence',
]);
