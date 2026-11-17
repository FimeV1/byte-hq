#!/usr/bin/env python3
"""Scripted OpenAI-compatible model for testing HQ without a real model (127.0.0.1:4299).

Behaviour, chosen from the last user message:
  contains "edit"   -> writes hello.txt, then edits it, then answers (exercises the Edited files card)
  contains "danger" -> runs `rm -rf ./nothing-here` (exercises the permission prompt)
  contains "slow"   -> streams a long answer slowly (exercises queue/steer/stop)
  contains "stall"  -> says nothing for 100 s, then answers (exercises the "no output for…" warning)
  "fetchjson"       -> a realistic small fix in src/fetch.js (for screenshots: dev/demo_project.sh makes the project)
  "overflow" / "badkey" / "nocredit" / "ratelimit" -> the HTTP error a real server sends (exercises HQ's error help)
  HQ's "Try it" check (an hq_check tool) -> calls it, except under /notools/v1, which drops tools like a server
                       or key without tool calling does (exercises the "can't edit files" help)
  "bigctx"          -> reports 120K tokens of context, then the next step is refused (HTTP 400, past the window)
  "newfile"         -> writes src/extra.js (a second file in another turn: whole-copy reviews)
  "longturn"        -> reads README.md reporting 10K tokens (over the dev config's auto.midTurnAt, under OpenCode's own limit), then
                       streams slowly (exercises mid-turn compaction)
  "reviewbig" (with "edit") -> the main model's review is refused as too big (exercises the re-review on a bigger
                       model: give mock-backup a bigger context in dev/xdg/config/opencode/opencode.jsonc to test it)
  anything else     -> short reasoning + a Markdown answer
Requests without tools (title, summary) get a short plain answer.
"""
import json, os, sys, time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

LOG = open(sys.argv[1], "a") if len(sys.argv) > 1 else None
FALLBACK = {"active": False, "offs": 0}  # pretend load state of the fallback model (auto.fallback.unload)


def chunk(delta, finish=None):
    return {"id": "mock", "object": "chat.completion.chunk", "created": int(time.time()), "model": "mock",
            "choices": [{"index": 0, "delta": delta, "finish_reason": finish}]}


def text_of(m):
    c = m.get("content")
    if isinstance(c, list):
        return " ".join(p.get("text", "") for p in c if isinstance(p, dict))
    return c or ""


BIG = {"refused": False}  # the "bigctx" refusal happens once per mock run


