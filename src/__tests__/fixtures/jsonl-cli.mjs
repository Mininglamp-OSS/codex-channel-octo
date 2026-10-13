#!/usr/bin/env node
import { writeFileSync } from 'node:fs';

process.stdin.resume();
process.on('SIGTERM', () => {
  if (process.env.JSONL_TERMINATED_FILE) writeFileSync(process.env.JSONL_TERMINATED_FILE, 'terminated');
  process.exit(0);
});
const emit = (event) => process.stdout.write(JSON.stringify(event) + '\n');
emit({ type: 'thread.started', thread_id: 'synthetic-thread' });
if (process.env.JSONL_FIXTURE_MODE === 'malformed') {
  process.stdout.write('{"type":"item.completed","item":{"type":"command_execution","aggregated_output":"SYNTHETIC_PRIVATE_OUTPUT\n');
  setInterval(() => {}, 1000);
} else {
  const output = 'synthetic\r\n\v\f\u0085\u2028\u2029'.repeat(20_000);
  const event = JSON.stringify({ type: 'item.completed', item: { id: 'command', type: 'command_execution',
    command: 'synthetic', aggregated_output: output, exit_code: 0, status: 'completed' } }) + '\n';
  const bytes = Buffer.from(event);
  for (let offset = 0; offset < bytes.length; offset += 4093) process.stdout.write(bytes.subarray(offset, offset + 4093));
  emit({ type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1, cached_input_tokens: 0 } });
}
