import { egressSend } from './egress/index.js';
import type { GroupMember } from './octo/api.js';
export async function reply(c: string, m: GroupMember) { await egressSend(c, m.uid); }
