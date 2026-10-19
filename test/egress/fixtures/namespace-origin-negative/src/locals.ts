const local = { sendMessage: (_c: string, _t: string) => {}, sendTyping: (_c: string) => {} };
declare const pick: string;
let l: any;
l = local;
const key = 'sendMessage' as const;
const { n: { sendTyping } } = { n: local };
export function locals(c: string) {
  l.sendMessage(c, 'local object'); local[key](c, 'x'); sendTyping(c); (local as any)[pick](c);
}
