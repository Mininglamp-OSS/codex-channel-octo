import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { preparePrivateWorker } from '../permissions/worker-launch.js';
import { queryAgentEvents } from '../agent-bridge.js';
import type { ManagedExecution } from '../execution-scope.js';
import type { Config } from '../config.js';

const exec = promisify(execFile);
let root: string;
let launcher: string;
let digest: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'permission-worker-'));
  launcher = join(root, 'synthetic-worker');
  const code = `#!${process.execPath}
let input='';for await(const chunk of process.stdin)input+=chunk;
const args=process.argv.slice(2);const cd=args.indexOf('--cd');if(cd>=0)process.chdir(args[cd+1]);
const report={keys:Object.keys(process.env).sort(),args,home:process.env.CODEX_HOME,cwd:process.cwd(),input};
console.log(JSON.stringify({type:'thread.started',thread_id:'11111111-1111-4111-8111-111111111111'}));
console.log(JSON.stringify({type:'item.completed',item:{id:'answer',type:'agent_message',text:JSON.stringify(report)}}));
console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:1,cached_input_tokens:0,output_tokens:1}}));
`;
  writeFileSync(launcher, code, { mode: 0o700 }); digest = createHash('sha256').update(code).digest('hex');
});
afterEach(() => rmSync(root, { recursive: true, force: true }));
const plan = () => preparePrivateWorker({ root, launcher, launcherSha256: digest,
  relay: { transport: 'stdio', executable: launcher, executableSha256: digest, handle: 'synthetic_turn_only' },
  instructions: 'SYNTHETIC_ALLOWLISTED_STATIC_INSTRUCTIONS' });

describe('host-owned SDK private worker launch', () => {
  it('runs a real owned child with a clean home/cwd and excludes inherited/operator environment, memory and resume', async () => {
    const launch = plan();
    const config: Config = { cwd: root, cwdBase: root, baseDir: root, dataDir: root, botToken: 'SYNTHETIC_TOKEN',
      apiUrl: 'https://synthetic.invalid', cards: { disable: false, eventTransport: 'off', reasoningSummary: 'off' },
      rateLimit: { maxPerMinute: 100 }, context: { maxContextChars: 6000, historyLimit: 40 },
      maxResponseChars: 5000, dispatchTimeoutMs: 10000, sdk: { env: { SYNTHETIC_AMBIENT_SECRET: 'fixture' },
      systemPrompt: 'LEGACY_STATIC_TEXT', additionalDirectories: [root], sandboxMode: 'danger-full-access',
      networkAccessEnabled: true, webSearchEnabled: true, privateDiagnostics: false,
      recovery: { enabled: true, maxAttempts: 2 } } };
    const owned: ManagedExecution[] = [];
    try {
      let answer = '';
      for await (const event of queryAgentEvents('SYNTHETIC_CURRENT_INPUT', config, undefined, undefined, {
        privateWorker: launch, privateMemoryContext: 'LEGACY_MEMORY' as never,
        onManagedExecution: execution => owned.push(execution),
      })) if (event.kind === 'message') answer = event.text;
      const report = JSON.parse(answer) as { keys: string[]; args: string[]; home: string; cwd: string; input: string };
      expect(report.home).toBe(launch.codexHome); expect(report.cwd).toBe(realpathSync(launch.workdir));
      expect(report.keys).not.toContain('SYNTHETIC_AMBIENT_SECRET');
      for (const key of ['OCTO_TOKEN', 'OCTO_TASK_TOKEN', 'OCTO_BOT_TOKEN', 'CODEX_CHANNEL_EXECUTION_DIR', 'CODEX_CHANNEL_EXECUTION_TOKEN']) {
        expect(report.keys).not.toContain(key);
      }
      expect(report.input).not.toContain('LEGACY_MEMORY'); expect(report.args).not.toContain('resume');
      expect(report.args.join(' ')).toContain('mcp_servers='); expect(report.args).not.toContain('--add-dir');
      expect(readFileSync(join(launch.workdir, 'AGENTS.md'), 'utf8')).toBe(launch.instructions);
      await expect(async () => {
        for await (const event of queryAgentEvents('again', config, undefined, undefined,
          { privateWorker: launch, resume: 'old', onManagedExecution: execution => owned.push(execution) })) void event;
      }).rejects.toThrow();
    } finally {
      for (const execution of owned) { await execution.waitForStopped(5000); execution.dispose(); }
    }
  });

  it.each(['stdio', 'http'] as const)('checks the locked native CLI lists only the explicit %s relay in the clean namespace', async transport => {
    const launch = transport === 'stdio' ? plan() : preparePrivateWorker({ root, launcher, launcherSha256: digest,
      relay: { transport: 'http', url: 'https://synthetic.invalid/mcp', handle: 'synthetic_turn_only' }, instructions: 'STATIC' });
    const codex = createRequire(new URL('../../node_modules/@openai/codex-sdk/package.json', import.meta.url)).resolve('@openai/codex/bin/codex.js');
    const args = [codex, 'mcp', 'list', '--json', ...launch.configOverrides.flatMap(value => ['--config', value])];
    const { stdout } = await exec(process.execPath, args, { cwd: launch.workdir, env: { ...launch.env }, timeout: 10000 });
    const servers = JSON.parse(stdout) as { name: string }[];
    expect(servers.map(server => server.name)).toEqual(['octo']);
    // This verifies one local distribution's config loading only. It does not
    // prove distinct-UID/network/mount isolation or other supported platforms.
  });

  it('rejects a changed executable and insecure HTTP relay before constructing a launch', () => {
    expect(() => preparePrivateWorker({ root, launcher, launcherSha256: '0'.repeat(64),
      relay: { transport: 'http', url: 'https://synthetic.invalid/mcp', handle: 'turn' }, instructions: '' })).toThrow('executable');
    expect(() => preparePrivateWorker({ root, launcher, launcherSha256: digest,
      relay: { transport: 'http', url: 'http://synthetic.invalid/mcp', handle: 'turn' }, instructions: '' })).toThrow('URL');
  });
});
