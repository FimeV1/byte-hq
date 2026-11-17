# HQ settings (`~/.config/hq-app/config.json`)

`npm run setup` writes the basics for you. This page lists everything, including the optional extras.
Keep the file private (the setup makes it readable only by you): it holds your HQ login and your servers' passwords.

## Basics
| Key | What |
|---|---|
| `name` | App name shown in the title bar. |
| `listen` | `[{ "host": "127.0.0.1", "port": 4110 }]`. Use `127.0.0.1` and put HTTPS in front (Tailscale Serve, Caddy, nginx) to reach HQ from other devices. |
| `auth` | `{ "user", "password" }` for the sign-in page (password: 8+ characters). Without it HQ only starts on a `127.0.0.1` address. Changing the password signs every device out. |
| `backends` | Your OpenCode servers ("machines"): `{ "id", "label", "url", "user", "password", "home", "chatsDir" }`. `home`/`chatsDir` may be relative (`./project`) to the config file. Easiest to change in HQ: **Settings › Servers** (add, change, remove; HQ tests each one first and keeps the previous file as `config.json.bak`). |
| `projectsFile`, `prefsFile` | Where projects and synced preferences are kept (default: next to the config). |
| `browser` | `false` to turn off the shared browser, or `{ "port", "profile" }`. |

## Models
Models live on each OpenCode server, not in this file. Add them in HQ (**Settings › Models**, or **Add models…** in the
model menu) or during `npm run setup`:
- **Hosted APIs and model servers** (the Byte API, Ollama, LM Studio, llama.cpp, vLLM, any OpenAI-compatible address):
  HQ writes them to `opencode.json` in that server's global OpenCode config folder, which OpenCode merges with your own
  config and reloads by itself. HQ only edits that file if HQ created it (it keeps a record in `models/` next to this
  config). If you already have your own `opencode.json` there, HQ shows you the lines to add instead.
  The same file holds HQ's **Chat** agent (`hq-chat`: a short system prompt and no tools), which plain chats use; HQ
  adds it the first time you start a plain chat. With your own `opencode.json`, plain chats use the coding agent.
- **Cloud providers OpenCode knows** (OpenAI, Anthropic, OpenRouter and ~300 more): just a key, stored by OpenCode.

Each model gets an explicit context size and image setting, because OpenCode's defaults (200K, images on) would stop
Auto from compacting long chats on a smaller local model. Set the context to what the server really runs with.

**Test** (in Settings › Models, before or after adding) asks the model once to call a harmless test tool. Coding needs
tool calls, and a model or server without them still chats, so without the test the only sign is that it never edits
anything. Results are kept in `models/checks.json` next to this config, and a model that was never tried is tested
quietly the first time you pick it. For the Byte API, HQ first asks the API what the key may do (no tokens used), so a
key without tool access or credit shows straight away; **Settings › Byte API help** shows the key's balance, tool access
and limits, and has an **Ask for tool access** button. A key that was waiting for tool access is looked at again by itself.

## Images and videos
With a Byte API key that has the image (or video) permission, the composer gets a picture button, and `/image …` or
`/video …` makes one. HQ saves each file in `media/` next to this config and serves it only to people logged in to HQ;
the chat keeps a line saying what was made, so the model knows about it. `media/index.json` records which chats show
each file: deleting a chat deletes the files only it shows (a branch of the chat keeps its pictures). **Settings ›
Images and videos** lists them all, with the space they take, a link to each one's chat, and Delete.

## Web search, dictation, PDFs
- **Search the web** (the Chat / Agent menu, Chat mode only): the chat may use OpenCode's own `websearch` (Exa's free
  public search, no key) and `webfetch`, and nothing else; the model is asked to list its sources. It needs a model
  with tool calls. Agent mode already has these tools.
- **Dictation**: the mic button records until you press it again, then types what you said. It uses HQ's voice server
  when one is set up (`voice` in the config), else the browser's own speech recognition (Chrome, Edge and Safari send
  that audio to their maker). Microphones need https or localhost.
- **PDFs** attached in the message box are turned into text in the browser (pdf.js, loaded only when needed) and sent
  as `name.pdf.txt`, so models that can't read files still can. A PDF with no text (a scan) is sent as it is.

