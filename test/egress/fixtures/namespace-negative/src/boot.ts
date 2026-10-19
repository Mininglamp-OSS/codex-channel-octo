import * as api from './octo/api.js';
const { registerBot, getGroupMembers } = api;
export async function boot() { await registerBot(); return getGroupMembers('g'); }
