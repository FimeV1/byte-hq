# Changelog

## 0.2.0
- Settings › Git: every project's git state at a glance — whether the folder is a repository, its branch, its remote
  (Public/Private for GitHub remotes), commits ahead of and behind the last fetch, uncommitted files, and the problems
  in plain words ("no remote", "out of sync: 1 to push, 0 to pull", …). A "Needs attention" filter, a per-project
  **Fetch** button, a per-project
  **Connect to a repo** and **Check login**, and machines that aren't answering shown as such. **Connect** pastes a URL (https,
  ssh or scp form), which HQ validates and shows as the exact `git remote add origin …` it will run before running it;
  **Check login** runs a `git push --dry-run` (it pushes nothing) and explains in plain words what a failure means — no login
  saved, an untrusted host key, a missing permission, or a branch that just needs a pull. A GitHub
  remote's "Public/Private" badge now reads **Private or not found** when an unauthenticated call 404s. Read-only apart from
  the fetch and the connect: HQ never pushes from here.
- **Push guard for public repos.** On a public GitHub repo, one click (after confirming what it does) installs a
  `pre-push` hook where git runs it — `.git/hooks` (or the shared git dir for a linked worktree). A repo that sets
  `core.hooksPath` to a tracked folder like `.husky` is left alone: writing HQ's hook there would add a file to the repo.
   From then on a push is checked before it happens: a branch deletion or a
  force-push is refused, a file that looks like a secret is refused (`sk-`/`ghp_`/`github_pat_`/`AKIA`/Slack tokens, a
  private-key block, a `password`/`secret`/`token` value in a config file, any `.env`), and a file over 50 MB is refused.
  It scans only what the push adds: the files it adds, changes or renames, plus the lines every commit of the push adds (so a key committed and deleted again before the tip is still caught), and a block names the commit, file and line — never the secret itself. A hook
  that isn't HQ's is never overwritten; normal pushes and pulls are never affected, and `git push --no-verify` skips the
  guard when you decide to.
- Reviews of a copy chat cover the whole copy (what Apply commits), not just the last turn, and the newest review names
  the commit.
- Picking a smaller model for a big chat compacts it first, with the current model, so the next step fits.
- When an Auto chat runs out of room partway through a turn, Auto compacts it and carries on (once per 10 minutes).
- After an OpenCode server restarts, open pages reconnect and catch up instead of silently stopping updates
  (no new steps or approval prompts until reloaded).
- Apply refuses a change that adds a git repository inside the project (a model's test fixtures or a stray
  clone), which git would otherwise commit as a broken link.

## 0.1.0 (first public release)
- Chat with models on one or more OpenCode servers, from desktop or phone (installable, with notifications).
- Project chats work on a git copy: test, review, then apply to the real project as one commit.
- Auto: main model when free, fallback when busy, independent read-only review and fix rounds.
- Settings › Models: hosted APIs, local model servers (Ollama, LM Studio, llama.cpp, vLLM) and cloud providers,
  without editing config files.
- Settings › Servers: add, change and remove OpenCode servers in the app (each is tested before it's saved).
- Test a model: HQ checks a model can make tool calls (so it can edit files) when you add it, and on demand.
- Failed replies are explained in plain words with the fix; Byte API help for keys, tool access and credit, showing
  the key's balance, tool access and limits, with a button to ask for tool access.
- Saved prompts: type / in the message box.
- Plain chats: Chat (no tools, short prompt, any model) by default, Agent when you want files and commands.
- Images and videos from the Byte API in the chat (keys with that permission): kept by HQ, part of the chat's history.
- Custom instructions, memory (`/remember`) and personas, told to every chat on every device.
- Edit and resend a message; ask another model (in a branch, to compare); read answers aloud.
- Pin chats and put them in folders; export a chat as Markdown, or print / save it as PDF.
- Web search in Chat mode, per chat (OpenCode's built-in search; the model lists its sources).
- Dictation: the mic button types what you say (HQ's voice server, else the browser's speech recognition).
- PDFs attached in the message box go to the model as their text, so every model can read them.
- Tokens used under each answer, and for the whole chat.
- Images and videos gallery (Settings); deleting a chat deletes its own images and videos, a branch keeps what it shows.
- Dark theme by default, light theme in Settings; voice conversation; a shared browser; search across chats; links & logins.
- `npm run setup` wizard, `npm run selftest`, and a mock model for developing without real models.
