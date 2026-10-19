import * as api from './octo/api.js';
const k1 = 'sendTyping';
const k2 = 'sendRichTextMessage' as const;
const k3 = (k1 satisfies string);
const { [k2]: rich } = api;
export async function variants(c: string) {
  await api[k1](c);
  await (api as any)[k3 as 'sendTyping'](c);
  await rich(c, []);
}
