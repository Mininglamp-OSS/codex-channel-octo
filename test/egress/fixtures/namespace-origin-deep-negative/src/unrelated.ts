import * as other from './other.js';
interface Deep { outer: { inner: { ns: typeof other } } }
interface Tree { ns: typeof other; child?: Tree; children: Tree[]; map: Record<string, Tree> }
interface A { b: B; label: string }
interface B { a?: A; deeper: { ns: typeof other }; list: A[] }
interface Box<T> { v: T; self?: Box<T> }
interface Nest<T> { v: T; next?: Nest<T[]>; wide?: Nest<[T, T]> }
export function unrelated(x: Deep, t: Tree, a: A, b: Box<typeof other>, rec: Record<string, typeof other>, key: string): boolean {
  const y = x as unknown as Record<string, Record<string, unknown>>;
  const { ...rest } = t as unknown as Record<string, unknown>;
  return y.outer?.[key] !== undefined && rest[key] !== undefined && Reflect.get(a, key) !== undefined
    && (b as unknown as Record<string, unknown>)[key] !== undefined && rec[key] !== undefined;
}
export async function unrelatedCalls(x: Deep, list: Array<typeof other>): Promise<void> {
  await x.outer.inner.ns.sendMessage('c', 'unrelated namespace');
  await list[0]?.sendTyping('c');
}
export function expanding(n: Nest<typeof other>, m: Nest<string>, key: string): boolean {
  return (n as unknown as Record<string, unknown>)[key] !== undefined && Reflect.get(m, key) !== undefined;
}
