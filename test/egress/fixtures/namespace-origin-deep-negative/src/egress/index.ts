import * as api from '../octo/api.js';
export function egress(x: { a: typeof api }, rec: Record<string, typeof api>, key: string): unknown {
  const y = x as unknown as Record<string, unknown>;
  const { ...rest } = x;
  return [y[key], rec[key], Reflect.get(x, key), rest];
}
