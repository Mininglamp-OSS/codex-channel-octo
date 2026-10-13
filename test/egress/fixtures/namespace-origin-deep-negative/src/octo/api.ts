export async function sendMessage(c: string, t: string): Promise<void> { void c; void t; }
export async function sendRichTextMessage(c: string, b: unknown[]): Promise<void> { void c; void b; }
export async function sendTyping(c: string): Promise<void> { void c; }
export async function registerBot(): Promise<{ robot_id: string }> { return { robot_id: "x" }; }
export async function getGroupMembers(g: string): Promise<string[]> { return [g]; }
export interface GroupMember { uid: string }
