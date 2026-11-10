import { types as utilTypes } from 'node:util';
import { isNativeDomAccessor } from './native-error.js';
import { limitText } from './error-details.js';

export function safeFailureReflection(value: unknown): boolean {
  let cursor: unknown = value;
  for (let depth = 0; cursor !== null && (typeof cursor === 'object' || typeof cursor === 'function'); depth++) {
    if (depth >= 32 || utilTypes.isProxy(cursor)) return false;
    for (const key of ['message', 'name', 'code', 'syscall', 'cause', 'snapshot', 'report']) {
      const descriptor = Object.getOwnPropertyDescriptor(cursor, key);
      if (descriptor && !('value' in descriptor) && !isNativeDomAccessor(value, cursor, key, descriptor)) return false;
    }
    cursor = Object.getPrototypeOf(cursor);
  }
  return true;
}
/** Snapshot a data property without invoking an accessor, including on a prototype.
 * Keep this read explicit even after reflection validation, rather than relying
 * on the validation guard's short-circuit ordering to protect error.cause. */
export function readDataProperty(value: object, key: string): unknown {
  let cursor: object | null = value;
  for (let depth = 0; cursor !== null && depth < 32; depth++) {
    if (utilTypes.isProxy(cursor)) return undefined;
    const descriptor = Object.getOwnPropertyDescriptor(cursor, key);
    if (descriptor) return 'value' in descriptor ? descriptor.value : undefined;
    cursor = Object.getPrototypeOf(cursor);
  }
  return undefined;
}

/** Copy internal report/snapshot data before rendering it. Never call getters or
 * toJSON on a caught object's metadata, even if it imitates an AgentFailure. */
export function copyFailureData(value: unknown): unknown {
  let nodes=0;
  const path=new WeakSet<object>();
  function copy(v: unknown, depth: number): unknown {
    if(++nodes>64||depth>3)return undefined;
    if(typeof v==='string')return limitText(v,4500);
    if(v===null||typeof v==='boolean')return v;
    if(typeof v==='number')return Number.isFinite(v)?v:undefined;
    if(typeof v!=='object'||!safeFailureReflection(v)||path.has(v))return undefined;
    path.add(v);
    const record:Record<string,unknown>=Object.create(null);
    let fields=0;
    for(const key in v){
      if(++fields>16)break;
      const descriptor=Object.getOwnPropertyDescriptor(v,key);
      if(!descriptor||!('value' in descriptor))continue;
      record[key]=copy(descriptor.value,depth+1);
    }
    path.delete(v);
    return record;
  }
  return copy(value,0);
}
