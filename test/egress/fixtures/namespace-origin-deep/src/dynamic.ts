import * as api from './octo/api.js';
export function reflected(x: { a: { b: typeof api } }, key: string): unknown {
  return Reflect.get(x, key);
}
export function enumerated(x: { a: typeof api }): number {
  let n = 0;
  for (const k in x) if (x[k as keyof typeof x] !== undefined) n++;
  return n;
}
