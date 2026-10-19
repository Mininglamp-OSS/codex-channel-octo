import * as api from './octo/api.js';
const { sendMessage: post } = api;
export async function reply(c: string) { await post(c, 'renamed bypass'); await post(c, 'second call'); }
