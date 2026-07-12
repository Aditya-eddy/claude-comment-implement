import * as vscode from 'vscode';
import { spawn, ChildProcessWithoutNullStreams } from 'child_process';

export interface SessionConfig {
  claudePath: string;
  model: string;
  recycleAfter: number;
  cwd?: string;
  /**
   * Directory to use as CLAUDE_CODE_TMPDIR for the spawned CLI. VS Code's extension
   * host does not inherit the user's shell env, so `claude` would otherwise default to
   * a root-owned /tmp/claude-<uid> and refuse to start. Point it at a user-owned dir.
   */
  tmpDir?: string;
}

const SYSTEM_PROMPT = [
  'You are a code generation engine embedded in a code editor.',
  'The user requests code by writing a comment beginning with a marker (e.g. //claude, #claude, --claude) followed by an instruction.',
  'You are given the language, the instruction, and the surrounding code (CODE_BEFORE ends at the marker comment; CODE_AFTER follows it).',
  'Output ONLY the raw code that should be inserted on the line(s) immediately after the comment.',
  'Do not repeat the comment. Do not include explanations or markdown code fences.',
  'Match the surrounding language, conventions, and style. If nothing should be inserted, output nothing.'
].join(' ');

interface ActiveTurn {
  onResult: (result: string, isError: boolean) => void;
  onDied: () => void;
}

/**
 * Owns a single long-lived `claude` process driven over stream-json stdin/stdout.
 * Completions are serialized on a promise chain: one process == one conversation,
 * so turns cannot overlap on the wire.
 */
export class SessionManager {
  private child: ChildProcessWithoutNullStreams | null = null;
  private stdoutBuf = '';
  private active: ActiveTurn | null = null;
  private completions = 0;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly getConfig: () => SessionConfig,
    private readonly log: (msg: string) => void
  ) {}

  /** Spawn the warm process. Safe to call when already started (no-op). */
  start(): void {
    if (this.child) {
      return;
    }
    const cfg = this.getConfig();
    const args = [
      '--print',
      '--input-format', 'stream-json',
      '--output-format', 'stream-json',
      '--verbose',
      '--model', cfg.model,
      '--disallowedTools', 'Bash', 'Read', 'Edit', 'Write', 'Glob', 'Grep', 'WebFetch', 'WebSearch',
      '--append-system-prompt', SYSTEM_PROMPT
    ];
    const env = { ...process.env };
    if (cfg.tmpDir && !env.CLAUDE_CODE_TMPDIR) {
      env.CLAUDE_CODE_TMPDIR = cfg.tmpDir;
    }
    this.log(`starting: ${cfg.claudePath} … (CLAUDE_CODE_TMPDIR=${env.CLAUDE_CODE_TMPDIR ?? '<default>'})`);
    try {
      this.child = spawn(cfg.claudePath, args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        cwd: cfg.cwd ?? process.cwd(),
        env
      });
    } catch (err) {
      this.log(`spawn failed: ${String(err)}`);
      this.child = null;
      return;
    }
    this.stdoutBuf = '';
    this.completions = 0;

    this.child.stdout.on('data', (d: Buffer) => this.onStdout(d.toString()));
    this.child.stderr.on('data', (d: Buffer) => this.log(`[stderr] ${d.toString().trimEnd()}`));
    this.child.on('error', (err) => {
      this.log(`process error: ${String(err)}`);
      this.handleExit();
    });
    this.child.on('close', (code) => {
      this.log(`process exited (code=${code})`);
      this.handleExit();
    });
  }

  /** Kill and restart the process fresh (cold). */
  restart(): void {
    this.log('restarting session');
    this.kill();
    this.start();
  }

  dispose(): void {
    this.kill();
  }

  /**
   * Send one turn to the warm process. Resolves with the model's `result` text,
   * or '' on cancellation / error / missing process.
   *
   * The caller's promise resolves immediately on cancellation, but the internal
   * queue only advances once the turn has fully drained off the wire — so a
   * discarded (cancelled) generation still completes before the next turn starts,
   * keeping the single conversation stream in sync.
   */
  send(content: string, token?: vscode.CancellationToken): Promise<string> {
    let resolveCaller!: (v: string) => void;
    const caller = new Promise<string>((r) => { resolveCaller = r; });
    const runWire = () => this.turnWire(content, resolveCaller, token);
    this.queue = this.queue.then(runWire, runWire);
    return caller;
  }

  /** Drives one wire turn; resolves the returned promise when the wire has drained. */
  private turnWire(
    content: string,
    resolveCaller: (v: string) => void,
    token?: vscode.CancellationToken
  ): Promise<void> {
    return new Promise<void>((wireDone) => {
      if (token?.isCancellationRequested) {
        resolveCaller('');
        wireDone();
        return;
      }
      this.start();
      if (!this.child || !this.child.stdin.writable) {
        this.log('no writable process; returning empty completion');
        resolveCaller('');
        wireDone();
        return;
      }

      let cancelled = false;
      const sub = token?.onCancellationRequested(() => {
        cancelled = true;
        resolveCaller(''); // release the caller now; the wire keeps draining below
      });

      this.active = {
        onResult: (result, isError) => {
          sub?.dispose();
          this.active = null;
          this.completions++;
          this.log(`turn: result received (len=${(result ?? '').length}, isError=${isError})`);
          if (isError) {
            this.log('turn returned error; recycling session');
            this.recycle();
          } else if (this.completions >= this.getConfig().recycleAfter) {
            this.log(`recycleAfter reached (${this.completions}); recycling session`);
            this.recycle();
          }
          if (!cancelled) {
            resolveCaller(result ?? '');
          }
          wireDone();
        },
        onDied: () => {
          sub?.dispose();
          this.active = null;
          if (!cancelled) {
            resolveCaller('');
          }
          wireDone();
        }
      };

      const message = JSON.stringify({ type: 'user', message: { role: 'user', content } }) + '\n';
      this.log(`turn: writing message (${content.length} chars) to warm process`);
      try {
        this.child.stdin.write(message);
      } catch (err) {
        this.log(`write failed: ${String(err)}`);
        this.active = null;
        sub?.dispose();
        if (!cancelled) {
          resolveCaller('');
        }
        wireDone();
      }
    });
  }

  private onStdout(chunk: string): void {
    this.stdoutBuf += chunk;
    let idx: number;
    while ((idx = this.stdoutBuf.indexOf('\n')) >= 0) {
      const line = this.stdoutBuf.slice(0, idx);
      this.stdoutBuf = this.stdoutBuf.slice(idx + 1);
      if (!line.trim()) {
        continue;
      }
      let ev: any;
      try {
        ev = JSON.parse(line);
      } catch {
        continue; // partial/non-JSON line; skip
      }
      if (ev && ev.type === 'result' && this.active) {
        const isError = ev.is_error === true || ev.subtype !== 'success';
        this.active.onResult(typeof ev.result === 'string' ? ev.result : '', isError);
      }
    }
  }

  private handleExit(): void {
    this.child = null;
    this.stdoutBuf = '';
    if (this.active) {
      const a = this.active;
      this.active = null;
      a.onDied();
    }
  }

  private recycle(): void {
    // Kill now; the next send() will lazily start a fresh (cold) process.
    this.kill();
  }

  private kill(): void {
    if (this.child) {
      try {
        this.child.stdin.end();
      } catch { /* ignore */ }
      try {
        this.child.kill();
      } catch { /* ignore */ }
    }
    this.child = null;
    this.completions = 0;
    this.stdoutBuf = '';
  }
}
