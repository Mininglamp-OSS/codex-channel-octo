import * as api from './octo/api.js';
interface Deep { outer: { inner: { ns: typeof api } } }
export async function literal(x: { a: typeof api }, d: Deep, list: Array<typeof api>, rec: Record<string, typeof api>): Promise<void> {
  await x.a.sendMessage('c', 'nested property');
  await d.outer.inner.ns.sendTyping('c');
  await list[0]?.sendRichTextMessage('c', []);
  await rec['k']?.sendMessage('c', 'index signature');
  await (x as unknown as Record<string, { sendTyping: (c: string) => Promise<void> }>)['a']?.sendTyping('c');
}
