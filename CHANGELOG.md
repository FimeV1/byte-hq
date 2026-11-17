# Changelog

## 0.3.1
- **Idle compaction** (`auto.idleCompact`, off by default): big Auto chats are summarised while they sit idle, so the
  next message doesn't re-read the whole chat on a local model whose cache has gone. Choose any model on that machine
  to write the summary (`idleCompact.model`, e.g. a small one that's always loaded), or leave it to the chat's own
  model; the chat keeps its own model afterwards. It never touches a running chat, waits while the summarising model
  is busy, and never starts the primary for it. See CONFIG.md.
- README › Keep it running: OpenCode now starts with the computer on Linux (systemd) and macOS (launchd) too, reading
  its password from `~/.config/hq-app/opencode.env` instead of the service file; HQ's service waits for it.
- Closing a steps log or card no longer leaves a grey, unpainted area in Safari until the next scroll.

## 0.3.0
- **Windows.** HQ now runs on Windows 10 and 11, with a one-command installer for PowerShell:
  `irm https://raw.githubusercontent.com/FimeV1/byte-hq/main/install.ps1 | iex`. It does what the macOS/Linux one does
  (OpenCode 2 is installed by OpenCode's own installer in Git Bash), never asks for admin rights and never changes
  PowerShell settings. `run_opencode.ps1`, `run_hq.ps1` and `start_all.ps1` (for a Task Scheduler log-on task) start the
  servers in the background; they keep running when the window closes.
- **Fix: Apply, Test and Settings › Git on a Windows machine.** OpenCode runs commands on Windows through cmd.exe in a
  way that hands quoted arguments to programs with their quotes still on (OpenCode 2.2.7 and 2.3.0), so Apply failed
  at "making the patch" and Settings › Git's commands failed. HQ's own commands on Windows now go to PowerShell
  (encoded, so cmd can't change them) with literal single-quoted arguments. Commands you write yourself (a project's
  test command, release commands) still run exactly as typed. Tested with a project folder named `it's a proj`.
- `npm run selftest -- --full` makes its test folder a git repository (OpenCode only tracks changes inside one), so
  the diff and undo checks no longer fail on a fresh machine.

## 0.2.1
- **One-command install** for macOS and Linux:
  `curl -fsSL https://raw.githubusercontent.com/FimeV1/byte-hq/main/install.sh | bash`. It checks git and Node.js,
  installs OpenCode 2 if it's missing (asks before replacing OpenCode 1), downloads or updates HQ, starts an OpenCode
  server with a generated password, runs setup with that server filled in, builds and offers to start HQ. Never uses
  sudo; run it again to update.
- `run_opencode.sh`: starts an OpenCode server for HQ in the background; its password is kept in
  `~/.config/hq-app/opencode.env` (readable only by you).
- HQ started with `run_hq.sh` no longer stops when the terminal that started it closes (Node.js undoes `nohup`).
- `run_hq.sh` stops the previous HQ only if that process id still belongs to HQ.
- README: install OpenCode 2 with its v2 installer; the plain installer and npm still give OpenCode 1.

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
- Optional `auto.midTurnAt`: a turn that grows past that many tokens is paused, the chat compacted, and the model
  told to carry on (for setups that turn off OpenCode's own compaction, or whose long chats get slow before they're
  full).
- A review that runs out of room is run again on the other Auto model when that one has a bigger window, instead of
  being lost. A review that ends without a verdict (empty, crashed, or only OpenCode's compaction summary) is
  reported as "the review gave no verdict", never as "review looks good".
- **Review checklists** (`review-checklists.md`): a change to guard-type code (push hooks, secret scanners, permission
  checks, logins) gets a review that must try the known ways around it, and ask for a real test of any it can't rule
  out. Reviewers are also told to check the change's docs and comments against the code, and to read only the lines
  they need.
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
