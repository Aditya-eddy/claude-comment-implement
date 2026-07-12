import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { SessionManager, SessionConfig } from './session';
import { PendingStore } from './pending';
import { ClaudeCodeLensProvider } from './codeLensProvider';
import { ClaudeInlineCompletionProvider } from './inlineCompletionProvider';
import { implement, removeCommentLine, ImplementArgs } from './implementCommand';

export function activate(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel('Claude Comment Implement');
  const log = (msg: string) => output.appendLine(`[${new Date().toISOString()}] ${msg}`);

  const cfg = () => vscode.workspace.getConfiguration('claudeComplete');
  const getMarker = () => cfg().get<string>('marker', 'claude');
  const getContextLines = () => cfg().get<number>('contextLines', 80);

  // The extension host does not inherit the user's shell env, so give the spawned
  // `claude` a user-owned temp dir (else it refuses a root-owned /tmp/claude-<uid>).
  const tmpDir = path.join(context.globalStorageUri.fsPath, 'claude-tmp');
  try {
    fs.mkdirSync(tmpDir, { recursive: true });
  } catch (err) {
    log(`failed to create tmp dir ${tmpDir}: ${String(err)}`);
  }

  const sessionConfig = (): SessionConfig => ({
    claudePath: cfg().get<string>('claudePath', 'claude'),
    model: cfg().get<string>('model', 'claude-haiku-4-5-20251001'),
    recycleAfter: cfg().get<number>('recycleAfter', 30),
    cwd: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath,
    tmpDir
  });

  const session = new SessionManager(sessionConfig, log);
  const pending = new PendingStore();

  // Warm the process at activation so the first click isn't a cold start... after the first.
  session.start();

  const codeLens = new ClaudeCodeLensProvider(getMarker);
  const inline = new ClaudeInlineCompletionProvider(pending, log);

  const selector: vscode.DocumentSelector = { pattern: '**' };

  // Clear the pending ghost text on any edit (accept or typing) → one-shot behavior.
  let refreshTimer: NodeJS.Timeout | undefined;
  const onChange = vscode.workspace.onDidChangeTextDocument((e) => {
    if (pending.get() && e.document.uri.toString() === pending.get()!.uri) {
      pending.clear();
    }
    if (refreshTimer) {
      clearTimeout(refreshTimer);
    }
    refreshTimer = setTimeout(() => codeLens.refresh(), 300);
  });

  const onConfig = vscode.workspace.onDidChangeConfiguration((e) => {
    if (e.affectsConfiguration('claudeComplete.marker')) {
      codeLens.refresh();
    }
  });

  context.subscriptions.push(
    output,
    session,
    codeLens,
    onChange,
    onConfig,
    vscode.languages.registerCodeLensProvider(selector, codeLens),
    vscode.languages.registerInlineCompletionItemProvider(selector, inline),
    vscode.commands.registerCommand('claudeComplete.implement', (arg: ImplementArgs) =>
      implement(arg, session, pending, getContextLines, log).catch((err) => {
        log(`implement failed: ${String(err)}`);
        vscode.window.setStatusBarMessage('Claude: implement failed (see output).', 4000);
      })
    ),
    vscode.commands.registerCommand('claudeComplete.acceptedCleanup', (arg: { uri: string; line: number }) =>
      removeCommentLine(arg, log).catch((err) => log(`cleanup failed: ${String(err)}`))
    ),
    vscode.commands.registerCommand('claudeComplete.restartSession', () => {
      session.restart();
      vscode.window.setStatusBarMessage('Claude: session restarted.', 2000);
    })
  );

  log('activated');
}

export function deactivate(): void {
  // Disposables (incl. the session) are torn down via context.subscriptions.
}
