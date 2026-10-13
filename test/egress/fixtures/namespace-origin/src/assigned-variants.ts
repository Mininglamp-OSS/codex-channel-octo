import * as api from './octo/api.js';
let a2: unknown;
a2 = api;
const { sendTyping } = a2 as typeof api;
let a3: any;
a3 = api;
let a4: any;
a4 ??= a3;
export async function variants(c: string) {
  await sendTyping(c);
  await a3.sendRichTextMessage(c, []);
  await (a4 as any)['sendMessage'](c, 'logical assignment alias');
}
