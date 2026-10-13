import * as barrel from './barrel.js';
const { sendMessage } = barrel;
export async function reply(c: string) { await sendMessage(c, 'shorthand through re-export'); }
