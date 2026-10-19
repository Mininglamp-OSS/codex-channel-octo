/** Shared ledger: generated stubs retain this array by reference. */
export function beginVectors(state) {
  const ledger = state.__ocStubCalls ??= [];
  const initCalls = [...ledger];
  ledger.length = 0;
  return initCalls;
}
export function assertPureVectors(state) {
  const count = (state.__ocStubCalls ?? []).length;
  if (count) throw new Error(`stubbed host package invoked while computing vectors: ${state.__ocStubCalls.join(', ')}`);
  return count;
}
