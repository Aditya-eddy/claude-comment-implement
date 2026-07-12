# claude-comment-implement — Design

**Date:** 2026-07-13
**Status:** Approved, building

## Summary

A VS Code extension that lets a developer request code **on demand** by writing a marker comment
and clicking a **CodeLens**. The developer writes:

```js
//claude add a function that reverses a linked list
```

A CodeLens (`⚡ Implement with Claude`) appears above that line. Clicking it sends the
instruction plus surrounding file context to the **Haiku** model. The generated code is then
surfaced as **inline ghost text** below the comment, which the developer accepts with **Tab**
(Copilot-style) or dismisses with Esc.

It requires **no Anthropic API key**: it drives the developer's **local `claude` CLI**, reusing
existing Claude Code auth. To avoid paying the ~12s "cold" harness-load cost on the first click,
the extension keeps **one warm `claude` process** alive for the workspace lifetime and sends each
implement request as a new turn on it.

## Why this shape (design history)

- Original idea: Copilot-style per-keystroke inline ghost text. Rejected by the user: keystroke
  triggering is indeterministic and latency-sensitive (~1.9s warm is not sub-second).
- Pivot: **deterministic, click-triggered** implementation via a `//claude …` comment + CodeLens.
  The user invokes it only when they want it, so latency matters far less.
- Warm session retained per the user's earlier explicit preference ("spin up the CLI on load,
  reuse it, don't spawn every time"). For click-triggering the warm benefit is smaller than for
  keystroke triggering; spawn-per-click (`claude -p`) is a viable simpler alternative if we ever
  want to drop the long-lived process.

## Goals (MVP)

- Detect `//claude <instruction>` (and `#claude`, `--claude`) comment lines in **all languages**.
- Show a CodeLens above each such line offering to implement it.
- On click: send instruction + context to the warm Haiku session and insert the generated code
  below the comment, matching indentation.
- No API key.

## Non-Goals (deferred)

- Per-keystroke *automatic* inline ghost text (ghost text here is triggered by the click, not by
  typing).
- Response cache, multi-suggestion cycling.
- Diff/preview-before-apply UI.

On acceptance, the original `//claude …` marker comment is **removed**: the accepted
`InlineCompletionItem` carries a `command` (`claudeComplete.acceptedCleanup`) that VS Code runs
after insertion, which deletes the comment line (merged into the accept's undo step so a single
Ctrl+Z reverts both the insert and the removal).

## Empirical basis (measured, `claude` 2.1.207, Node 24)

Persistent streaming session (`claude --print --input-format stream-json --output-format
stream-json --verbose`), multiple turns on one process:

| Turn | Wall time | `cache_creation` | Result |
|------|-----------|------------------|--------|
| Cold (turn 0, at activation) | ~12.3s | 8128 tokens | correct |
| Warm (turn 1) | ~1.99s | 1139 tokens | correct |
| Warm (turn 2) | ~1.88s | 195 tokens | correct |

Warm turns are ~1.9s and ~10× cheaper than a fresh spawn; the ~12s cold cost is paid once at
activation. Turns are independent enough that a later turn ignores earlier turns' content.

## Architecture

```
user types:  //claude reverse a linked list
  → CodeLensProvider scans the document, finds the marker line
  → renders CodeLens "⚡ Implement with Claude" above it
  → user CLICKS  ← deterministic trigger
      → command claudeComplete.implement fires with {uri, line, instruction}
      → gather context: contextLines above (incl. comment) = CODE_BEFORE,
        contextLines below = CODE_AFTER; capture comment indentation
      → withProgress notification "Implementing…"
      → session.send(promptFor(instruction, before, after, languageId), token)
            → write one stream-json user message to the warm claude process
            → read stdout until this turn's {type:"result"} event → resolve result
      → strip fences, re-indent to the comment's indentation
      → store PendingCompletion{ uri, anchor=end of comment line, text="\n"+code }
      → move cursor to anchor; executeCommand('editor.action.inlineSuggest.trigger')
  → InlineCompletionItemProvider.provideInlineCompletionItems fires
      → if a PendingCompletion matches this uri + cursor line → return it as ghost text
  → user presses TAB → VS Code inserts the text; Esc / typing dismisses it
```

### Components

**`src/session.ts` — `SessionManager`** (owns the warm child process)
- `start()`: spawn
  `claude --print --input-format stream-json --output-format stream-json --verbose
   --model <model>
   --disallowedTools Bash Read Edit Write Glob Grep WebFetch WebSearch
   --append-system-prompt "<system prompt>"`  with `stdio: ['pipe','pipe','pipe']`.
- `send(content, token): Promise<string>`:
  - Serialized on an internal promise chain (single process = single conversation).
  - Writes `{"type":"user","message":{"role":"user","content":"…"}}\n`.
  - Reads stdout, framing on `\n`, parsing JSON events, until `{type:"result"}`; resolves `result`.
  - If `token` cancels: resolve `""`, discard the eventual result (do NOT kill — keep warm).
- **Auto-recycle** after `recycleAfter` sends (default 30) or on process exit/error; lazy restart
  on next request. Bounds accumulating conversation context.
- `dispose()`: kill child.

