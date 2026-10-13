import { registerBot, getGroupMembers } from './octo/api.js';
export async function boot() { await registerBot(); return getGroupMembers('g'); }
