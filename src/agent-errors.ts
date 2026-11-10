import { AgentFailure, TurnFailure, failureReply, type FailureReport } from './agent-failure.js';
import { safeFailureReflection, readDataProperty, copyFailureData } from './error-reflection.js';
import { nativeErrorMessage } from './native-error.js';
import { limitText } from './error-details.js';
import { getSystemErrorMap } from 'node:util';

const safeCodes = new Set([...getSystemErrorMap().values()].map(([code]) => code));
for (const code of ['ERR_MODULE_NOT_FOUND', 'ERR_PACKAGE_PATH_NOT_EXPORTED', 'ERR_INVALID_ARG_TYPE']) safeCodes.add(code);

const GENERIC = 'Agent operation failed (details withheld)';
function inspectError(error: unknown): { error: Error; message: string; cause: unknown; causeMessage: string; code: unknown } | undefined {
  if(!safeFailureReflection(error)||!(error instanceof Error))return undefined;
  const cause=readDataProperty(error,'cause');
  if(!safeFailureReflection(cause))return undefined;
  const message=readDataProperty(error,'message')??nativeErrorMessage(error)??'';
  const causeMessage=cause instanceof Error?(readDataProperty(cause,'message')??nativeErrorMessage(cause)??''):'';
  if(typeof message!=='string'||typeof causeMessage!=='string')return undefined;
  return {error,message,cause,causeMessage,code:readDataProperty(error,'code')};
}
export function isSdkJsonlParseError(error: unknown): error is Error {
  const facts=inspectError(error);
  return !!facts && facts.message.startsWith('Failed to parse item:') && facts.cause instanceof SyntaxError;
}

export function summarizeAgentError(error: unknown): string {
  // Shared validation must precede instanceof and all property access. Render
  // only copied data, so getters/serializers cannot replace an original failure.
  try {
    const facts=inspectError(error);
    if(!facts)return GENERIC;
    if(error instanceof TurnFailure) {
      const report=copyFailureData(readDataProperty(error,'report'));
      return report ? failureReply(report as FailureReport) : GENERIC;
    }
    if(error instanceof AgentFailure) {
      const snapshot=copyFailureData(readDataProperty(error,'snapshot'));
      return snapshot ? limitText(JSON.stringify(snapshot),4500) : GENERIC;
    }
    if(facts.message.startsWith('Failed to parse item:')&&facts.cause instanceof SyntaxError) {
      const category=/Unterminated string|Unexpected end of JSON/i.test(facts.causeMessage)?'incomplete-json':'invalid-json';
      return `Codex SDK JSONL parse failure (${category})`;
    }
    if(facts.message.startsWith('CODEX_JSONL_PROXY_BOOTSTRAP_FAILURE:')) {
      return 'Codex JSONL proxy bootstrap failed; reinstall dependencies and run npm run build';
    }
    const exit=/^Codex Exec exited with (signal SIG[A-Z]+|code \d+):/.exec(facts.message);
    if(exit)return `Codex process exited with ${exit[1]}`;
    if(/stream closed before response\.completed|stream disconnected before completion/i.test(facts.message)) {
      return 'Codex response stream interrupted';
    }
    const code=facts.code;
    const name=error instanceof TypeError?'TypeError':error instanceof RangeError?'RangeError'
      :error instanceof SyntaxError?'SyntaxError':error instanceof ReferenceError?'ReferenceError':'Error';
    return typeof code==='string'&&safeCodes.has(code)
      ?`${name}: agent operation failed (${code})`:`${name}: agent operation failed (details withheld)`;
  } catch { return GENERIC; }
}
