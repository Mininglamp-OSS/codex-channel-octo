interface Node { send: { sendMessage: (c: string) => void }; next?: Node; peers: Node[]; byId: Record<string, Node> }
const local = { sendMessage: (c: string) => { void c; }, sendTyping: (c: string) => { void c; } };
export function locals(n: Node, key: string, when: Date, values: Map<string, string>): boolean {
  const y = n as unknown as Record<string, unknown>;
  const { ...rest } = { inner: local, n };
  n.send.sendMessage('c');
  local.sendMessage('c');
  return y[key] !== undefined && Reflect.get(rest, key) !== undefined && Reflect.get(when, key) !== undefined
    && Reflect.get(values, key) !== undefined && String(when).length > 0;
}
