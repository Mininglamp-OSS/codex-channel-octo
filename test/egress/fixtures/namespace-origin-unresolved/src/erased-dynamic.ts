import * as api from './octo/api.js';
declare const pick2: string;
let e: any;
e = api;
const { [pick2]: got } = e;
export async function erased() { await got(); await e[pick2](); }
