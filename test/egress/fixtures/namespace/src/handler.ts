import * as api from './octo/api.js';
export async function reply(c: string) { await api.sendMessage(c, 'namespace bypass'); await api['sendTyping'](c); }
