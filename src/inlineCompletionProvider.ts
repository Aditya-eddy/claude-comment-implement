import * as vscode from 'vscode';
import { PendingStore } from './pending';

/**
 * Surfaces the pending (command-generated) completion as ghost text.
 * It returns the pending item whenever the cursor sits on the anchor line of the
 * matching document; it does not clear the pending itself — the extension clears it
 * on document change (accept or typing), making it effectively one-shot.
 */
export class ClaudeInlineCompletionProvider implements vscode.InlineCompletionItemProvider {
  constructor(private readonly pending: PendingStore) {}

  provideInlineCompletionItems(
    document: vscode.TextDocument,
    position: vscode.Position
  ): vscode.InlineCompletionItem[] | undefined {
    const p = this.pending.get();
    if (!p || p.uri !== document.uri.toString() || position.line !== p.line) {
      return undefined;
    }
    return [new vscode.InlineCompletionItem(p.text, new vscode.Range(position, position))];
  }
}
