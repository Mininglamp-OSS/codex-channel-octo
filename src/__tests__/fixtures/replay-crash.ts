import { createAdapter } from '../../db-adapter.js';
import { ReplayJournal } from '../../permissions/replay-journal.js';

const file = process.argv.at(-1);
if (!file) throw new Error('Synthetic journal path required');
const db = createAdapter(file);
const journal = new ReplayJournal(db, Buffer.alloc(32, 7), '1', { provision: true });
const reservation = journal.reserve({
  origin: 'https://synthetic.invalid', recipientBotUid: 'synthetic-bot', streamId: 'synthetic-stream',
  streamIncarnation: '1'.repeat(32), sequence: '18446744073709551615', messageId: '9223372036854775807',
  messageVersion: 'native_version', payloadSha256: '2'.repeat(64),
});
if (reservation.disposition !== 'reserved') throw new Error('Synthetic reservation failed');
process.stdout.write('RESERVED\n');
// The parent kills this process without close/checkpoint/finish.
setInterval(() => {}, 1000);
