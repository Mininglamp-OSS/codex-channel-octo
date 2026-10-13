import * as api from './octo/api.js';
const { registerBot, ...rest } = api;
export async function viaRest(c: string) { await registerBot(); await rest.sendMessage(c, 'rest bypass'); }
