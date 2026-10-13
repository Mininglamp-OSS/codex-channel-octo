import * as api from './octo/api.js';
const holder: any = {};
holder.ns = api;
export async function escape(c: string) { await holder.ns.sendMessage(c, 'property store'); await Reflect.get(api, 'sendTyping')(c); }
