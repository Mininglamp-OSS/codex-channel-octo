import * as api from './octo/api.js';
const key = 'sendMessage' as const;
export async function constant(c: string) { await api[key](c, 'constant computed key bypass'); }
