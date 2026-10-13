import { sendCard } from './octo/api.js';
export async function show(c: string) { await sendCard(c); }
