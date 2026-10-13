import * as api from './octo/api.js';
const n1 = api as unknown as Record<string, any>;
const n2: any = n1;
const { sendMessage: s } = n2;
export async function chain(c: string) { await s(c, 'assertion alias chain'); }
