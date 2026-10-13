import * as api from './octo/api.js';
let alias: any;
alias = api;
const { sendMessage } = alias;
export async function assigned(c: string) { await sendMessage(c, 'assigned erased alias bypass'); await sendMessage(c, 'again'); }
