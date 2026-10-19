/** Offline maintenance only. External results must be checked by the operator first. */
import { writeFileSync, unlinkSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createAdapter } from './db-adapter.js';
import { SessionStore } from './session-store.js';
type ReconciliationCode = 'acknowledgment_required' | 'database_missing' | 'gateway_locked' | 'turn_mismatch';
export class ReconciliationError extends Error {
  constructor(readonly code: ReconciliationCode) { super(code); }
}
export function reconciliationMessage(error: unknown): string {
  if (error instanceof ReconciliationError) {
    const messages: Record<ReconciliationCode, string> = {
      acknowledgment_required: 'Verify external effects and supply the database/session/turn IDs plus --external-results-verified.',
      database_missing: 'The reconciliation database does not exist.',
      gateway_locked: 'The gateway lock is held. Use the registered-owner in-chat command, or stop the gateway before offline maintenance.',
      turn_mismatch: 'No quarantined turn matches this session and turn ID.',
    };
    return messages[error.code];
  }
  return 'Local reconciliation I/O failed; check database access and filesystem permissions.';
}
export function reconcile(database: string, session: string, turnId: string, acknowledged: boolean): boolean {
  if (!acknowledged || !database || !session || !turnId) throw new ReconciliationError('acknowledgment_required');
  if (!existsSync(database)) throw new ReconciliationError('database_missing');
  const lock = join(dirname(resolve(database)), 'gateway.lock');
  // Share the gateway O_EXCL lock protocol; refuse existing locks, even stale ones.
  try {
    writeFileSync(lock, `${process.pid} ${randomUUID()}`, { flag: 'wx', mode: 0o600 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new ReconciliationError('gateway_locked');
    throw error;
  }
  try {
    const store = new SessionStore(createAdapter(database));
    try { store.init(); return store.reconcileTurn(session, turnId); }
    finally { store.close(); }
  } finally { unlinkSync(lock); }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [db, session, turn, confirm] = process.argv.slice(2);
  try {
    if (!reconcile(db, session, turn, confirm === '--external-results-verified')) throw new ReconciliationError('turn_mismatch');
    console.log('Execution quarantine released; no model or tool was rerun');
  } catch (error) {
    console.error(`Reconciliation refused: ${reconciliationMessage(error)}`);
    process.exitCode = 1;
  }
}
