import * as vscode from 'vscode';
import { SessionManager } from './session';
import { PendingStore } from './pending';
import { cleanResult, reindent } from './text';

export interface ImplementArgs {
  uri: string;
  line: number;
  instruction: string;
}

function buildPrompt(languageId: string, instruction: string, before: string, after: string): string {
  return [
    `LANGUAGE: ${languageId}`,
    `INSTRUCTION: ${instruction}`,
    '',
    'CODE_BEFORE:',
    before,
    '',
    'CODE_AFTER:',
    after,
    ''
  ].join('\n');
}

/** Handler for the claudeComplete.implement command (fired by the CodeLens). */
export async function implement(
  arg: ImplementArgs | undefined,
  session: SessionManager,
  pending: PendingStore,
  getContextLines: () => number
): Promise<void> {
  if (!arg || typeof arg.uri !== 'string') {
    return;
  }
  const uri = vscode.Uri.parse(arg.uri);

  // Focus the target editor (the CodeLens keeps it active, but be defensive).
  let editor = vscode.window.activeTextEditor;
  if (!editor || editor.document.uri.toString() !== arg.uri) {
    const doc = await vscode.workspace.openTextDocument(uri);
    editor = await vscode.window.showTextDocument(doc, { preview: false });
  }
  const document = editor.document;

  // Re-read the marker line at click time (edits may have shifted it).
  const lineNo = arg.line;
  if (lineNo < 0 || lineNo >= document.lineCount) {
    return;
  }
  const lineText = document.lineAt(lineNo).text;
  const indent = (lineText.match(/^(\s*)/)?.[1]) ?? '';

  // Gather context windows.
  const contextLines = getContextLines();
  const beforeStart = Math.max(0, lineNo - contextLines);
  const before = document.getText(new vscode.Range(beforeStart, 0, lineNo, lineText.length));
  const afterEnd = Math.min(document.lineCount - 1, lineNo + contextLines);
  const after = lineNo + 1 <= afterEnd
    ? document.getText(new vscode.Range(lineNo + 1, 0, afterEnd, document.lineAt(afterEnd).text.length))
    : '';

  const prompt = buildPrompt(document.languageId, arg.instruction, before, after);

  const result = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: 'Claude: implementing…', cancellable: true },
    (_progress, token) => session.send(prompt, token)
  );

  const code = reindent(cleanResult(result), indent);
  if (!code) {
    vscode.window.setStatusBarMessage('Claude: no code generated (or cancelled).', 3000);
    return;
  }

  // Stash the ghost text anchored at the end of the comment line, then trigger it.
  const anchor = new vscode.Position(lineNo, lineText.length);
  pending.set({ uri: arg.uri, line: lineNo, character: lineText.length, text: '\n' + code });
  editor.selection = new vscode.Selection(anchor, anchor);
  editor.revealRange(new vscode.Range(anchor, anchor));
  await vscode.commands.executeCommand('editor.action.inlineSuggest.trigger');
}
