import { createInterface } from 'node:readline';
// Synthetic coordinator relay fixture; it is not the production MCP host.
for await (const line of createInterface({ input: process.stdin })) {
  const request = JSON.parse(line);
  const response = await fetch(process.argv[2], { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(request) });
  process.stdout.write(JSON.stringify(await response.json()) + '\n');
}