**`src/commentScanner.ts`**
- `findMarkers(document): Marker[]` — regex over each line:
  `/^(\s*)(?:\/\/|#|--|;)\s*claude\b[:\s]*(.*)$/` → `{ line, indent, instruction, range }`.
  Ignores lines whose instruction is empty.

**`src/codeLensProvider.ts` — `ClaudeCodeLensProvider implements vscode.CodeLensProvider`**
- `provideCodeLenses(document)`: `findMarkers` → one `CodeLens` per marker with command
  `claudeComplete.implement`, title `⚡ Implement with Claude`, args
  `[{ uri, line, instruction }]`.
- `onDidChangeCodeLenses` fires on `workspace.onDidChangeTextDocument` (light debounce) so lenses
  track edits.

**`src/pending.ts` — `PendingStore`**
- Shared single-slot store for the generated-but-not-yet-accepted completion:
  `{ uri: string, line: number, character: number, text: string } | null`.
- `set(p)`, `get()`, `clear()`. Command writes it; inline provider reads it.

**`src/implementCommand.ts`**
- `implement({uri, line, instruction}, session, pending)`:
  - Resolve document + editor; re-read the marker line (edits may have shifted it) to get current
    indentation and confirm the instruction.
  - Build CODE_BEFORE (up to `contextLines` lines ending at the marker) and CODE_AFTER
    (up to `contextLines` lines after).
  - `withProgress({location: Notification, cancellable: true})` → `session.send(prompt, token)`.
  - Clean result (trim, strip ``` fences); re-indent each line to the marker indent.
  - `pending.set({ uri, line, character = end-of-comment-line, text = "\n" + code })`.
  - Move the editor selection to the end of the comment line and
    `executeCommand('editor.action.inlineSuggest.trigger')` so the ghost text shows.
  - On empty result or error: show a status message, set nothing.

**`src/inlineCompletionProvider.ts` — `ClaudeInlineCompletionProvider`**
- Implements `vscode.InlineCompletionItemProvider`; registered for `{ pattern: '**' }`.
- `provideInlineCompletionItems(document, position)`: read `pending.get()`; if it matches
  `document.uri` and `position.line === pending.line` → return one `InlineCompletionItem(text,
  Range(position, position))`. Else `undefined`. Does **not** clear (so the ghost text re-renders
  on VS Code's repeated requests while shown).
- Pending is cleared by an `onDidChangeTextDocument` listener (fires on accept or on typing) and
  whenever a new implement starts — so it is inherently one-shot.

**`src/extension.ts`**
- `activate(context)`: read config; construct + `start()` the `SessionManager`; construct the
  `PendingStore`; register the CodeLens provider and the inline-completion provider for
  `{ pattern: '**' }`; register commands `claudeComplete.implement` and
  `claudeComplete.restartSession`; register the `onDidChangeTextDocument` listener that clears
  pending. Push disposables to `context.subscriptions`.
- `deactivate()`: `session.dispose()`.

**`package.json`**
- `engines.vscode`, `main: ./out/extension.js`, `activationEvents: ["onStartupFinished"]`.
- `contributes.configuration`:
  - `claudeComplete.model` (default `claude-haiku-4-5-20251001`)
  - `claudeComplete.claudePath` (default `claude`)
  - `claudeComplete.contextLines` (default 80)
  - `claudeComplete.recycleAfter` (default 30)
  - `claudeComplete.marker` (default `claude`) — the keyword after the comment leader.
- `contributes.commands`: `claudeComplete.implement`, `claudeComplete.restartSession`.

### Prompts

**System prompt (`--append-system-prompt`):**
> You are a code generation engine embedded in a code editor. The user requests code by writing a
> comment beginning with a marker (e.g. `//claude`, `#claude`, `--claude`) followed by an
> instruction. You are given the language, the instruction, and the surrounding code (CODE_BEFORE
> ends at the marker comment; CODE_AFTER follows it). Output ONLY the raw code to insert on the
> line(s) immediately after the comment. Do not repeat the comment. No explanations, no markdown
> code fences. Match the surrounding language and style.

**Per-request user message:**
```
LANGUAGE: {languageId}
INSTRUCTION: {instruction}

CODE_BEFORE:
{before}

CODE_AFTER:
{after}
```

## Build & Run

- TypeScript → `out/` via `tsc`. `npm run compile` / `npm run watch`.
- `.vscode/launch.json` for the Extension Development Host (F5).

## Error handling

- `claude` not found / spawn failure: output-channel log + one-time warning; commands no-op.
- Turn error (`is_error`): resolve `""`, mark session for recycle, status message to user.
- Malformed stdout JSON lines: skip.
- Never throw into VS Code; degrade to "nothing inserted" + a message.

## Testing

- Unit: `commentScanner` regex (leaders, indent capture, empty instruction), stream-json line
  framing across chunk boundaries, fence stripping, re-indentation, recycle counter.
- Manual (Extension Development Host): write `//claude …` in JS/TS/Python; confirm the CodeLens
  appears; click it; confirm code is inserted below with correct indentation; confirm progress
  notification and cancel; confirm `restartSession` works; confirm behavior with `claude` missing.

## Risks / caveats

- ~1.9s warm / ~12s cold per implement (Haiku turn latency through the harness).
- Warm conversation accumulates context; bounded by `recycleAfter`.
- Line shifts between lens render and click handled by re-reading the marker line at click time.
