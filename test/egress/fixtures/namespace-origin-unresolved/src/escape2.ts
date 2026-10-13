import * as api from './octo/api.js';
let sm: any;
({ sendTyping: sm } = api);
const boxed = [api];
export async function stores(c: string) { await sm(c); await boxed[0].sendMessage(c, 'array element'); }
