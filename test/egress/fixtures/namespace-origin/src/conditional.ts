import * as api from './octo/api.js';
let cnd: any;
cnd = Math.random() > 2 ? api : undefined;
export async function conditional(c: string) { await cnd?.sendTyping(c); }
