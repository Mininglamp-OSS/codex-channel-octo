import * as api from './octo/api.js';
const { sendRichTextMessage, registerBot } = api;
export async function rich(c: string) { await registerBot(); await sendRichTextMessage(c, []); }
