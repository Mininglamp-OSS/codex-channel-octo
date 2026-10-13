import { apiNs } from './barrel-local.js';
let m: any;
m = apiNs;
const { sendTyping } = m;
export async function viaLocalReexport(c: string) { await sendTyping(c); }
