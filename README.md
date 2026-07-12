# Claude Comment Implement

Write a `//claude <instruction>` comment, click the **⚡ Implement with Claude** CodeLens above
it, and the generated code appears as **inline ghost text** you accept with **Tab** (Copilot-style).

Powered by your **local `claude` CLI** running the Haiku model — **no Anthropic API key required**.
The extension reuses your existing Claude Code authentication.

## How it works

```
//claude reverse a singly linked list        ← you write this
⚡ Implement with Claude                      ← CodeLens appears above it; click it
                                              ← Haiku generates (progress notification)
function reverse(head) { ... }                ← shown as ghost text; press Tab to accept
```

- On activation the extension spins up **one warm `claude` process** and reuses it for every
  request (streaming stdin/stdout). The first request pays a one-time "cold" cost (~10s while the
  harness loads); subsequent requests are ~2–3s.
- The process is recycled after `recycleAfter` completions (default 30) to bound context growth.

## Requirements

- The `claude` CLI installed and authenticated (`claude --version`).
- VS Code ^1.84.

## Run it (development)

```bash
npm install
npm run compile      # or: npm run watch
```

Then press **F5** in VS Code to launch the Extension Development Host. In the new window, open any
file and type a `//claude ...` comment.

## Supported comment styles

Any of these leaders followed by the marker keyword and an instruction:

```
//claude do the thing
#claude do the thing
-- claude do the thing
;claude do the thing
```

## Settings

| Setting | Default | Description |
|---|---|---|
| `claudeComplete.model` | `claude-haiku-4-5-20251001` | Model id passed to `--model`. |
| `claudeComplete.claudePath` | `claude` | Path to the `claude` CLI binary. |
| `claudeComplete.contextLines` | `80` | Lines of code before/after the comment sent as context. |
| `claudeComplete.recycleAfter` | `30` | Recycle the warm process after this many completions. |
| `claudeComplete.marker` | `claude` | Keyword after the comment leader that triggers the CodeLens. |

## Commands

- **Claude: Implement This Comment** — invoked by the CodeLens.
- **Claude: Restart Completion Session** — kill and restart the warm process.

## Design

See `docs/superpowers/specs/2026-07-13-claude-inline-complete-design.md` in the source tree.
