/**
 * Projection of app-server v2 notifications onto the SDK `ThreadEvent` shape
 * the bridge already consumes, so the selection, progress, risk and failure
 * rules of the `exec` path apply unchanged (G-A1).
 *
 * - Only notifications of the bound thread and turn are projected; anything
 *   else is dropped by the caller before reaching here.
 * - `error` with `willRetry: true` is a reconnect notice and projects to
 *   nothing; `willRetry: false` projects to an SDK `error` event, which the
 *   bridge defers until the terminal state is known.
 * - `dynamicToolCall` items are card activity: never a message or work item,
 *   only an effect signal.
 * - Agent message deltas are not projected; the completed item carries the
 *   full text, as with `exec`.
 */
import type { ThreadEvent, ThreadItem, Usage } from '@openai/codex-sdk';

export type Projection =
  | { readonly kind: 'event'; readonly event: ThreadEvent }
  | { readonly kind: 'card_effect' }
  | { readonly kind: 'terminal'; readonly event: ThreadEvent }
  | { readonly kind: 'retry_notice' };

type Raw = Record<string, unknown>;

const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const obj = (v: unknown): Raw => (v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Raw : {});

function status(v: unknown): 'in_progress' | 'completed' | 'failed' {
  return v === 'completed' ? 'completed' : v === 'inProgress' ? 'in_progress' : 'failed';
}

/** v2 `ThreadItem` → SDK `ThreadItem`; null for items the exec stream never carried. */
export function projectItem(item: unknown): ThreadItem | null {
  const i = obj(item);
  const id = str(i.id);
  switch (i.type) {
    case 'agentMessage': {
      const phase = i.phase === 'commentary' || i.phase === 'partial_answer' || i.phase === 'final_answer' ? { phase: i.phase } : {};
      return { id, type: 'agent_message', text: str(i.text), ...phase } as ThreadItem;
    }
    case 'reasoning': {
      const summary = Array.isArray(i.summary) ? i.summary.filter((s): s is string => typeof s === 'string') : [];
      return { id, type: 'reasoning', text: summary.join('\n') };
    }
    case 'commandExecution':
      return {
        id, type: 'command_execution', command: str(i.command), aggregated_output: str(i.aggregatedOutput),
        ...(typeof i.exitCode === 'number' ? { exit_code: i.exitCode } : {}), status: status(i.status),
      };
    case 'fileChange': {
      const changes = Array.isArray(i.changes) ? i.changes.map((c) => {
        const kind = str(obj(obj(c).kind).type);
        return { path: str(obj(c).path), kind: (kind === 'add' || kind === 'delete' ? kind : 'update') as 'add' | 'delete' | 'update' };
      }) : [];
      return { id, type: 'file_change', changes, status: status(i.status) as 'completed' | 'failed' };
    }
    case 'mcpToolCall': {
      const error = obj(i.error);
      return {
        id, type: 'mcp_tool_call', server: str(i.server), tool: str(i.tool), arguments: i.arguments, status: status(i.status),
        ...(typeof error.message === 'string' ? { error: { message: error.message } } : {}),
      };
    }
    case 'webSearch':
      return { id, type: 'web_search', query: str(i.query) };
    default:
      return null;
  }
}

function usage(tokens: unknown): Usage {
  const last = obj(obj(tokens).last);
  const n = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
  return {
    input_tokens: n(last.inputTokens), cached_input_tokens: n(last.cachedInputTokens),
    cache_write_input_tokens: n(last.cacheWriteInputTokens), output_tokens: n(last.outputTokens),
    reasoning_output_tokens: n(last.reasoningOutputTokens),
  };
}

/** Stateful per-turn projector (plan → todo_list item, token usage → terminal usage). */
export class TurnProjector {
  private tokens: unknown;
  private planSeen = false;
  private plan: ThreadItem | undefined;

  constructor(private readonly turnId: string) {}

  project(method: string, params: unknown): Projection[] {
    const p = obj(params);
    switch (method) {
      case 'turn/started':
        return [{ kind: 'event', event: { type: 'turn.started' } }];
      case 'item/started':
      case 'item/completed': {
        const item = obj(p.item);
        if (item.type === 'dynamicToolCall') return method === 'item/completed' ? [{ kind: 'card_effect' }] : [];
        const projected = projectItem(item);
        if (projected === null) return [];
        return [{ kind: 'event', event: { type: method === 'item/started' ? 'item.started' : 'item.completed', item: projected } }];
      }
      case 'turn/plan/updated': {
        const plan = Array.isArray(p.plan) ? p.plan : [];
        const item: ThreadItem = {
          id: `plan-${this.turnId}`, type: 'todo_list',
          items: plan.map((s) => ({ text: str(obj(s).step), completed: obj(s).status === 'completed' })),
        };
        const type = this.planSeen ? 'item.updated' : 'item.started';
        this.planSeen = true;
        this.plan = item;
        return [{ kind: 'event', event: { type, item } }];
      }
      case 'thread/tokenUsage/updated':
        this.tokens = p.tokenUsage;
        return [];
      case 'error': {
        if (p.willRetry === true) return [{ kind: 'retry_notice' }];
        return [{ kind: 'event', event: { type: 'error', message: str(obj(p.error).message) } }];
      }
      case 'turn/completed': {
        const turn = obj(p.turn);
        const plan: Projection[] = this.plan !== undefined ? [{ kind: 'event', event: { type: 'item.completed', item: this.plan } }] : [];
        if (turn.status === 'completed') return [...plan, { kind: 'terminal', event: { type: 'turn.completed', usage: usage(this.tokens) } }];
        const message = turn.status === 'interrupted' ? 'turn interrupted' : str(obj(turn.error).message);
        return [...plan, { kind: 'terminal', event: { type: 'turn.failed', error: { message } } }];
      }
      default:
        return [];
    }
  }
}
