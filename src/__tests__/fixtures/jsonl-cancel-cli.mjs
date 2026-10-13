import { writeFileSync } from 'node:fs';
writeFileSync(process.env.JSONL_CHILD_PID_FILE, String(process.pid));
function flood() {
  let writable = true;
  while (writable) writable = process.stdout.write(JSON.stringify({ text: 'synthetic'.repeat(8000) }) + '\n');
}
if (process.env.JSONL_FIXTURE_MODE === 'signal-flush') {
  for (let index = 0; index < 3000; index++) process.stdout.write(JSON.stringify({ index, text: 'synthetic'.repeat(100) }) + '\n');
  process.stdout.write('', () => process.kill(process.pid, 'SIGTERM'));
} else {
  process.on('SIGTERM', () => {});
  process.stdin.resume();
  process.stdout.on('drain', flood);
  flood();
}
