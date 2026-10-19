import * as api from './octo/api.js';
let x: any;
let y: any;
let z: any;
x = y;
y = x;
y = api;
z = z;
z = (z as any);
export async function cyclic(c: string) { await x.sendTyping(c); await z?.sendTyping?.(c); }
