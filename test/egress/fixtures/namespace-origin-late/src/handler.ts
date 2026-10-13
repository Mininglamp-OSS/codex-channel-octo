import * as api from './octo/api.js';
type Leaf = typeof api;
type Layer<T extends unknown[]> = T['length'] extends 5 ? Leaf : { next: Layer<[...T, unknown]> };
export function f(x: Layer<[]>) {
  const { ...rest } = x as unknown as Record<string, unknown>;
  const y = rest as unknown as { next: { next: { next: { next: { next: { sendMessage: () => void } } } } } };
  y.next.next.next.next.next.sendMessage();
}
type ImportLayer<T extends unknown[]> = T['length'] extends 5
  ? typeof import('./octo/api.js') : { next: ImportLayer<[...T, unknown]> };
export function g(x: ImportLayer<[]>) {
  const { ...rest } = x as unknown as Record<string, unknown>;
  void rest;
}
