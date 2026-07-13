# Claude Activity inspector — Design

**Date:** 2026-07-13
**Status:** Approved, building

## Summary

A sidebar (Activity Bar) webview — **"Claude Activity"** — that shows a live, newest-first list of
every request the extension sends to Claude and the response it returns. Each entry is collapsible:
a header (time + instruction), a meta line (model · duration · status), and two expandable
sections — **Request** (the exact prompt sent) and **Response** (the raw result string).

## Components

- `src/activityLog.ts` — **`ActivityLog`**: in-memory ring buffer (default 100) of
  `ActivityEntry { id, timestamp, instruction, prompt, response, model, durationMs?, status }`
  where `status ∈ pending | ok | cancelled | empty | error`. API: `start({instruction,prompt,model})
  → id` (inserts newest-first as `pending`), `complete(id, {response,status,durationMs})`,
  `clear()`, `getEntries()`, `onDidChange` event, `dispose()`. Bounded so memory can't grow
  unbounded.
- `src/activityView.ts` — **`ClaudeActivityViewProvider`** implements `vscode.WebviewViewProvider`
  (view id `claudeComplete.activityView`). On resolve: `enableScripts`, render themed HTML with a
  strict CSP + script nonce, subscribe to `onDidChange` and `postMessage({type:'entries', entries})`,
  handle a `{type:'clear'}` message back. The webview script renders entries into the DOM using
  **`textContent`** (not innerHTML) so code containing `< & "` is inherently safe — no manual
  escaping needed. Uses `<details>/<summary>` for native collapsing. Styled with `var(--vscode-*)`.
- `media/claude.svg` — monochrome (`currentColor`) lightning-bolt icon for the Activity Bar.

## Data flow

In `implementCommand.implement`, around the `session.send` call:
```
id = activityLog.start({ instruction, prompt, model })   // entry shows immediately as 'pending'
startedAt = Date.now()
result = await withProgress(cancellable, (_,token) => { token.onCancellationRequested(()=>cancelled=true); return session.send(prompt, token) })
status = cancelled ? 'cancelled' : (result.trim() ? 'ok' : 'empty')   // 'error' on thrown exception
activityLog.complete(id, { response: result, status, durationMs: Date.now()-startedAt })
```
The webview updates live via `onDidChange`. Entries persist in the log even when the panel is
closed; opening it renders the current buffer.

## package.json additions

- `viewsContainers.activitybar`: `{ id: 'claude-activity', title: 'Claude Activity', icon: 'media/claude.svg' }`.
- `views['claude-activity']`: `{ type: 'webview', id: 'claudeComplete.activityView', name: 'Requests' }`.
- Commands: `claudeComplete.clearActivity` (icon `$(clear-all)`), `claudeComplete.showActivity`.
- `menus.view/title`: Clear button shown when `view == claudeComplete.activityView`.
- `.vscodeignore`: keep `media/**` in the package.

## Wiring (extension.ts)

Create `ActivityLog`; register the view provider via `window.registerWebviewViewProvider`; thread
`activityLog` and the current `model` into `implement`; register `clearActivity` (→ `log.clear()`)
and `showActivity` (→ focus `claudeComplete.activityView`). Push disposables to subscriptions.

## Scope (YAGNI)

- In-memory only; not persisted across window reloads.
- No token/cost display for now (could be added later from the session `result` event).
- Existing output-channel logging stays unchanged.

## Testing

- Unit (`ActivityLog`): start inserts newest-first as pending; complete patches by id; ring buffer
  caps length; clear empties; getEntries order.
- Manual: click a ⚡ Implement lens → entry appears `pending` → flips to `ok` with correct Request
  (full prompt) and Response (raw result); Clear empties the list; cancel yields `cancelled`.
