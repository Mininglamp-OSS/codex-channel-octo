import { AgentFailure, TurnFailure } from './agent-failure.js';
import { getSystemErrorMap } from 'node:util';

const safeCodes = new Set([...getSystemErrorMap().values()].map(([code]) => code));
for (const code of ['ERR_MODULE_NOT_FOUND', 'ERR_PACKAGE_PATH_NOT_EXPORTED', 'ERR_INVALID_ARG_TYPE']) safeCodes.add(code);

export function isSdkJsonlParseError(error: unknown): error is Error {
  return error instanceof Error && error.message.startsWith('Failed to parse item:')
    && error.cause instanceof SyntaxError;
}

export function summarizeAgentError(error: unknown): string {
  if (error instanceof TurnFailure) return JSON.stringify(error.report);
  if (error instanceof AgentFailure) return JSON.stringify(error.snapshot);
  if (isSdkJsonlParseError(error)) {
    const cause = (error.cause as SyntaxError).message;
    const category = /Unterminated string|Unexpected end of JSON/i.test(cause) ? 'incomplete-json' : 'invalid-json';
    return `Codex SDK JSONL parse failure (${category})`;
  }
  if (error instanceof Error) {
    if (error.message.startsWith('CODEX_JSONL_PROXY_BOOTSTRAP_FAILURE:')) {
      return 'Codex JSONL proxy bootstrap failed; reinstall dependencies and run npm run build';
    }
    const exit = /^Codex Exec exited with (signal SIG[A-Z]+|code \d+):/.exec(error.message);
    if (exit) return `Codex process exited with ${exit[1]}`;
    if (/stream closed before response\.completed|stream disconnected before completion/i.test(error.message)) {
      return 'Codex response stream interrupted';
    }
    const code = (error as NodeJS.ErrnoException).code;
    const name = error instanceof TypeError ? 'TypeError' : error instanceof RangeError ? 'RangeError'
      : error instanceof SyntaxError ? 'SyntaxError' : error instanceof ReferenceError ? 'ReferenceError' : 'Error';
    return typeof code === 'string' && safeCodes.has(code)
      ? `${name}: agent operation failed (${code})` : `${name}: agent operation failed (details withheld)`;
  }
  return 'Agent operation failed (details withheld)';
}
