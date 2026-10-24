/** v2 notification → SDK ThreadEvent projection (pure). */
import { describe, it, expect } from 'vitest';
import { TurnProjector, projectItem } from '../app-server/events.js';

describe('projectItem', () => {
  it('maps file changes and statuses', () => {
    expect(projectItem({ type: 'fileChange', id: 'f', status: 'inProgress', changes: [{ path: 'a', kind: { type: 'add' }, diff: 'x' }, { path: 'b', kind: { type: 'update', move_path: null } }] }))
      .toEqual({ id: 'f', type: 'file_change', status: 'in_progress', changes: [{ path: 'a', kind: 'add' }, { path: 'b', kind: 'update' }] });
    expect(projectItem({ type: 'commandExecution', id: 'c', command: 'x', status: 'declined' })).toMatchObject({ status: 'failed' });
  });

  it('never projects card, user or unknown items', () => {
    for (const type of ['dynamicToolCall', 'userMessage', 'contextCompaction', 'collabAgentToolCall', 'nope']) {
      expect(projectItem({ type, id: 'i' })).toBeNull();
    }
  });

  it('keeps only known phases on agent messages', () => {
    expect(projectItem({ type: 'agentMessage', id: 'm', text: 't', phase: 'commentary' })).toEqual({ id: 'm', type: 'agent_message', text: 't', phase: 'commentary' });
    expect(projectItem({ type: 'agentMessage', id: 'm', text: 't', phase: 'weird' })).toEqual({ id: 'm', type: 'agent_message', text: 't' });
  });
});

describe('TurnProjector', () => {
  it('turns plan updates into one todo_list item, completed at the terminal', () => {
    const p = new TurnProjector('t1');
    const plan = { plan: [{ step: 'a', status: 'completed' }, { step: 'b', status: 'pending' }] };
    expect(p.project('turn/plan/updated', plan)[0]).toMatchObject({ event: { type: 'item.started', item: { id: 'plan-t1', type: 'todo_list' } } });
    expect(p.project('turn/plan/updated', plan)[0]).toMatchObject({ event: { type: 'item.updated' } });
    const end = p.project('turn/completed', { turn: { status: 'completed' } });
    expect(end.map((o) => o.kind)).toEqual(['event', 'terminal']);
    expect(end[0]).toMatchObject({ event: { type: 'item.completed', item: { items: [{ text: 'a', completed: true }, { text: 'b', completed: false }] } } });
  });

  it('a dynamic tool call is a card effect only on completion', () => {
    const p = new TurnProjector('t1');
    expect(p.project('item/started', { item: { type: 'dynamicToolCall', id: 'd' } })).toEqual([]);
    expect(p.project('item/completed', { item: { type: 'dynamicToolCall', id: 'd' } })).toEqual([{ kind: 'card_effect' }]);
  });

  it('agent message deltas are not projected', () => {
    expect(new TurnProjector('t1').project('item/agentMessage/delta', { delta: 'x' })).toEqual([]);
  });

  it('an interrupted turn fails with a fixed message', () => {
    expect(new TurnProjector('t1').project('turn/completed', { turn: { status: 'interrupted' } }))
      .toEqual([{ kind: 'terminal', event: { type: 'turn.failed', error: { message: 'turn interrupted' } } }]);
  });
});
