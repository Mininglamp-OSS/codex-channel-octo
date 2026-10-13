import * as api from './octo/api.js';
let lk = 'registerBot';
lk = 'sendMessage';
export async function letKey() { await api[lk as 'registerBot'](); }
