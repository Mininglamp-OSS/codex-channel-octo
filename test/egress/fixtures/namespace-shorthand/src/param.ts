import type * as api from './octo/api.js';
export async function typing({ sendTyping }: typeof api, c: string) { await sendTyping(c); }
