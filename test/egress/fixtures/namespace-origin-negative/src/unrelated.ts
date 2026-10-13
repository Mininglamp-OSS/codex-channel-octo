import * as other from './other.js';
declare const pick: string;
let o: any;
o = other;
const k = 'sendMessage' as const;
const { a: { sendTyping } } = { a: other };
export async function unrelated(c: string) {
  await o.sendMessage(c, 'unrelated namespace'); await other[k](c, 'x'); await sendTyping(c); await (other as any)[pick](c);
  await Reflect.get(other, 'sendTyping')(c);
}
