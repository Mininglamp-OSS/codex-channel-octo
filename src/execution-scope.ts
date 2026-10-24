import { randomUUID } from 'node:crypto';
import { chmodSync, mkdtempSync, rmSync } from 'node:fs';
import { spawn, execFile, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createServer, type Server, type Socket } from 'node:net';
import { createRequire } from 'node:module';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { performance } from 'node:perf_hooks';

const ps = promisify(execFile);
export interface ManagedExecution {
  waitForStopped(timeoutMs: number): Promise<boolean>;
  dispose(): void;
}

/** True when no live (non-zombie) process remains in group `pgid`; false on any doubt. */
export async function processGroupStopped(pgid: number): Promise<boolean> {
  if (process.platform === 'win32') return false;
  try {
    const { stdout } = await ps('/bin/ps', ['-axo', 'pgid=,stat='], { encoding: 'utf8', timeout: 1000, maxBuffer: 4 * 1024 * 1024 });
    return !stdout.split('\n').some(row => {
      const [group, state] = row.trim().split(/\s+/);
      return Number(group) === pgid && state && !state.startsWith('Z');
    });
  } catch { return false; }
}

/** SIGTERM, then SIGKILL, the group `pgid` until it is verified stopped or the budgets run out. */
export async function stopProcessGroup(pgid: number): Promise<void> {
  for (const [signal, budget] of [['SIGTERM', 1500], ['SIGKILL', 500]] as const) {
    if (await processGroupStopped(pgid)) return;
    try { process.kill(-pgid, signal); } catch { /* Verify below. */ }
    const deadline = performance.now() + budget;
    while (!(await processGroupStopped(pgid)) && performance.now() < deadline) await sleep(25);
  }
}

/** The gateway owns the child handle and PGID. No workload-supplied exit proof
 * (including a correct-nonce file or socket frame) has admission authority. */
export class ExecutionScope implements ManagedExecution {
  private readonly directory = mkdtempSync(join(tmpdir(), 'octo-execution-'));
  private readonly token = randomUUID();
  private launchExpected = false;
  private child?: ChildProcessWithoutNullStreams;
  private childClosed = false;
  private launchRejected = false;
  private normalExit = false;
  private server?: Server;
  private readonly sockets = new Set<Socket>();
  private cleanup?: Promise<void>;
  private disposed = false;
  constructor(
    private readonly launcher?: string,
    private readonly launcherMode: 'node' | 'executable' = 'node',
  ) { chmodSync(this.directory, 0o700); }

