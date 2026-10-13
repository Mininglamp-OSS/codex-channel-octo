import { ns } from './barrel-ns.js';
let n: any;
n = ns;
export async function viaNamespaceReexport(c: string) { await n.sendMessage(c, 'namespace re-export'); }
