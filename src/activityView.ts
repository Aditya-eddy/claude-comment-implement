import * as vscode from 'vscode';
import * as crypto from 'crypto';
import { ActivityLog } from './activityLog';

/** Renders the Claude Activity sidebar webview and keeps it in sync with the ActivityLog. */
export class ClaudeActivityViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewId = 'claudeComplete.activityView';
  private view?: vscode.WebviewView;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly log: ActivityLog
  ) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [this.extensionUri]
    };
    view.webview.html = this.getHtml(view.webview);

    const sub = this.log.onDidChange(() => this.post());
    view.onDidDispose(() => {
      sub.dispose();
      this.view = undefined;
    });
    view.webview.onDidReceiveMessage((msg: { type?: string }) => {
      if (msg?.type === 'clear') {
        this.log.clear();
      }
    });

    this.post(); // initial render
  }

  private post(): void {
    this.view?.webview.postMessage({ type: 'entries', entries: this.log.getEntries() });
  }

  private getHtml(webview: vscode.Webview): string {
    const nonce = crypto.randomBytes(16).toString('hex');
    const csp = [
      "default-src 'none'",
      "style-src 'unsafe-inline'",
      `script-src 'nonce-${nonce}'`
    ].join('; ');

    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="${csp}" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<style>
  body { font-family: var(--vscode-font-family); font-size: var(--vscode-font-size);
         color: var(--vscode-foreground); padding: 0 8px 12px; }
  .toolbar { display:flex; justify-content:flex-end; padding: 6px 0; position: sticky; top:0;
             background: var(--vscode-sideBar-background); }
  button { background: var(--vscode-button-secondaryBackground, transparent);
           color: var(--vscode-foreground); border: 1px solid var(--vscode-panel-border);
           padding: 2px 8px; border-radius: 4px; cursor: pointer; font-size: 11px; }
  button:hover { background: var(--vscode-toolbar-hoverBackground); }
  .empty { opacity: 0.6; padding: 16px 4px; font-style: italic; }
  .entry { border: 1px solid var(--vscode-panel-border); border-radius: 6px;
           margin: 8px 0; overflow: hidden; }
  .head { padding: 6px 8px; }
  .instr { font-weight: 600; word-break: break-word; }
  .meta { font-size: 11px; opacity: 0.8; margin-top: 2px; }
  .status { font-weight: 600; }
  .status.ok { color: var(--vscode-testing-iconPassed, #3fb950); }
  .status.error, .status.empty { color: var(--vscode-testing-iconFailed, #f85149); }
  .status.cancelled { color: var(--vscode-testing-iconQueued, #d29922); }
  .status.pending { color: var(--vscode-progressBar-background, #4c8bf5); }
  details { border-top: 1px solid var(--vscode-panel-border); }
  summary { cursor: pointer; padding: 4px 8px; font-size: 11px; user-select: none;
            opacity: 0.9; }
  pre { margin: 0; padding: 8px; white-space: pre-wrap; word-break: break-word;
        background: var(--vscode-textCodeBlock-background, rgba(127,127,127,0.1));
        font-family: var(--vscode-editor-font-family, monospace); font-size: 12px;
        max-height: 320px; overflow: auto; }
</style>
</head>
<body>
  <div class="toolbar"><button id="clear">Clear</button></div>
  <div id="list"></div>
<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  document.getElementById('clear').addEventListener('click', () => vscode.postMessage({ type: 'clear' }));
  window.addEventListener('message', (e) => {
    if (e.data && e.data.type === 'entries') render(e.data.entries || []);
  });

  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = text;
    return n;
  }
  function fmtTime(ts) {
    try { return new Date(ts).toLocaleTimeString(); } catch { return String(ts); }
  }
  function section(label, content) {
    const d = document.createElement('details');
    d.appendChild(el('summary', null, label));
    d.appendChild(el('pre', null, content || ''));
    return d;
  }
  function render(entries) {
    const root = document.getElementById('list');
    root.textContent = '';
    if (!entries.length) {
      root.appendChild(el('div', 'empty', 'No requests yet. Write a //claude comment and click the ⚡ Implement lens.'));
      return;
    }
    for (const en of entries) {
      const wrap = el('div', 'entry');
      const head = el('div', 'head');
      head.appendChild(el('div', 'instr', en.instruction || '(no instruction)'));
      const dur = en.durationMs != null ? (en.durationMs / 1000).toFixed(1) + 's' : '…';
      const meta = el('div', 'meta');
      meta.appendChild(el('span', null, fmtTime(en.timestamp) + '  ·  ' + (en.model || '?') + '  ·  ' + dur + '  ·  '));
      meta.appendChild(el('span', 'status ' + en.status, en.status));
      head.appendChild(meta);
      wrap.appendChild(head);
      wrap.appendChild(section('Request  (prompt sent)', en.prompt));
      wrap.appendChild(section('Response  (raw result)', en.response));
      root.appendChild(wrap);
    }
  }
</script>
</body>
</html>`;
  }
}
