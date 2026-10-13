/**
 * Runner record format (R8 §10.1): every runner emits JSON and JUnit records
 * {caseId,pin,head,environment,preconditions,steps,expected,actual,start,end,status,evidencePaths}.
 */
export const CASE_RECORD_FIELDS = ['caseId', 'pin', 'head', 'environment', 'preconditions', 'steps', 'expected', 'actual', 'start', 'end', 'status', 'evidencePaths'] as const;

export interface CaseRecord {
  caseId: string; pin: unknown; head: string; environment: unknown; preconditions: unknown; steps: unknown; expected: unknown;
  actual: unknown; start: string | null; end: string | null; status: 'passed' | 'failed' | 'pending'; evidencePaths: string[];
  file: string; title: string;
}
export interface CatalogMeta { preconditions?: unknown; steps?: unknown; expected?: unknown }
interface TaskLike {
  type: string; name: string; mode: string; meta?: Record<string, unknown>;
  file?: { name: string }; suite?: { name: string; suite?: unknown; filepath?: string };
  result?: { state?: string; startTime?: number; duration?: number; errors?: Array<{ message?: string }> };
}

const CASE_ID_RE = /^([A-Z][A-Z0-9]*(?:-[A-Za-z0-9.]+)+)(?: \([^)]*\))?:/;

function fullTitle(t: TaskLike): string {
  const names: string[] = [];
  let s = t.suite as (TaskLike['suite'] & { suite?: unknown }) | undefined;
  while (s && !s.filepath && s !== (t.file as unknown)) {
    if (s.name) names.unshift(s.name);
    s = s.suite as typeof s;
  }
  return [...names, t.name].join(' > ');
}

export function buildCaseRecords(tasks: TaskLike[], ctx: { pins: unknown; head: string; environment: unknown; catalog: Record<string, CatalogMeta> }): CaseRecord[] {
  return tasks.map((t) => {
    const file = t.file?.name ?? '';
    const title = fullTitle(t);
    const id = CASE_ID_RE.exec(t.name)?.[1];
    const caseId = id ?? `${file}#${title}`;
    const cat = (id && (ctx.catalog[id] ?? ctx.catalog[id.replace(/[a-z]+$/, '')])) || {};
    const state = t.result?.state;
    const status = state === 'pass' ? 'passed' : state === 'fail' ? 'failed' : 'pending';
    const errors = (t.result?.errors ?? []).map((e) => e.message ?? String(e));
    const metaActual = t.meta?.actual;
    const actual = status === 'failed'
      ? { ...(metaActual && typeof metaActual === 'object' ? metaActual : metaActual === undefined ? {} : { value: metaActual }), errors }
      : metaActual ?? null;
    const start = t.result?.startTime !== undefined ? new Date(t.result.startTime).toISOString() : null;
    const end = t.result?.startTime !== undefined ? new Date(t.result.startTime + (t.result.duration ?? 0)).toISOString() : null;
    return {
      caseId, pin: ctx.pins, head: ctx.head, environment: ctx.environment,
      preconditions: cat.preconditions ?? null, steps: cat.steps ?? null, expected: cat.expected ?? title,
      actual, start, end, status, evidencePaths: (t.meta?.evidencePaths as string[] | undefined) ?? [], file, title,
    };
  });
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const prop = (k: string, v: unknown) => `      <property name="${k}" value="${esc(typeof v === 'string' ? v : JSON.stringify(v ?? null))}"/>`;

export function toJUnit(records: CaseRecord[], name: string): string {
  const failures = records.filter((r) => r.status === 'failed').length;
  const skipped = records.filter((r) => r.status === 'pending').length;
  const cases = records.map((r) => {
    const secs = r.start && r.end ? ((Date.parse(r.end) - Date.parse(r.start)) / 1000).toFixed(3) : '0';
    const props = CASE_RECORD_FIELDS.map((f) => prop(f, r[f])).join('\n');
    const body = r.status === 'failed'
      ? `\n      <failure message="${esc(((r.actual as { errors?: string[] })?.errors ?? []).join('; '))}"/>`
      : r.status === 'pending' ? '\n      <skipped/>' : '';
    return `    <testcase classname="${esc(r.file)}" name="${esc(r.title)}" time="${secs}">\n    <properties>\n${props}\n    </properties>${body}\n    </testcase>`;
  }).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<testsuites name="${esc(name)}">\n  <testsuite name="${esc(name)}" tests="${records.length}" failures="${failures}" skipped="${skipped}">\n${cases}\n  </testsuite>\n</testsuites>\n`;
}
