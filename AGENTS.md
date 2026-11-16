# AGENTS.md: working on HQ

HQ is a web app for working with your own models through OpenCode servers. It is a window: OpenCode does the agent
work (models, tools, edits, permissions, undo); HQ adds the chat UI, Auto (model choice + independent review), work on
a copy (test, review, apply to live), search across machines and phone notifications. README.md says what it does,
CONFIG.md every setting.

**If `NOTES.local.md` exists in this folder, read it first.** It holds the maintainer's own notes (not published).

## Files
| File | What it does |
|---|---|
| `server.mjs` | Serves the built UI, login, relays `/oc/<machine>/…` to each OpenCode server, the `/hq/*` endpoints |
| `auto.mjs` | Auto: picks the primary or fallback model (`auto.primary` / `auto.fallback`), compacts long chats, reviews and fix rounds |
| `copies.mjs` | Work on a copy: git worktree per chat, copy guard, Test, Apply to live, Restart, Discard |
| `models.mjs` | Settings › Models: adds model providers to an OpenCode server (key via OpenCode's API, or HQ's own `opencode.json`), **Test** (can the model make tool calls?), the Chat agent for plain chats, and making/serving images and videos (Byte API) |
| `machines.mjs` | Settings › Servers: add, change, remove OpenCode servers; tests first, writes the config, applies without a restart |
| `setup.mjs` | `npm run setup`: tests each OpenCode server, picks models, writes the config |
| `search.mjs`, `notify.mjs`, `browser.mjs` | Search across chats, Web Push notifications, the shared headless browser |
| `src/api.ts` | Every call to OpenCode; if an OpenCode endpoint changes, the fix is usually here |
| `src/store.ts` | App state; `applyEvent` turns OpenCode's live events into chat updates |
| `src/turns.ts`, `src/Chat.tsx` | Messages grouped into turns, and the conversation view |
| `src/CopyBar.tsx`, `src/ReviewCard.tsx`, `src/Composer.tsx` | Copy controls, the review card, the message box |
| `src/ModelsDialog.tsx` | The Models dialog (uses `/hq/models/*` in `server.mjs` → `models.mjs`) |
| `src/Help.tsx` | Test results in words, failed replies explained (`explainError`), the no-tools banner, Byte API help |
| `src/Prompts.tsx` | Saved prompts: the / menu in the message box and the dialog to edit them |
| `src/Personal.tsx` | Settings › Personal: custom instructions, memory, personas (sent to chats by `syncInstructions` in store.ts) |
| `src/PrintView.tsx` | Print or save as PDF: the chat as a document, printed by the browser |
| `src/speech.ts` | Read aloud: the voice server, or the browser's speech when there isn't one |
| `src/dictation.ts` | The mic button: record, then the voice server's speech-to-text (or the browser's recognition) |
| `src/pdf.ts` | PDFs attached in the message box become their text (pdf.js, loaded on first use) |
| `src/Gallery.tsx` | Settings › Images and videos: every saved file, its chat, size, Delete (`media/index.json` via models.mjs) |
| `dev/` | A fake OpenCode setup with a scripted model, for testing without real models (`/notools/v1` acts like a server without tool calls; "overflow", "badkey", "nocredit", "ratelimit" in a message return that error) |

## Checks (run all before saying you're done)
    npx tsc --noEmit -p .                                  # types
    for f in *.mjs; do node --check $f; done
    npm run build                                          # the UI still builds
For behaviour: `sh dev/run_dev_backend.sh`, then `sh dev/restart_hq.sh`, open http://127.0.0.1:4112, and try it.
`node selftest.mjs` checks every OpenCode feature HQ uses (needs a config and running servers).

## Rules
- Never commit secrets. Settings and passwords live in `~/.config/hq-app/` (mode 600), never in this repo.
- Nothing here may name a real person, machine, address or private service. Examples use placeholders.
- Keep README.md and CONFIG.md true in the same change that alters what they describe.
- Colours only through the tokens at the top of `src/styles.css`, and every new token in both themes (dark and light).
- No inline `<script>` or `on…=` handlers: the Content-Security-Policy (server.mjs) blocks them.
- Copies and Auto exist because models make mistakes: never weaken the copy guard, the review, or the permission
  rules to make something easier.
