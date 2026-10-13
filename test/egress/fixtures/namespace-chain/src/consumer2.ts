import * as barrel2 from './barrel2.js';
const { send } = barrel2;
export async function reply2(c: string) { await send(c, 'shorthand through two-hop re-export'); }
