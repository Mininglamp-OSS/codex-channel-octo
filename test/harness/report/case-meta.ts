/** Attach actual observations and evidence paths to the running case (read by the case reporter). */
export function recordCase(ctx: { task: { meta: object } }, actual: unknown, evidencePaths: string[] = []): void {
  const meta = ctx.task.meta as Record<string, unknown>;
  meta.actual = actual;
  meta.evidencePaths = [...new Set(evidencePaths)];
}
