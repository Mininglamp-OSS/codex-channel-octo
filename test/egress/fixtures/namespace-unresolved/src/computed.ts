import * as api from './octo/api.js';
declare const key: 'sendMessage' | 'registerBot';
const { [key]: dynamicPick } = api;
const { ['sendTyping']: literalPick } = api;
export async function viaComputed(c: string) { await dynamicPick(c, 'x'); await literalPick(c); }