## Saved prompts
Type **/** in the message box to pick a saved prompt; it fills the box so you can change it before sending. Add, edit
and delete them in **Settings › Saved prompts**. They're kept with the synced preferences (`prefs.json`).

## Personal: custom instructions, memory, personas
**Settings › Personal** holds what every chat is told about you ("about you and how to answer", plus facts to remember;
`/remember …` in the message box adds one) and personas a chat can use (Chat / Agent menu). They're kept with the synced
preferences (`prefs.json`) and given to each chat as OpenCode context entries (`hq-about`, `hq-persona`) with its next
message, so they reach whichever model the chat uses. Keep secrets out of them.

## Chats: edit, compare, pin, export
- **Edit** a sent message: its reply and everything after are undone (Redo brings them back) and the text goes back into
  the box. In a project this also undoes those turns' file changes.
- **Ask another model** sends the same message in a new chat branched from just before it, so the answers can be compared.
- **Pin** and **folders** (chat menu in the sidebar) are stored in the chat itself, so they show on every device.
- **Export as Markdown** and **Print or save as PDF**: what was asked and each answer (tool steps left out).
- **Read aloud** uses the voice server when one is set up, otherwise the browser's own speech.

## Shared browser (`browser`)
HQ runs one headless Chromium that you see live in the side pane (**Browser** tab) and can click and type into. It needs
Chromium: `npx playwright install chromium` (or an installed Chrome). `"browser": false` turns it off;
`{ "port": 9335, "profile": "~/.hq-app/browser-profile" }` changes where it listens (always 127.0.0.1) and keeps its
profile. It starts logged out of everything; anything you sign in to there, the agent can use too.

To let the agent drive it, add Playwright MCP to the OpenCode config **on the same computer as HQ** (the browser only
listens on 127.0.0.1), with your paths:
```jsonc
"mcp": {
  // Not called "browser": that name clashes with OpenCode's own browser tools.
  "web": {
    "type": "local",
    "command": ["node", "/path/to/hq/node_modules/@playwright/mcp/cli.js", "--cdp-endpoint", "http://127.0.0.1:9335"],
    "enabled": true
  }
}
```
The pane then follows the agent while it browses.

## Auto (`auto`)
HQ picks the model, reviews the work with a read-only reviewer, and sends fixes back (up to two rounds).
```json
"auto": {
  "primary":  { "providerID": "llama", "modelID": "my-coder", "label": "Desktop coder",
                "health": "http://desktop:8080/health",
                "start": "ssh desktop start-model",
                "busyCheck": "ssh desktop check-busy",
                "images": false,
                "llamaServerUrl": "http://desktop:8080" },
  "fallback": { "providerID": "ollama", "modelID": "big-model", "label": "Big model", "images": true,
                "unload": { "statusUrl": "...", "offUrl": "...", "token": "..." } },
  "vision":   { "url": "http://localhost:11434/api/chat", "model": "a-vision-model" },
  "compactAt": 90000
}
```
- **primary** does the work when it's available; **fallback** otherwise. Both name a model on your OpenCode servers.
- `health` (optional): a URL that answers 200 when the primary is up. `start` (optional): a command that starts it.
- `busyCheck` (optional): any command. Exit 0 with output = busy (the output is shown as the reason, e.g. a game's
  name); exit 0 with no output = free; failure = the machine isn't answering.
- `images: false` on a primary that can't see pictures: with `vision` set, pictures are described as text for it;
  without, they go to a fallback that has `images: true`.
- `llamaServerUrl` (optional): a llama-server started with `--slot-save-path`; its cache is saved around reviews.
- `fallback.unload` (optional): unload the fallback after a review it was loaded only for.
- `compactAt`: tokens in context before a primary turn compacts the chat first.
- `"auto": false` turns Auto off.

## Git
No setting to file: **Settings › Git** reads live state. For each project it shows whether the folder is a git
repository, the current branch, the remote URL (any login in it is stripped before display), whether a GitHub remote
is public or private (an unauthenticated GitHub API call, cached for ten minutes), the commits ahead of and behind
the **last fetch**, the uncommitted files, the last commit, and the problems in plain words. A **Fetch** button per
project runs `git fetch --prune` (30-second timeout); opening the section never fetches, and nothing here ever pushes.
A machine that isn't answering shows *can't reach \<machine\>* for its own rows and blocks nothing else.
- **Connect to a repo**: paste a remote URL (only `https://`, `ssh://` and scp `user@host:path` forms are accepted).
  It is validated for shell metacharacters (spaces, quotes, `;` `|` `&` `<` `>` `$`, backticks, newlines, backslashes),
  shown to you as the exact `git remote add origin <url>` it will run, and runs that one command — it never overwrites an
  existing `origin`.
- **Check login**: runs `git push --dry-run --no-verify origin HEAD` (it transfers nothing and runs no local hooks, and a
  60-second timeout is a failed check, never a hang) and explains the result in plain words — no login saved, the host key
  isn't trusted, no push permission, or the branch is behind (a non-fast-forward still means the login works; the branch
  just needs a pull or rebase). A dry run sends no files, so it can't check GitHub's rule that changing `.github/workflows`
  needs a token with the workflow permission; that only shows up on a real push.

## Optional extras
| Key | What |
|---|---|
| `push` | `{ "contact": "mailto:you@example.com" }` for phone notifications (Web Push). Use a real address: Apple rejects made-up ones. `false` turns them off. |
| `voice` | `{ "stt": "http://…/transcribe", "tts": "http://…/tts", "voice": "am_michael" }` (Whisper-style and Kokoro-style servers). |
| `notes` | "Save to guide": `{ "guide": "<MCP URL with guide_list/guide_note>", "llm": "<OpenAI-style chat URL>", "model": "…" }`. |
| `vault` | Links & logins: `{ "file": "~/links.json" }` or `{ "ssh": "user@host", "path": "~/links.json" }`. File format: `{ "links": [{ "group", "name", "url", "note" }], "items": [{ "name", "url", "user", "password", "note" }] }`. Never shown to models. |
| `credit` | Co-author line on commits applied from a copy: `{ "name": "My Assistant ({role})", "email": "…", "line": "…", "footer": "…" }`. Off by default. |
| `health` | `{ "name": "url" }` model servers to check (shown by `/hq/health`). |
