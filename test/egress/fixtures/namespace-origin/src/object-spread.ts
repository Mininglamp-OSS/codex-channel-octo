import * as api from './octo/api.js';
const o = { ...api };
const p = { inner: o };
let q: any;
q = p;
export async function spread(c: string) { await q.inner.sendTyping(c); }
