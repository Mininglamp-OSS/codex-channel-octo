import * as api from './octo/api.js';
export function restParam({ ...rp }: { a: typeof api }): boolean {
  return rp !== undefined;
}
export function restNested(x: { w: { a: typeof api } }): boolean {
  const { w: { ...rn } } = x as unknown as { w: Record<string, unknown> };
  return rn !== undefined;
}
export function restDeep(x: { a: { b: typeof api } }): boolean {
  const { ...rd } = x as unknown as Record<string, number>;
  return rd !== undefined;
}
