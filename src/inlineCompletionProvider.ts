import * as vscode from 'vscode';
import { PendingStore } from './pending';

/**
 * Surfaces the pending (command-generated) completion as ghost text.
 * It returns the pending item whenever the cursor sits on the anchor line of the
 * matching document; it does not clear the pending itself — the extension clears it
 * on document change (accept or typing), making it effectively one-shot.
 */
export class ClaudeInlineCompletionProvider implements vscode.InlineCompletionItemProvider {
  constructor(
    private readonly pending: PendingStore,
    private readonly log: (msg: string) => void = () => {}
  ) {}

  provideInlineCompletionItems(
    document: vscode.TextDocument,
    position: vscode.Position
  ): vscode.InlineCompletionItem[] | undefined {
    const p = this.pending.get();
    if (!p) {
      return undefined; // no pending completion — stay quiet (avoids log flooding)
    }
    const base = document.uri.toString().split('/').pop();
    if (p.uri !== document.uri.toString()) {
      this.log(`provide: uri mismatch (doc=${base} pending=${p.uri.split('/').pop()})`);
      return undefined;
    }
    if (position.line !== p.line) {
      this.log(`provide: line mismatch (cursor line=${position.line} pending line=${p.line})`);
      return undefined;
    }
    this.log(`provide: MATCH at ${position.line}:${position.character} -> returning ghost (${p.text.length} chars)`);
    return [new vscode.InlineCompletionItem(p.text, new vscode.Range(position, position))];
  }
}