  /** Called only for a supported proxy launch, never direct/Windows fallback. */
  async prepare(): Promise<void> {
    if (process.platform === 'win32') return;
    if (this.launcherMode === 'executable' && !this.launcher) throw new Error('Explicit executable required');
    const launcher = this.launcher ?? createRequire(import.meta.resolve('@openai/codex-sdk')).resolve('@openai/codex/bin/codex.js');
    const server = this.server = createServer(socket => {
      this.sockets.add(socket);
      socket.setEncoding('utf8');
      let buffer = '';
      let authenticated = false;
      const send = (value: object): boolean => !socket.destroyed && socket.write(JSON.stringify(value) + '\n');
      socket.on('error', () => {});
      socket.on('close', () => {
        this.sockets.delete(socket);
        if (authenticated) {
          this.child?.stdin.destroy(); this.child?.stdout.resume(); this.child?.stderr.resume();
          if (!this.normalExit) void this.stopGroup();
        }
      });
      socket.on('drain', () => { this.child?.stdout.resume(); this.child?.stderr.resume(); });
      socket.on('data', data => {
        buffer += data.toString('utf8');
        if (buffer.length > 16 * 1024 * 1024) { socket.destroy(); return; }
        for (let end; (end = buffer.indexOf('\n')) !== -1;) {
          const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
          try {
            const frame = JSON.parse(line) as Record<string, unknown>;
            if (!authenticated) {
              if (this.disposed || this.child || frame.token !== this.token || !Array.isArray(frame.args)
                || !frame.args.every(arg => typeof arg === 'string') || !frame.env || typeof frame.env !== 'object'
                || !Object.values(frame.env).every(value => typeof value === 'string')) { socket.destroy(); return; }
              authenticated = true;
              const env = { ...frame.env } as Record<string, string>;
              delete env.CODEX_CHANNEL_EXECUTION_DIR; delete env.CODEX_CHANNEL_EXECUTION_TOKEN;
              // Spawn here, not in the SDK proxy: PID/close cannot be fabricated
              // by the controlled CLI or by reading the proxy's environment.
              // The default SDK launcher is JavaScript; a pinned native binary
              // must execute directly. Both retain this gateway-owned PGID/handle.
              const executable = this.launcherMode === 'executable' ? launcher : process.execPath;
              const args = this.launcherMode === 'executable' ? frame.args : [launcher, ...frame.args];
              const child = this.child = spawn(executable, args, { detached: true, env, stdio: ['pipe', 'pipe', 'pipe'] });
              child.stdin.on('error', () => {});
              child.stdout.on('data', chunk => { if (!socket.destroyed && !send({ type: 'stdout', data: chunk.toString('base64') })) child.stdout.pause(); });
              child.stderr.on('data', chunk => { if (!socket.destroyed && !send({ type: 'stderr', data: chunk.toString('base64') })) child.stderr.pause(); });
              child.once('error', () => {
                // Only the gateway's own failed spawn with no PID proves this
                // child never started. Errors on a running child do not.
                if (child.pid === undefined) this.launchRejected = true;
              });
              child.once('close', (code, signal) => {
                this.childClosed = true;
                this.normalExit = code === 0 && !signal;
                const finish = () => { send({ type: 'exit', code: code ?? 1, signal }); socket.end(); };
                if (this.normalExit) finish();
                else void this.stopGroup().then(finish);
              });
            } else if (frame.type === 'stdin' && typeof frame.data === 'string') {
              if (!this.child!.stdin.write(Buffer.from(frame.data, 'base64'))) {
                socket.pause(); this.child!.stdin.once('drain', () => socket.resume());
              }
            } else if (frame.type === 'end') this.child!.stdin.end();
            else if (frame.type === 'cancel') void this.stopGroup();
            else { socket.destroy(); return; } // No client-side stopped/exit authority.
          } catch { socket.destroy(); return; }
        }
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(join(this.directory, 'control.sock'), () => { server.removeListener('error', reject); resolve(); });
    });
    server.on('error', () => {});
  }

  environment(base: Record<string, string>): Record<string, string> {
    return { ...base, CODEX_CHANNEL_EXECUTION_DIR: this.directory, CODEX_CHANNEL_EXECUTION_TOKEN: this.token };
  }
  expectLaunch(): void { this.launchExpected = true; }
  confirmNotStarted(): void { this.launchExpected = false; }
  private groupStopped(): Promise<boolean> {
    return this.child?.pid ? processGroupStopped(this.child.pid) : Promise.resolve(false);
  }
  private stopGroup(): Promise<void> {
    if (!this.child?.pid) return Promise.resolve();
    return this.cleanup ??= stopProcessGroup(this.child.pid);
  }
  async waitForStopped(timeoutMs: number): Promise<boolean> {
    if (!this.launchExpected) return true;
    void this.stopGroup(); // Called for interrupted work, including a CLI that exited zero.
    const deadline = performance.now() + timeoutMs;
    do {
      if (this.childClosed && (this.launchRejected || await this.groupStopped())) return true;
      if (performance.now() >= deadline) return false;
      await sleep(Math.min(25, Math.max(1, deadline - performance.now())));
    } while (true);
  }
  dispose(): void {
    this.disposed = true;
    if (!this.normalExit) void this.stopGroup();
    this.server?.close();
    for (const socket of this.sockets) socket.destroy();
    rmSync(this.directory, { recursive: true, force: true });
  }
}
