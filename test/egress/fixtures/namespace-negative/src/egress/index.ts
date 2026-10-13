import * as api from '../octo/api.js';
const { sendMessage, sendTyping } = api;
export async function egressSend(c: string, t: string) { await sendTyping(c); await sendMessage(c, t); }
