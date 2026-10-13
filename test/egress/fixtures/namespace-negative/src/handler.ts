import { egressSend } from './egress/index.js';
export async function reply(c: string) { await egressSend(c, 'through egress'); }
