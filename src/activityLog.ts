import * as vscode from 'vscode';

export type ActivityStatus = 'pending' | 'ok' | 'cancelled' | 'empty' | 'error';

export interface ActivityEntry {
  id: number;
  timestamp: number;
  instruction: string;
  prompt: string;
  response: string;
  model: string;
  durationMs?: number;
  status: ActivityStatus;
}

/** In-memory, newest-first ring buffer of Claude request/response interactions. */
export class ActivityLog {
  private entries: ActivityEntry[] = [];
  private nextId = 1;
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChange = this.emitter.event;

  constructor(private readonly max = 100) {}

  /** Record a new in-flight request; returns its id. */
  start(input: { instruction: string; prompt: string; model: string }): number {
    const id = this.nextId++;
    this.entries.unshift({
      id,
      timestamp: Date.now(),
      instruction: input.instruction,
      prompt: input.prompt,
      model: input.model,
      response: '',
      status: 'pending'
    });
    if (this.entries.length > this.max) {
      this.entries.length = this.max; // drop oldest
    }
    this.emitter.fire();
    return id;
  }

  /** Update an existing entry once the response is known. */
  complete(id: number, patch: { response: string; status: ActivityStatus; durationMs: number }): void {
    const e = this.entries.find((x) => x.id === id);
    if (e) {
      e.response = patch.response;
      e.status = patch.status;
      e.durationMs = patch.durationMs;
      this.emitter.fire();
    }
  }

  clear(): void {
    this.entries = [];
    this.emitter.fire();
  }

  getEntries(): ActivityEntry[] {
    return this.entries;
  }

  dispose(): void {
    this.emitter.dispose();
  }
}
