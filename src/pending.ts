/** A generated-but-not-yet-accepted completion, waiting to be shown as ghost text. */
export interface Pending {
  uri: string;
  line: number;
  character: number;
  text: string;
}

/** Single-slot store shared between the implement command (writer) and the inline provider (reader). */
export class PendingStore {
  private current: Pending | null = null;

  set(p: Pending): void {
    this.current = p;
  }

  get(): Pending | null {
    return this.current;
  }

  clear(): void {
    this.current = null;
  }
}
