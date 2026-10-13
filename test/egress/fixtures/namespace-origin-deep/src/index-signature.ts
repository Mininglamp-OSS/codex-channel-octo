import * as api from './octo/api.js';
export function stringIndex(x: Record<string, typeof api>, k1: string): boolean {
  return x[k1] !== undefined;
}
export function nestedIndex(x: { [name: string]: { inner: typeof api } }, k2: string): boolean {
  const y = x as unknown as Record<string, Record<string, unknown>>;
  return y.slot?.[k2] !== undefined;
}
export function numberIndex(x: { [i: number]: typeof api }, k3: number): boolean {
  return x[k3] !== undefined;
}
export function literalKeys(x: { m: Record<'a' | 'b', typeof api> }, k4: string): boolean {
  const y = x as unknown as Record<string, unknown>;
  return y[k4] !== undefined;
}
