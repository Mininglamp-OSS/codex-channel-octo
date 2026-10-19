import { afterEach, describe, expect, it, vi } from 'vitest';
import { postJson, getGroupMd, getUploadCredentials } from '../octo/api.js';
import { summarizeAgentError } from '../agent-errors.js';

const base = { apiUrl: 'https://test.invalid', botToken: 'FAKE_TEST_TOKEN' };
afterEach(() => vi.unstubAllGlobals());
async function failure(task: Promise<unknown>) {
  try { await task; } catch (error) { return error; }
  throw new Error('Expected request failure');
}

describe('closed Octo API diagnostics', () => {
  it.each([
    ['/v1/bot/sendMessage', 'delivery'], ['/v1/bot/register?force_refresh=true', 'prepare'],
    ['/v1/bot/typing', 'prepare'], ['/v1/bot/heartbeat', 'prepare'],
    ['/v1/bot/readReceipt', 'prepare'], ['/v1/bot/messages/sync', 'prepare'],
  ])('keeps endpoint and HTTP status for %s without response data', async (path, stage) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('PRIVATE_BODY FAKE_TEST_TOKEN', { status: 401 })));
    const error = await failure(postJson(base.apiUrl, base.botToken, path, {}));
    expect(error).toMatchObject({ snapshot: { endpoint: path.split('?')[0], httpStatus: 401, category: 'auth', stage } });
    expect(String(error)).toContain(path.split('?')[0]);
    expect(summarizeAgentError(error)).toContain('401');
    expect(String(error) + summarizeAgentError(error)).not.toMatch(/PRIVATE_BODY|FAKE_TEST_TOKEN|force_refresh/);
  });
  it('redacts group and thread identifiers instead of logging an arbitrary URL', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('PRIVATE_BODY', { status: 500 })));
    const error = await failure(getGroupMd({ ...base, groupNo: 'PRIVATE_GROUP' }));
    expect(error).toMatchObject({ snapshot: { endpoint: '/v1/bot/groups/:group/md', stage: 'prepare' } });
    expect(String(error) + summarizeAgentError(error)).not.toMatch(/PRIVATE_GROUP|PRIVATE_BODY/);
  });
  it('reports invalid JSON separately without logging any rejected bytes', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('PRIVATE_INVALID_JSON', { status: 200 })));
    const error = await failure(postJson(base.apiUrl, base.botToken, '/v1/bot/sendMessage', {}));
    expect(error).toMatchObject({ snapshot: { endpoint: '/v1/bot/sendMessage', stage: 'delivery', detail: 'invalid_json', httpStatus: 200 } });
    expect(String(error) + summarizeAgentError(error)).not.toContain('PRIVATE_INVALID_JSON');
  });
  it('uses the same error policy for upload-credential requests', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('PRIVATE_CREDENTIAL_BODY', { status: 403 })));
    const error = await failure(getUploadCredentials({ ...base, filename: 'PRIVATE_FILE.png' }));
    expect(error).toMatchObject({ snapshot: { endpoint: '/v1/bot/upload/credentials', category: 'permission', stage: 'prepare' } });
    expect(String(error) + summarizeAgentError(error)).not.toMatch(/PRIVATE_FILE|PRIVATE_CREDENTIAL_BODY/);
  });
  it('separates response-read and network failures without preserving unsafe causes', async () => {
    const response = new Response('');
    vi.spyOn(response, 'text').mockRejectedValue(new Error('PRIVATE_READ_FAILURE'));
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(response).mockRejectedValueOnce(new Error('PRIVATE_NETWORK_FAILURE')));
    const read = await failure(postJson(base.apiUrl, base.botToken, '/v1/bot/sendMessage', {}));
    const network = await failure(postJson(base.apiUrl, base.botToken, '/v1/bot/register', {}));
    expect(read).toMatchObject({ snapshot: { detail: 'response_read', stage: 'delivery' } });
    expect(network).toMatchObject({ snapshot: { detail: 'network', endpoint: '/v1/bot/register', stage: 'prepare' } });
    expect(String(read) + summarizeAgentError(read) + String(network) + summarizeAgentError(network)).not.toContain('PRIVATE_');
  });
});
