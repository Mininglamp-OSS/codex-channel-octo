import * as api from './octo/api.js';
declare const pick: string;
export async function dynamicKey() { await (api as any)[pick](); }
