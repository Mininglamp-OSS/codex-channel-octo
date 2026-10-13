import * as api from '../octo/api.js';
declare const pick: string;
let e: any;
e = api;
const key = 'sendMessage' as const;
export async function egress(c: string) { await e.sendMessage(c, 'egress'); await api[key](c, 'x'); await e[pick](c); return api; }
