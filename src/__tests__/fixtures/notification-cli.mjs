#!/usr/bin/env node
import { appendFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';

// Offline JSONL producer. No inference, network access or real tool execution.
const record = value => appendFileSync(process.env.NOTIFICATION_RECORD_FILE, value + '\n');
const emit = event => process.stdout.write(JSON.stringify(event) + '\n');
process.on('SIGTERM', () => { record('cancelled'); process.exit(0); });
let prompt = '';
for await (const chunk of process.stdin) prompt += chunk;
const interruption = /Task ([0-9a-f-]{36}): failed;/.exec(prompt);
if (interruption && prompt.includes('never automatically replay the previous request.')) record('interruption:' + interruption[1]);
record('launched');
emit({ type: 'thread.started', thread_id: '11111111-1111-4111-8111-111111111111' });
emit({ type: 'turn.started' });
const mode = process.env.NOTIFICATION_FIXTURE_MODE;
if (mode === 'partial-success' || mode === 'partial-eof') {
  emit({ type: 'item.updated', item: { id: 'answer', type: 'agent_message', text: 'unfinished text' } });
}
if (mode === 'work-success' || mode === 'work-silent') {
  emit({ type: 'item.completed', item: { id: 'work', type: 'command_execution',
    command: 'synthetic-command', aggregated_output: 'SYNTHETIC_PRIVATE_OUTPUT', status: 'completed', exit_code: 0 } });
}
if (mode !== 'partial-eof') {
  if (mode === 'warning-success' || mode === 'silent-item') {
    emit({ type: 'item.completed', item: { id: 'notice', type: 'error',
      message: mode === 'silent-item' ? 'authentication failed' : 'Falling back from WebSockets to HTTPS transport. Synthetic interruption' } });
  } else {
    emit({ type: 'error', message: mode.startsWith('silent-') || mode === 'work-silent' ? 'authentication failed' : 'Reconnecting... 2/5 (Synthetic interruption)' });
  }
  record('notification');
}
if (mode === 'wait') {
  setInterval(() => {}, 1000);
} else {
  // Ensure success cannot already be buffered when the consumer sees error.
  await sleep(100);
  if (mode === 'failed') {
    emit({ type: 'turn.failed', error: { message: 'authentication failed' } });
    record('failed');
  } else if (mode === 'eof' || mode === 'partial-eof') {
    record('eof');
  } else if (mode === 'malformed') {
    process.stdout.write('{"type":"item.completed"\n');
    record('malformed');
  } else {
    if (mode === 'erased-completed') emit({ type: 'item.updated', item: { id: 'answer', type: 'agent_message', text: 'discarded snapshot' } });
    if (!mode.startsWith('silent-') && mode !== 'work-silent') emit({ type: 'item.completed', item: { id: 'answer', type: 'agent_message',
      text: mode === 'blank-completed' ? ' \n' : mode === 'erased-completed' ? '' : 'completed answer' } });
    emit({ type: 'turn.completed', usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 } });
    record('completed');
    if (mode === 'exit-failure') process.exitCode = 1;
  }
}
