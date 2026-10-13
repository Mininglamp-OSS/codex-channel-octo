export async function sendMessage(_c: string, _t: string): Promise<void> {}
export async function sendRichTextMessage(_c: string, _b: unknown[]): Promise<void> {}
export async function sendTyping(_c: string): Promise<void> {}
export async function registerBot(): Promise<{ robot_id: string }> { return { robot_id: "x" }; }
export async function getGroupMembers(_g: string): Promise<string[]> { return []; }
export interface GroupMember { uid: string }