def plan(body):
    msgs = body.get("messages", [])
    tools = {t["function"]["name"]: t["function"] for t in body.get("tools") or []}
    last_user = next((text_of(m) for m in reversed(msgs) if m["role"] == "user"), "").lower()
    since = []
    for m in reversed(msgs):
        if m["role"] == "user":
            break
        since.append(m)
    tool_results = sum(1 for m in since if m["role"] == "tool")
    if "## Next Move" in " ".join(text_of(m) for m in msgs):
        # OpenCode's compaction prompt: it rejects a summary without its template's headings.
        return [("text", "## Objective\nMock work.\n\n## Requirements\n- none\n\n## Decisions\n- none\n\n## Work State\n"
                 "### Completed\n- mock\n\n### Active\n- none\n\n### Blocked\n- none\n\n## Next Move\nCarry on.\n\n"
                 "## Relevant Files\n- hello.txt\n\n## Important Context\nMock summary.")]
    if not tools:
        everything = " ".join(text_of(m) for m in msgs).lower()
        return [("text", "Retry failed requests in fetchJson" if "fetchjson" in everything else "Mock session title")]
    if "reviewing a code change" in last_user:
        if "reviewbig" in last_user and body.get("model") == "mock-main":
            return [("refuse", 33000)]  # the main model's review outgrows its window; a bigger backup gets it next
        if tool_results == 0 and "read" in tools:
            return [("reasoning", "Let me look at the file the diff touched."), ("tool", "read", {"path": "hello.txt"})]
        if "line 2b" in last_user and "+line 2b" in last_user:
            return [("text", "**One problem:** `hello.txt` gained `line 2b`, which wasn't asked for.\n\nVERDICT: FIX")]
        return [("text", "The change does what was asked.\n\nVERDICT: OK")]
    if "fetchjson" in last_user:
        if tool_results == 0:
            return [("reasoning", "Look at the helper before changing it."),
                    ("text", "I'll read the helper first."), ("tool", "read", {"path": "src/fetch.js"})]
        if tool_results == 1:
            return [("tool", "edit", {"path": "src/fetch.js",
                     "oldString": "export async function fetchJson(url) {\n  const r = await fetch(url);\n",
                     "newString": "export async function fetchJson(url, { tries = 3 } = {}) {\n  let r;\n  for (let i = 1; ; i++) {\n    r = await fetch(url);\n    // Retry only what can succeed later: rate limits and server errors.\n    if (r.ok || i >= tries || !(r.status === 429 || r.status >= 500)) break;\n    await new Promise((res) => setTimeout(res, 500 * 2 ** (i - 1)));\n  }\n"}),]
        return [("text", "Done. `fetchJson` now retries up to **3 times** with a growing pause (0.5 s, then 1 s), but only when "
                 "a retry can help:\n\n| Response | Retried? |\n|---|---|\n| 429 Too Many Requests | yes |\n| 500–599 server error | yes |\n"
                 "| 4xx (bad request, not found…) | no, it won't change |\n\nCallers don't change; pass `{ tries: 1 }` to turn it off:\n\n"
                 "```js\nconst user = await fetchJson(\"/api/user\", { tries: 1 });\n```")]
    if "bigctx" in last_user and "read" in tools:
        # Reports a nearly full context, then the next step is refused the way llama.cpp does past its window.
        if tool_results == 0:
            return [("usage", 120000), ("tool", "read", {"path": "README.md"})]
        if not BIG["refused"]:
            BIG["refused"] = True
            return [("refuse", 131955)]
        return [("text", "Done after the refusal.")]
    if "newfile" in last_user and "write" in tools:
        if tool_results == 0:
            return [("tool", "write", {"path": "src/extra.js", "content": "export const extra = 1;\n"})]
        return [("text", "Added src/extra.js.")]
    if "edit" in last_user:
        if tool_results == 0:
            return [("reasoning", "The user wants a file. I will create hello.txt first."),
                    ("text", "I'll create `hello.txt` first."),
                    ("tool", "write", {"path": "hello.txt", "content": "line one\nline two\nline three\n"})]
        if tool_results == 1:
            return [("tool", "edit", {"path": "hello.txt", "oldString": "line two\n", "newString": "line 2 (edited)\nline 2b\n"})]
        return [("text", "Done. I created [hello.txt](hello.txt) and then edited its second line.\n\n- one file created\n- one edit applied")]
    if "danger" in last_user:
        if tool_results == 0:
            return [("text", "Running a cleanup command."), ("tool", "shell", {"command": "rm -rf ./nothing-here", "description": "Remove a folder"})]
        return [("text", "The command finished.")]
    if "ask me" in last_user:
        if tool_results == 0:
            return [("text", "I need one decision first."),
                    ("tool", "question", {"questions": [
                        {"question": "Which colour should the button be?", "header": "Colour",
                         "options": [{"label": "Blue (Recommended)", "description": "Matches the rest of the app"},
                                     {"label": "Red", "description": "Stands out more"}]},
                        {"question": "Which pages need it?", "header": "Pages", "multiple": True,
                         "options": [{"label": "Home", "description": "Landing page"}, {"label": "Settings", "description": "Settings page"}]}]})]
        answer = next((text_of(m) for m in reversed(msgs) if m["role"] == "tool"), "")
        return [("text", "Thanks. You answered: " + answer[:300])]
    if "browse" in last_user:
        if tool_results == 0:
            return [("text", "Opening the page."),
                    ("tool", "execute", {"code": "const r = await tools.web.browser_navigate({ url: 'https://example.com' });\nreturn r;"})]
        return [("text", "I opened **example.com**. It is the IANA example page.")]
    if "stall" in last_user:
        return [("stall", 100), ("text", "Back after a long silence.")]
    if "longturn" in last_user and "read" in tools:
        if tool_results == 0:
            return [("usage", 10000), ("tool", "read", {"path": "README.md"})]
        return [("usage", 10200), ("slow", " ".join(f"word{i}" for i in range(400)))]
    if "slow" in last_user:
        return [("slow", " ".join(f"word{i}" for i in range(400)))]
    return [("reasoning", "A simple question. Answer briefly with some Markdown."),
            ("text", "Here is a **mock** answer.\n\n1. First point\n2. Second point\n\n```python\nprint('hello')\n```\n\nA table:\n\n| a | b |\n|---|---|\n| 1 | 2 |\n")]


