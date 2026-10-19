import { sendMessage as post } from './octo/api.js';
export async function reply(c: string) { await post(c, 'aliased bypass'); }
