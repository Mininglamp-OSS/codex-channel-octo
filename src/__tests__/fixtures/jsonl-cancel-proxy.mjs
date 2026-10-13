import { runCodexJsonlProxy } from '../../codex-jsonl-proxy.mjs';
import { fileURLToPath } from 'node:url';
runCodexJsonlProxy(fileURLToPath(new URL('./jsonl-cancel-cli.mjs', import.meta.url)), []);
