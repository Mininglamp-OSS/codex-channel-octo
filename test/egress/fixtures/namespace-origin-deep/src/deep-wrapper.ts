import * as api from './octo/api.js';
interface Deep { outer: { inner: { ns: typeof api } } }
type Erased = Record<string, Record<string, Record<string, Record<string, () => void>>>>;
export function deep(x: Deep, k1: string): void {
  const y = x as unknown as Erased;
  y.outer?.inner?.[k1]?.['sendTyping']?.();
}
export async function contextual(x: Deep | undefined, k2: string, flag: boolean): Promise<void> {
  const y = (flag ? (x! satisfies Deep) : undefined) as unknown as Erased | undefined;
  const z = (await (y ?? ({} as Erased)).outer)!;
  z[k2]?.['ns']?.['sendTyping']?.();
}
