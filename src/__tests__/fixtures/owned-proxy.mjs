#!/usr/bin/env node
import { runCodexJsonlProxy } from '../../codex-jsonl-proxy.mjs';
import { fileURLToPath } from 'node:url';
runCodexJsonlProxy(fileURLToPath(new URL('./owned-cli.mjs',import.meta.url)),process.argv.slice(2));
