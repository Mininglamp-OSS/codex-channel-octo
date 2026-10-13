#!/usr/bin/env node
import { fileURLToPath } from 'node:url';
import { runCodexJsonlProxy } from '../../codex-jsonl-proxy.mjs';

runCodexJsonlProxy(fileURLToPath(new URL('./jsonl-cli.mjs', import.meta.url)), process.argv.slice(2));
