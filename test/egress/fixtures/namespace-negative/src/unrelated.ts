import * as other from './other.js';
const { sendMessage, sendTyping: typing } = other;
export async function local(c: string) { await typing(c); await sendMessage(c, 'unrelated namespace'); }
export function shapes({ sendMessage: s }: { sendMessage: (c: string) => void }, c: string) { s(c); }
