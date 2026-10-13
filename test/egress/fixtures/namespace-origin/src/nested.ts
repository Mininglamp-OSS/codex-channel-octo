import * as api from './octo/api.js';
const { a: { sendMessage } } = { a: api };
export async function nested(c: string) { await sendMessage(c, 'nested bypass'); await sendMessage(c, 'alias call is not a new site'); }
