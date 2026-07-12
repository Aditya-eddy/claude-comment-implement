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
  getContextLines: () => number,
  log: (msg: string) => void = () => {}
): Promise<void> {
  log(`implement: fired arg=${JSON.stringify(arg)}`);
  if (!arg || typeof arg.uri !== 'string') {
    log('implement: bad/missing arg; aborting');
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
  log(`implement: sending prompt (${prompt.length} chars) for line ${lineNo} lang=${document.languageId}`);

  const result = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: 'Claude: implementing…', cancellable: true },
    (_progress, token) => session.send(prompt, token)
  );
  log(`implement: raw result (${result.length} chars): ${JSON.stringify(result.slice(0, 120))}`);

  const code = reindent(cleanResult(result), indent);
  if (!code) {
    log('implement: cleaned code empty; nothing to show');
    vscode.window.setStatusBarMessage('Claude: no code generated (or cancelled).', 3000);
    return;
  }

  // Stash the ghost text anchored at the end of the comment line, then trigger it.
  const anchor = new vscode.Position(lineNo, lineText.length);
  pending.set({ uri: arg.uri, line: lineNo, character: lineText.length, text: '\n' + code });
  editor.selection = new vscode.Selection(anchor, anchor);
  editor.revealRange(new vscode.Range(anchor, anchor));
  log(`implement: pending set at ${lineNo}:${lineText.length} (${code.length} chars); cursor moved; triggering inlineSuggest`);
  await vscode.commands.executeCommand('editor.action.inlineSuggest.trigger');
  log('implement: inlineSuggest.trigger dispatched');
}

/**
 * Runs after the ghost text is accepted (via InlineCompletionItem.command):
 * deletes the original marker comment line, merged into the accept's undo step.
 */
export async function removeCommentLine(
  arg: { uri: string; line: number } | undefined,
  log: (msg: string) => void = () => {}
): Promise<void> {
  if (!arg || typeof arg.uri !== 'string' || typeof arg.line !== 'number') {
    return;
  }
  const editor = vscode.window.visibleTextEditors.find((e) => e.document.uri.toString() === arg.uri)
    ?? vscode.window.activeTextEditor;
  if (!editor || editor.document.uri.toString() !== arg.uri) {
    log(`cleanup: no matching editor for ${arg.uri}`);
    return;
  }
  const doc = editor.document;
  if (arg.line < 0 || arg.line >= doc.lineCount) {
    return;
  }
  // Delete the whole comment line including its trailing newline (code sits below it).
  const start = new vscode.Position(arg.line, 0);
  const end = arg.line + 1 < doc.lineCount
    ? new vscode.Position(arg.line + 1, 0)
    : doc.lineAt(arg.line).range.end;
  await editor.edit(
    (eb) => eb.delete(new vscode.Range(start, end)),
    { undoStopBefore: false, undoStopAfter: true }
  );
  log(`cleanup: removed comment line ${arg.line}`);
}
