import * as api from './octo/api.js';
const { a: { b: { sendTyping } } } = { a: { b: api } };
export async function deep(c: string) { await sendTyping(c); }
