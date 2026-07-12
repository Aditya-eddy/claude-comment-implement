import * as vscode from 'vscode';
import { findMarkers } from './commentScanner';

/** Renders a "⚡ Implement with Claude" lens above every //claude comment. */
export class ClaudeCodeLensProvider implements vscode.CodeLensProvider {
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses = this.emitter.event;

  constructor(private readonly getMarker: () => string) {}

  refresh(): void {
    this.emitter.fire();
  }

  provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
    return findMarkers(document, this.getMarker()).map((m) =>
      new vscode.CodeLens(m.range, {
        title: '⚡ Implement with Claude',
        command: 'claudeComplete.implement',
        arguments: [{ uri: document.uri.toString(), line: m.line, instruction: m.instruction }]
      })
    );
  }

  dispose(): void {
    this.emitter.dispose();
  }
}
