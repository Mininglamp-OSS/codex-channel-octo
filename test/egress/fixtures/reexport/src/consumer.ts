import { sendMessage } from './barrel.js';
export async function reply(c: string) { await sendMessage(c, 'via re-export chain'); }
