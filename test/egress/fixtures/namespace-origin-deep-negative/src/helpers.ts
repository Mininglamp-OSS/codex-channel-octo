import * as api from './octo/api.js';
interface Deep { outer: { inner: { ns: typeof api } } }
export async function helpers(x: { a: typeof api }, d: Deep, list: Array<typeof api>, rec: Record<string, typeof api>): Promise<void> {
  await x.a.registerBot();
  await d.outer.inner.ns.getGroupMembers('g');
  await list[0]?.registerBot();
  await rec['k']?.getGroupMembers('g');
  await (x as unknown as Record<string, { registerBot: () => Promise<unknown> }>)['a']?.registerBot();
}
