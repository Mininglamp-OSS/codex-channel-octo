import { sendRichTextMessage } from './octo/api.js';
export async function toolSend(c: string) { await sendRichTextMessage(c, [{ type: 'text', text: 'bypass' }]); }
