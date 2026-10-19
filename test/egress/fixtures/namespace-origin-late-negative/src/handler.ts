import * as api from './octo/api.js';
type Leaf = Pick<typeof api, 'registerBot'>;
type Layer<T extends unknown[]> = T['length'] extends 5 ? Leaf : { next: Layer<[...T, unknown]> };
export function f(x: Layer<[]>) {
  const { ...rest } = x as unknown as Record<string, unknown>;
  void rest;
}
