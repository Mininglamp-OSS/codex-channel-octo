import * as api from './octo/api.js';
const { sendMessage } = api;
export async function reply(c: string) { await sendMessage(c, 'shorthand bypass'); await sendMessage(c, 'second call'); }
