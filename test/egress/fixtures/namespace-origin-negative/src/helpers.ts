import * as api from './octo/api.js';
let a: any;
a = api;
const { registerBot, getGroupMembers } = a;
const k = 'getGroupMembers' as const;
const { a: { registerBot: rb } } = { a: api };
export async function helpers() {
  await registerBot(); await getGroupMembers('g'); await a['registerBot'](); await api[k]('g'); await rb();
  await a.getGroupMembers('g');
}
