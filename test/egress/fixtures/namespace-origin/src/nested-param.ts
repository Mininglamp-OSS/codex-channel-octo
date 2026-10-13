import type * as api from './octo/api.js';
export async function typedNested({ a: { sendTyping } }: { a: typeof api }, c: string) { await sendTyping(c); }
