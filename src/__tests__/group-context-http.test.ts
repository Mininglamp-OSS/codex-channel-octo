import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createAdapter, type DbAdapter } from '../db-adapter.js';
import { GroupContext } from '../group-context.js';
import { parentGroupNo } from '../channel-id.js';

// Literal copied from Octo's TestBuildChannelID, not constructed with our helper.
// https://github.com/Mininglamp-OSS/octo-server/blob/589cdf79cae65e6aeaf354bebcbd7145f72a0e36/modules/thread/service_test.go#L103
// This is a server source fixture, not a captured production message.
const TOPIC = 'abc12345678901234567890123456789a____1489104291682713601';
const PARENT = 'abc12345678901234567890123456789a';
const API = 'https://octo.example/api';
const fetchMock = vi.fn<typeof fetch>();

describe('GroupContext with the real member HTTP helper', () => {
  let adapter: DbAdapter;
  let context: GroupContext;

  beforeEach(() => {
    adapter = createAdapter(':memory:');
    adapter.exec(`CREATE TABLE group_members (
      group_id TEXT NOT NULL, uid TEXT NOT NULL, name TEXT NOT NULL,
      updated_at INTEGER NOT NULL, PRIMARY KEY(group_id, uid)
    )`);
    context = new GroupContext(adapter, 6000);
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    adapter.close();
    vi.unstubAllGlobals();
  });

  it('uses the server topic format and parent roster while keeping pruning local to the topic', async () => {
    expect(parentGroupNo(TOPIC)).toBe(PARENT);
    context.learnMember(TOPIC, 'departed', 'Departed');
    context.learnMember(PARENT, 'departed', 'Parent snapshot');
    context.learnMember('other-topic', 'departed', 'Other snapshot');
    fetchMock.mockResolvedValue(new Response(JSON.stringify([
      { uid: 'human', name: 'Human', role: 0, robot: 0 },
      { uid: 'bot', name: 'Bot', role: 0, robot: 1 },
    ])));

    await context.refreshMembers(TOPIC, API, 'test-token');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe(`${API}/v1/bot/groups/${PARENT}/members`);
    expect(context.isMember(TOPIC, 'human')).toBe(true);
    expect(context.isMember(TOPIC, 'departed')).toBe(false);
    expect(context.isRobot(TOPIC, 'bot')).toBe(true);
    expect(context.isMember(PARENT, 'departed')).toBe(true);
    expect(context.isMember(PARENT, 'human')).toBe(false);
    expect(context.isMember('other-topic', 'departed')).toBe(true);
    // Pruning and the full topic key also survive reloading from storage.
    const reloaded = new GroupContext(adapter, 6000);
    reloaded.loadAllFromDb();
    expect(reloaded.isMember(TOPIC, 'human')).toBe(true);
    expect(reloaded.isMember(TOPIC, 'departed')).toBe(false);
    expect(reloaded.isMember(PARENT, 'departed')).toBe(true);
  });

  it.each([[], {}, { members: null }])('preserves prior topic members after an empty or malformed HTTP 200 (%j)', async (body) => {
    context.learnMember(TOPIC, 'human', 'Human');
    fetchMock.mockResolvedValue(new Response(JSON.stringify(body)));
    await context.refreshMembers(TOPIC, API, 'test-token');
    expect(context.isMember(TOPIC, 'human')).toBe(true);
    const reloaded = new GroupContext(adapter, 6000);
    reloaded.loadAllFromDb();
    expect(reloaded.isMember(TOPIC, 'human')).toBe(true);
  });
});
