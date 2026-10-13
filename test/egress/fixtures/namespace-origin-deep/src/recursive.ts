import * as api from './octo/api.js';
interface Tree { ns: typeof api; child?: Tree; children: Tree[] }
interface A { b: B; label: string }
interface B { a?: A; deeper: { ns: typeof api } }
interface Box<T> { v: T; self?: Box<T> }
export function tree(t: Tree, k1: string): boolean {
  const y = t as unknown as Record<string, unknown>;
  return y[k1] !== undefined;
}
export function mutual(a: A, k2: string): boolean {
  const y = a as unknown as Record<string, unknown>;
  return y[k2] !== undefined;
}
export function boxed(b: Box<typeof api>, k3: string): boolean {
  return (b as unknown as Record<string, unknown>)[k3] !== undefined;
}
interface Nest<T> { v: T; next?: Nest<T[]> }
export function expanding(n: Nest<typeof api>, k4: string): boolean {
  return (n as unknown as Record<string, unknown>)[k4] !== undefined;
}