class H(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *a):
        pass

    def do_GET(self):
        if self.path.startswith("/fallback/status"):
            b = json.dumps({"active": FALLBACK["active"], "running_jobs": 0, "offs": FALLBACK["offs"]}).encode()
        else:
            b = json.dumps({"object": "list", "data": [{"id": "mock", "object": "model"}]}).encode()
        self.send_response(200); self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(b))); self.end_headers(); self.wfile.write(b)

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0))) or b"{}")
        if self.path.startswith("/notools/"):
            body.pop("tools", None)
        last_user = next((text_of(m) for m in reversed(body.get("messages", [])) if m.get("role") == "user"), "").lower()
        errors = {"overflow": (400, "This model's maximum context length is 32768 tokens. However, your messages resulted in 41250 tokens."),
                  "badkey": (401, "Invalid API key."), "nocredit": (402, "Out of credit. Top up your balance to keep using the API."),
                  "ratelimit": (429, "Rate limit reached for requests. Try again in 20s.")}
        for word, (code, message) in errors.items():
            if body.get("tools") and word in last_user:
                b = json.dumps({"error": {"message": message, "type": "invalid_request_error", "code": word}}).encode()
                self.send_response(code); self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(b))); self.end_headers(); self.wfile.write(b)
                return
        if not body.get("stream") and "hq_check" in json.dumps(body.get("messages", [])):
            names = [t["function"]["name"] for t in body.get("tools") or []]
            msg = ({"role": "assistant", "content": "", "tool_calls": [{"id": "call_1", "type": "function", "function": {"name": "hq_check", "arguments": "{\"word\": \"ok\"}"}}]}
                   if "hq_check" in names else {"role": "assistant", "content": "ok"})
            b = json.dumps({"id": "mock", "object": "chat.completion", "choices": [{"index": 0, "message": msg, "finish_reason": "tool_calls" if "hq_check" in names else "stop"}]}).encode()
            self.send_response(200); self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(b))); self.end_headers(); self.wfile.write(b)
            return
        if self.path.startswith("/fallback/off"):
            ok = self.headers.get("x-token") == "devtoken"
            if ok:
                FALLBACK["active"] = False
                FALLBACK["offs"] += 1
            b = json.dumps({"ok": ok}).encode()
            self.send_response(200 if ok else 403); self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(b))); self.end_headers(); self.wfile.write(b)
            return
        if body.get("model") == "mock-backup":
            FALLBACK["active"] = True
        if LOG:
            LOG.write(json.dumps({"tools": [t["function"]["name"] for t in body.get("tools") or []],
                                  "n": len(body.get("messages", [])), "stream": body.get("stream")}) + "\n"); LOG.flush()
        if os.environ.get("MOCK_DUMP") and body.get("tools"):
            json.dump(body, open(os.environ["MOCK_DUMP"], "w"), indent=1)  # DUMP: last request, for inspecting prompts
        steps = plan(body)
        if steps and steps[0][0] == "refuse":
            b = json.dumps({"error": {"code": 400, "type": "exceed_context_size_error",
                            "message": f"request ({steps[0][1]} tokens) exceeds the available context size (131072 tokens)"}}).encode()
            self.send_response(400); self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(b))); self.end_headers(); self.wfile.write(b)
            return
        prompt_tokens = next((st[1] for st in steps if st[0] == "usage"), 1593)
        steps = [st for st in steps if st[0] != "usage"]
        self.send_response(200); self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache"); self.send_header("Connection", "close"); self.end_headers()

        def send(obj):
            self.wfile.write(b"data: " + json.dumps(obj).encode() + b"\n\n"); self.wfile.flush()
        finish = "stop"
        try:
            for step in steps:
                kind = step[0]
                if kind == "stall":
                    time.sleep(step[1])
                    continue
                if kind in ("text", "reasoning", "slow"):
                    words = step[1].split(" ")
                    for i, w in enumerate(words):
                        piece = w + (" " if i < len(words) - 1 else "")
                        send(chunk({"reasoning_content": piece} if kind == "reasoning" else {"content": piece}))
                        time.sleep(0.15 if kind == "slow" else 0.03)
                elif kind == "tool":
                    finish = "tool_calls"
                    send(chunk({"tool_calls": [{"index": 0, "id": f"call_{int(time.time()*1000)}", "type": "function",
                                                "function": {"name": step[1], "arguments": json.dumps(step[2])}}]}))
            send(chunk({}, finish))
            send({"id": "mock", "object": "chat.completion.chunk", "choices": [],
                  "usage": {"prompt_tokens": prompt_tokens, "completion_tokens": 47, "total_tokens": prompt_tokens + 47}})
            self.wfile.write(b"data: [DONE]\n\n"); self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError):
            pass


ThreadingHTTPServer(("127.0.0.1", 4299), H).serve_forever()
