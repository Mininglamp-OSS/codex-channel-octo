import { types as utilTypes } from 'node:util';

// Capture the built-in DOMException accessors once. Invoke these intrinsics
// directly, never an SDK/user-supplied getter. Node's accessor brand check uses
// its private WeakMap and does not walk the receiver's prototype chain.
const domPrototype = DOMException.prototype;
const domGetters = new Map(['message', 'name', 'code'].map(key =>
  [key, Object.getOwnPropertyDescriptor(domPrototype, key)?.get] as const));

function domField(value: unknown, key: string): unknown {
  if (utilTypes.isProxy(value) || !utilTypes.isNativeError(value)) return;
  try { return domGetters.get(key)?.call(value); } catch { return; }
}

export function isNativeDomAccessor(value: unknown, prototype: object, key: string, descriptor: PropertyDescriptor): boolean {
  return prototype === domPrototype && descriptor.set === undefined
    && descriptor.get !== undefined && descriptor.get === domGetters.get(key)
    && typeof domField(value, 'name') === 'string';
}

/** Preserve ordinary own messages and native DOMException fingerprints without
 * invoking arbitrary accessors, proxies or prototype lookups on caught values. */
export function nativeErrorMessage(value: unknown): string | undefined {
  if (utilTypes.isProxy(value) || !utilTypes.isNativeError(value)) return;
  const descriptor = Object.getOwnPropertyDescriptor(value, 'message');
  if (descriptor) return 'value' in descriptor && typeof descriptor.value === 'string' ? descriptor.value : undefined;
  const message = domField(value, 'message');
  return typeof message === 'string' ? message : undefined;
}
