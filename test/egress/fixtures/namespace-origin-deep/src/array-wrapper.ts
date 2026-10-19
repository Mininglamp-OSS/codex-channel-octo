import * as api from './octo/api.js';
export function list(x: { list: Array<typeof api> }, k1: string): boolean {
  const y = x as unknown as Record<string, unknown>;
  return y[k1] !== undefined;
}
export function tuple(x: { tuple: [string, typeof api] }, k2: string): boolean {
  const y = x as unknown as Record<string, unknown>;
  return y[k2] !== undefined;
}
export function nested(x: { nested: ReadonlyArray<(typeof api)[]> }, k3: string): boolean {
  const y = x as unknown as Record<string, unknown>;
  return y[k3] !== undefined;
}
