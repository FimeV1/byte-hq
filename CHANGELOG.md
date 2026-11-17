# Changelog

## 0.2.0
- Settings › Git: every project's git state at a glance — whether the folder is a repository, its branch, its remote
  (Public/Private for GitHub remotes), commits ahead of and behind the last fetch, uncommitted files, and the problems
  in plain words ("no remote", "out of sync: 1 to push, 0 to pull", …). A "Needs attention" filter, a per-project
  **Fetch** button, and machines that aren't answering shown as such. Read-only apart from the fetch: HQ never pushes
  from here.

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
