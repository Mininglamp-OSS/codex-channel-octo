import { sendMessage, sendRichTextMessage, sendTyping } from '../octo/api.js';
export async function egressSend(c: string, t: string) { await sendTyping(c); await sendMessage(c, t); await sendRichTextMessage(c, [{ type: 'text', text: t }]); }
