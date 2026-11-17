#!/usr/bin/env node
// HQ server: serves the built UI and relays the browser to one or more OpenCode 2.x servers.
//
// Why a relay instead of the browser calling OpenCode directly:
//   - each OpenCode server has its own password; the browser only ever knows HQ's login
//   - one origin for several machines (no CORS), so "a project is a machine plus a folder"
//
// Routes
//   /oc/<backend>/...   -> relayed to that backend (streams, so the event feed works)
//   /hq/config          -> app name + the backend list (no secrets)
//   /hq/projects        -> GET / PUT the project list (a JSON file next to the config)
//   /hq/machines        -> the machine list; /hq/machines/{test,save,remove} change it (machines.mjs)
//   /hq/git/{status,refresh,connect,check-login} -> Settings › Git: state, fetch, connect a remote, check the login (git.mjs)
//   /hq/models/*        -> Settings › Models and the model Test (models.mjs)
//   /hq/media/*         -> images and videos made with the Byte API: /make, and the saved files (models.mjs)
//   everything else     -> the built UI in dist/ (index.html for unknown paths)
//
// Config: $HQ_CONFIG or ~/.config/hq-app/config.json. See CONFIG.md for the shape.
import http from "node:http";
import https from "node:https";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { SharedBrowser } from "./browser.mjs";
import { createAuto } from "./auto.mjs";
import { createNotifier, watchForNotifications } from "./notify.mjs";
import { createSearch } from "./search.mjs";
import { createCopies } from "./copies.mjs";
import { createGit } from "./git.mjs";
import { createModels } from "./models.mjs";
import { createMachines } from "./machines.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const expand = (p) => (p.startsWith("~") ? path.join(os.homedir(), p.slice(1)) : path.resolve(p));
const CONFIG_PATH = expand(process.env.HQ_CONFIG || "~/.config/hq-app/config.json");
if (Number(process.versions.node.split(".")[0]) < 22) {
  console.error(`HQ needs Node.js 22 or newer (this is ${process.version}).`);
  process.exit(1);
}
if (!fs.existsSync(CONFIG_PATH)) {
  console.error(`No HQ config at ${CONFIG_PATH}.\nRun \`npm run setup\` first (or set HQ_CONFIG to your config file).`);
  process.exit(1);
}
let config;
try {
  config = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
} catch (e) {
  console.error(`${CONFIG_PATH} isn't valid JSON (${e.message}). Fix it, or run \`npm run setup\` to write a new one.`);
  process.exit(1);
}
if (!Array.isArray(config.backends) || !config.backends.length || !Array.isArray(config.listen) || !config.listen.length) {
  console.error(`${CONFIG_PATH} needs "listen" and at least one machine in "backends" (see CONFIG.md, or run \`npm run setup\`).`);
  process.exit(1);
}
// Safety: without a login, HQ (and every OpenCode server behind it, with their shells) is open to anyone who can
// reach it. That's only acceptable on this computer's loopback address.
const LOOPBACK = /^(127\.\d+\.\d+\.\d+|localhost|::1|\[::1\])$/;
if (!config.auth && config.listen.some((l) => !LOOPBACK.test(String(l.host || "")))) {
  console.error('Refusing to start: HQ has no login ("auth" in the config) but listens on a non-local address. Add "auth" (npm run setup does) or listen on 127.0.0.1.');
  process.exit(1);
}
if (config.auth && (!config.auth.user || !config.auth.password || String(config.auth.password).length < 8)) {
  console.error('Refusing to start: "auth" needs a user and a password of at least 8 characters.');
  process.exit(1);
}
try {
  if (process.platform !== "win32" && fs.statSync(CONFIG_PATH).mode & 0o077) {
    console.log(`Warning: ${CONFIG_PATH} can be read by other users of this computer, and it holds passwords. Fix: chmod 600 "${CONFIG_PATH}"`);
  }
} catch {}
const PROJECTS_PATH = expand(config.projectsFile || path.join(path.dirname(CONFIG_PATH), "projects.json"));
// Preferences that follow you between devices (model picks, voice, answered review questions).
const PREFS_PATH = expand(config.prefsFile || path.join(path.dirname(CONFIG_PATH), "prefs.json"));
const DIST = path.join(HERE, "dist");
// Paths in the config may be relative ("./project"): they resolve from the config file's folder.
const fromConfig = (p) => (p && /^\.\.?[\\/]/.test(p) ? path.resolve(path.dirname(CONFIG_PATH), p) : p);
for (const b of config.backends) Object.assign(b, { home: fromConfig(b.home), chatsDir: fromConfig(b.chatsDir) });
if (config.browser?.profile) config.browser.profile = fromConfig(config.browser.profile);
const backends = new Map(config.backends.map((b) => [b.id, b]));
// The shared browser (agent + side pane). On unless the config says "browser": false.
const browser = config.browser === false ? null : new SharedBrowser(config.browser || {});
if (browser) browser.start().catch((e) => console.log("browser not started:", e.message));
// Auto mode: model choice + automatic review (auto.mjs, settings in config.auto). Off with "auto": false.
const stamp = (m) => console.log(new Date().toISOString().slice(11, 19), m);
// Phone notifications (notify.mjs): keys + subscriptions in push.json next to the config.
const notifier = config.push === false ? null : createNotifier({ configDir: path.dirname(CONFIG_PATH), contact: config.push?.contact || "", log: stamp });
const readProjects = () => (fs.existsSync(PROJECTS_PATH) ? JSON.parse(fs.readFileSync(PROJECTS_PATH, "utf8")) : []);
// "Work on a copy" (copies.mjs): worktree per chat, test there, apply only when tested.
const copies = createCopies({ backends, projects: readProjects, credit: config.credit || {}, log: stamp });
// Settings › Git: the git state of every project (git.mjs), read-only apart from the user's Refresh.
const git = createGit({ backends, projects: readProjects, log: stamp });
const pushLink = (b, sid, dir) => `/?open=${encodeURIComponent(JSON.stringify({ backend: b.id, sid, dir }))}`;
const auto = config.auto === false ? null : createAuto({
  config, backends, log: stamp,
  testCopy: (b, sid) => copies.test(b.id, sid),
  notify: notifier
    ? (b, sid, ses, text) => notifier.send("HQ", text, pushLink(b, sid, ses.location?.directory), `done-${sid}`).catch(() => {})
    : null,
});
const chatSearch = createSearch({ backends, log: (m) => console.log(m) });
const modelSetup = createModels({ backends, configDir: path.dirname(CONFIG_PATH), log: stamp });
const notifyWatch = notifier ? watchForNotifications({ backends, notifier, isAutoReviewed: (b, ses) => (auto ? auto.willReview(b, ses).catch(() => false) : false), outsideEdits: (b, ses) => (auto ? auto.outsideEdits(b, ses).catch(() => []) : []), log: stamp }) : null;
// Settings › Servers: machines added there start being watched (Auto, notifications) without a restart.
const machines = createMachines({
  configPath: CONFIG_PATH, config, backends, fromConfig, log: stamp,
  usedBy: (id) => readProjects().filter((p) => p.backend === id).map((p) => p.name || p.directory),
  onAdd: (b) => (notifyWatch?.watch(b), auto?.watch(b)),
});

const MIME = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml",
  ".woff2": "font/woff2", ".woff": "font/woff", ".png": "image/png", ".json": "application/json", ".ico": "image/x-icon", ".webmanifest": "application/manifest+json",
};

function sameString(a, b) {
  const x = crypto.createHash("sha256").update(a).digest();
  const y = crypto.createHash("sha256").update(b).digest();
  return crypto.timingSafeEqual(x, y);
}

// ---- login ------------------------------------------------------------------------------------
// A login page sets a signed cookie (90 days), because phone home-screen apps handle the browser's
// password pop-up badly. Basic auth still works for scripts. The signing key lives next to the
// config; changing the password or deleting that file signs everyone out.
const SECRET_PATH = path.join(path.dirname(CONFIG_PATH), "secret");
const SECRET = (() => {
  if (!config.auth) return "";
  if (!fs.existsSync(SECRET_PATH)) fs.writeFileSync(SECRET_PATH, crypto.randomBytes(32).toString("hex"), { mode: 0o600 });
  return fs.readFileSync(SECRET_PATH, "utf8").trim();
})();
const SESSION_DAYS = 90;
const sign = (exp) => crypto.createHmac("sha256", SECRET).update(`${config.auth.user}:${config.auth.password}:${exp}`).digest("base64url");
const newToken = () => {
  const exp = Date.now() + SESSION_DAYS * 864e5;
  return `${exp}.${sign(exp)}`;
};
function validToken(t) {
  const [exp, mac] = String(t || "").split(".");
  return !!mac && Number(exp) > Date.now() && sameString(mac, sign(exp));
}
const cookie = (req, name) => (req.headers.cookie || "").split(/;\s*/).find((c) => c.startsWith(name + "="))?.slice(name.length + 1);
const viaHttps = (req) => req.headers["x-forwarded-proto"] === "https" || /\.ts\.net(:\d+)?$/.test(req.headers.host || "");

function authorised(req) {
  if (!config.auth) return true; // dev config: localhost only, no login
  if (validToken(cookie(req, "hq_session"))) return true;
  const h = req.headers.authorization || "";
  if (!h.startsWith("Basic ")) return false;
  const [user, ...rest] = Buffer.from(h.slice(6), "base64").toString("utf8").split(":");
  return sameString(user, config.auth.user) && sameString(rest.join(":"), config.auth.password);
}

let failures = [];
/** The sign-in page with its one inline script allowed by a fresh nonce. */
function loginPage(res, code, msg = "") {
  const nonce = crypto.randomBytes(16).toString("base64");
  return send(res, code, LOGIN_PAGE(msg, nonce), {
    "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store",
    "Content-Security-Policy": `default-src 'self'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; img-src 'self'; form-action 'self'; base-uri 'none'; object-src 'none'; frame-ancestors 'self'`,
  });
}
const LOGIN_PAGE = (msg = "", nonce = "") => `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><meta name="color-scheme" content="dark">
<meta name="theme-color" content="#0f1115"><link rel="manifest" href="/manifest.webmanifest"><link rel="apple-touch-icon" href="/apple-touch-icon.png">
<link rel="icon" type="image/svg+xml" href="/favicon.svg">
<meta name="apple-mobile-web-app-capable" content="yes"><meta name="apple-mobile-web-app-status-bar-style" content="black-translucent"><title>${esc(config.name || "HQ")}</title>
<style>:root{--bg:#0f1115;--card:#15181d;--field:#1f242b;--border:#2a3039;--text:#ecedf0;--accent:#6f5cf0;--accent-hover:#8070f5;--err:#f2554b}
*{box-sizing:border-box}body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:var(--bg);color:var(--text);font:15px/1.4 system-ui,-apple-system,"Segoe UI",sans-serif;padding:16px}
form{width:100%;max-width:340px;background:var(--card);border:1px solid var(--border);border-radius:12px;padding:24px;display:flex;flex-direction:column;gap:12px}
h1{margin:0 0 6px;font-size:20px;display:flex;align-items:center;gap:10px}h1 img{width:28px;height:28px}
input{height:42px;border-radius:8px;border:1px solid var(--border);background:var(--field);color:inherit;padding:0 12px;font:inherit;outline:none}input:focus{border-color:var(--accent)}
button{height:42px;border:0;border-radius:8px;background:var(--accent);color:#fff;font:inherit;font-weight:600;cursor:pointer}button:hover{background:var(--accent-hover)}p{margin:0;color:var(--err);font-size:13.5px}</style></head>
<body><form method="post" action="/hq/login"><h1><img src="/favicon.svg" alt="">${esc(config.name || "HQ")}</h1>${msg ? `<p>${esc(msg)}</p>` : ""}
<input name="user" placeholder="Username" autocomplete="username" autocapitalize="off" required>
<input name="password" type="password" placeholder="Password" autocomplete="current-password" required>
<button>Sign in</button></form>
<script nonce="${nonce}">/* Sign in without leaving this page in the history, so a back swipe in the home-screen app can't land on it. */
document.querySelector("form").addEventListener("submit", async (e) => {
  e.preventDefault();
  try {
    const r = await fetch("/hq/login", { method: "POST", headers: { accept: "application/json" }, body: new URLSearchParams(new FormData(e.target)) });
    if (r.ok) return location.replace("/");
    const d = await r.json().catch(() => ({}));
    let p = document.querySelector("form p");
    if (!p) { p = document.createElement("p"); document.querySelector("h1").after(p); }
    p.textContent = d.message || "Couldn't sign in.";
  } catch { e.target.submit(); }
});
</script></body></html>`;

async function login(req, res) {
  if (req.method === "GET" || req.method === "HEAD") {
    // Already signed in (e.g. a back swipe landed here): go straight back to HQ instead of showing the form.
    if (authorised(req)) {
      res.writeHead(303, { Location: "/", "Cache-Control": "no-store" });
      return res.end();
    }
    return loginPage(res, 200);
  }
  if (req.method !== "POST") return send(res, 405, "", { Allow: "GET, POST" }); // only a POST is a sign-in attempt
  const asJson = (req.headers.accept || "").includes("application/json"); // the login page's script
  failures = failures.filter((t) => t > Date.now() - 10 * 60e3);
  if (failures.length >= 10) {
    if (asJson) return json(res, 429, { message: "Too many attempts. Wait ten minutes." });
    return loginPage(res, 429, "Too many attempts. Wait ten minutes.");
  }
  const form = new URLSearchParams((await readBody(req, 8192)).toString("utf8"));
  if (sameString(form.get("user") || "", config.auth.user) && sameString(form.get("password") || "", config.auth.password)) {
    const flags = `Path=/; Max-Age=${SESSION_DAYS * 86400}; HttpOnly; SameSite=Lax${viaHttps(req) ? "; Secure" : ""}`;
    const setCookie = `hq_session=${newToken()}; ${flags}`;
    if (asJson) return json(res, 200, { ok: true }, { "Set-Cookie": setCookie });
    res.writeHead(303, { Location: "/", "Set-Cookie": setCookie });
    return res.end();
  }
  failures.push(Date.now());
  if (asJson) return json(res, 401, { message: "Wrong username or password." });
  return loginPage(res, 401, "Wrong username or password.");
}

// Files a phone needs before signing in (the app icon and manifest).
const PUBLIC = new Set(["/manifest.webmanifest", "/icon-192.png", "/icon-512.png", "/apple-touch-icon.png", "/favicon.svg"]);

// ---- voice --------------------------------------------------------------------------------------
// Speech-to-text and text-to-speech: your own Whisper-style /transcribe and Kokoro-style /tts servers
// (config.voice: { stt, tts, voice }). Without them, voice mode says it isn't set up.
const VOICE = { stt: "", tts: "", voice: "am_michael", ...(config.voice || {}) };

// ---- notes for the shared guide -----------------------------------------------------------------
// "Save to guide" (optional, config.notes): a fast model suggests lasting facts from a turn, you pick which to keep,
// and they're appended to a notes server your models read (an MCP server with guide_list / guide_note tools).
// llm: an OpenAI-style chat completions URL; use a fast model with thinking off, or it may never write the JSON.
const NOTES = { guide: "", llm: "", model: "", ...(config.notes || {}) };

async function guideCall(name, args) {
  if (!NOTES.guide) throw new Error("Save to guide isn't set up (config.notes)");
  const r = await fetch(NOTES.guide, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
    signal: AbortSignal.timeout(20_000),
  });
  const body = await r.text();
  const m = /\{[\s\S]*\}/.exec(body);
  const msg = m ? JSON.parse(m[0]) : null;
  if (!msg?.result) throw new Error(msg?.error?.message || `guide answered ${r.status}`);
  return msg.result.content?.map((c) => c.text).join("\n") || "";
}

const SUGGEST_SYSTEM = `You pick out LASTING facts from one exchange between a user and their coding assistant, to save in a shared guide that every local model reads before working on their setup.

Worth saving: a gotcha that cost time, where something lives, a setting that was changed and why, a command that works, a measured number, a decision the user made.
Not worth saving: what was done in this task, progress, anything obvious from the code, guesses, secrets/keys/passwords.

Reply with JSON only, no other text: {"notes":[{"topic":"<one of the topics>","note":"<1-3 factual sentences>"}]}. Use {"notes":[]} when nothing qualifies. At most 4 notes.`;

async function notesRoute(req, res, p) {
  if (req.method !== "POST") return send(res, 405, "");
  const body = JSON.parse((await readBody(req, 256 << 10)).toString("utf8") || "{}");
  try {
    if (p === "/hq/notes/suggest") {
      const list = await guideCall("guide_list", {});
      const lines = [...list.matchAll(/^- ([a-z0-9-]+): (.*)$/gm)].filter((m) => m[1] !== "GUIDE" && m[1] !== "memory");
      const topics = lines.map((m) => m[1]);
      const topicHelp = lines.map((m) => `- ${m[1]}: ${m[2]}`).join("\n") + "\n(use general when none of these really fits)";
      const exchange = [
        `The user asked:\n${String(body.request || "").slice(0, 4000)}`,
        body.work ? `What the assistant did:\n${String(body.work).slice(0, 8000)}` : "",
        body.files?.length ? `Files changed: ${body.files.slice(0, 30).join(", ")}` : "",
        `The assistant's answer:\n${String(body.answer || "").slice(0, 6000)}`,
      ].filter(Boolean).join("\n\n");
      const r = await fetch(NOTES.llm, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: NOTES.model, stream: false, temperature: 0.2, max_tokens: 1500, reasoning_effort: "none",
          messages: [{ role: "system", content: SUGGEST_SYSTEM + `\n\nTopics:\n${topicHelp}` }, { role: "user", content: exchange }],
        }),
        signal: AbortSignal.timeout(120_000),
      });
      if (!r.ok) return json(res, 502, { message: `the model answered ${r.status}` });
      const text = (await r.json()).choices?.[0]?.message?.content || "";
      const m = /\{[\s\S]*\}/.exec(text);
      let notes = [];
      try { notes = (m ? JSON.parse(m[0]).notes : []) || []; } catch { notes = []; }
      notes = notes
        .filter((n) => n && typeof n.note === "string" && n.note.trim())
        .slice(0, 4)
        .map((n) => ({ topic: topics.includes(n.topic) ? n.topic : "general", note: n.note.trim().slice(0, 1400) }));
      return json(res, 200, { topics, notes });
    }
    if (p === "/hq/notes/save") {
      const note = String(body.note || "").trim();
      const topic = String(body.topic || "general");
      const out = await guideCall("guide_note", { topic, note, author: "hq-approved-by-user" });
      if (/^(REFUSED|note must|No topic|Don't)/.test(out)) return json(res, 400, { message: out });
      return json(res, 200, { ok: true, message: out });
    }
  } catch (e) {
    return json(res, 502, { message: e.message });
  }
  return send(res, 404, "");
}

// ---- model health ---------------------------------------------------------------------------------
// Optional model-server health checks (config.health: { name: url }), cached for 10 s.
const HEALTH = config.health || {};
let healthCache = { at: 0, data: null };
async function health() {
  if (healthCache.data && Date.now() - healthCache.at < 10_000) return healthCache.data;
  const probe = (u) => fetch(u, { signal: AbortSignal.timeout(2500) }).then((r) => r.ok).catch(() => false);
  const names = Object.keys(HEALTH);
  const ok = await Promise.all(names.map((n) => probe(HEALTH[n])));
  healthCache = { at: Date.now(), data: Object.fromEntries(names.map((n, i) => [n, ok[i]])) };
  return healthCache.data;
}

async function voiceRoute(req, res, p, url) {
  if (req.method !== "POST") return send(res, 405, "");
  if (!VOICE.stt || !VOICE.tts) return json(res, 501, { message: "Voice isn't set up: add config.voice { stt, tts }." });
  try {
    if (p === "/hq/voice/transcribe") {
      const audio = await readBody(req, 25 << 20);
      const r = await fetch(VOICE.stt, { method: "POST", body: audio, headers: { "content-type": "audio/wav" }, signal: AbortSignal.timeout(60_000) });
      if (!r.ok) return json(res, 502, { message: `speech-to-text failed (${r.status})` });
      return json(res, 200, await r.json());
    }
    if (p === "/hq/voice/speak") {
      const text = (await readBody(req, 64 << 10)).toString("utf8");
      const voice = url.searchParams.get("voice") || VOICE.voice;
      const speed = url.searchParams.get("speed") || "1.0";
      const r = await fetch(`${VOICE.tts}?voice=${encodeURIComponent(voice)}&speed=${encodeURIComponent(speed)}`, {
        method: "POST", body: text, headers: { "content-type": "text/plain; charset=utf-8" }, signal: AbortSignal.timeout(60_000),
      });
      if (!r.ok) return json(res, 502, { message: `text-to-speech failed (${r.status})` });
      return send(res, 200, Buffer.from(await r.arrayBuffer()), { "Content-Type": "audio/wav", "Cache-Control": "no-store" });
    }
  } catch (e) {
    return json(res, 502, { message: `voice server unreachable: ${e.message}` });
  }
  return send(res, 404, "");
}

function send(res, code, body, headers = {}) {
  const buf = typeof body === "string" ? Buffer.from(body) : body;
  res.writeHead(code, { "Content-Length": buf.length, ...headers });
  res.end(buf);
}
const json = (res, code, obj, headers = {}) => send(res, code, JSON.stringify(obj), { "Content-Type": "application/json", ...headers });

function readBody(req, limit = 1 << 20) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > limit) { reject(new Error("body too large")); req.destroy(); } else chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

// ---- links & logins ---------------------------------------------------------------------------
// Optional (config.vault): a JSON file of { links: [{group,name,url,note}], items: [{name,url,user,password,note}] },
// either local ({ "file": "~/links.json" }) or on another machine over SSH ({ "ssh": "user@host", "path": "..." }).
// HQ keeps a private copy next to its config (mode 600), so it still shows when that machine is down.
// Only this signed-in page shows it; it is never sent to a model.
const VAULT_SRC = config.vault || null;
const VAULT_CACHE = path.join(path.dirname(CONFIG_PATH), "vault-cache.json");
async function readVault() {
  const clean = (d, from) => ({
    from,
    links: (d.links || []).map((l) => ({ group: String(l.group || "Links"), name: String(l.name || ""), url: String(l.url || ""), note: String(l.note || "") })),
    logins: (d.items || []).map((i) => ({ name: String(i.name || ""), url: String(i.url || ""), user: String(i.user || ""), password: String(i.password || ""), note: String(i.note || "") })),
  });
  if (!VAULT_SRC) return { from: "none", error: "Links & logins isn't set up (config.vault).", links: [], logins: [] };
  try {
    const raw = VAULT_SRC.file
      ? fs.readFileSync(expand(VAULT_SRC.file), "utf8")
      : await new Promise((resolve, reject) =>
          execFile("ssh", ["-o", "BatchMode=yes", "-o", "ConnectTimeout=5", VAULT_SRC.ssh, `cat ${VAULT_SRC.path}`], { timeout: 10_000, maxBuffer: 1 << 20 },
            (e, out) => (e ? reject(e) : resolve(out))));
    const data = JSON.parse(raw);
    fs.writeFileSync(VAULT_CACHE + ".tmp", JSON.stringify(data), { mode: 0o600 });
    fs.renameSync(VAULT_CACHE + ".tmp", VAULT_CACHE);
    return clean(data, "source");
  } catch (e) {
    if (fs.existsSync(VAULT_CACHE)) return clean(JSON.parse(fs.readFileSync(VAULT_CACHE, "utf8")), "copy");
    return { from: "none", error: `Couldn't read the list (${e.message.split("\n")[0]}) and there's no saved copy yet.`, links: [], logins: [] };
  }
}

function relay(req, res, backend, rest) {
  // Always the machine's own address: the path is appended, never resolved (so "https:other-host/…" stays a path).
  const base = new URL(backend.url);
  const target = new URL(base.origin + base.pathname.replace(/\/+$/, "") + "/" + rest.replace(/^\/+/, ""));
  if (target.origin !== base.origin) return json(res, 400, { message: "bad path" });
  const headers = { ...req.headers, host: target.host };
  delete headers.authorization;
  delete headers.cookie;
  delete headers.origin; // same-origin to the backend, so its CORS check never applies
  delete headers.referer;
  if (backend.user) headers.authorization = "Basic " + Buffer.from(`${backend.user}:${backend.password}`).toString("base64");
  const up = (target.protocol === "https:" ? https : http).request(target, { method: req.method, headers }, (r) => {
    const out = { ...r.headers };
    delete out["www-authenticate"]; // a backend 401 must not make the browser re-prompt for HQ's login
    if ((r.headers["content-type"] || "").includes("text/event-stream")) out["x-accel-buffering"] = "no";
    res.writeHead(r.statusCode || 502, out);
    r.pipe(res);
    // pipe() only ends the browser's side when the backend ENDS its reply. When the backend dies instead (restart,
    // crash), the reply is aborted, and the browser's event stream stayed open to nothing: the page went deaf (no
    // steps, no permission prompts) until reloaded. Close it so the page reconnects and catches up.
    r.on("aborted", () => res.destroy());
    r.on("error", () => res.destroy());
    r.on("close", () => !r.complete && res.destroy());
  });
  // A machine that's off (e.g. a desktop overnight) never answers the connection, and the OS waits ~75 s to give up.
  // Fail the CONNECT after 4 s instead; once connected, long replies and event streams are unaffected.
  up.on("socket", (s) => {
    if (!s.connecting) return;
    const t = setTimeout(() => up.destroy(new Error("not answering (switched off or asleep?)")), 4000);
    s.once("connect", () => clearTimeout(t));
    s.once("close", () => clearTimeout(t));
  });
  up.on("error", (e) => {
    if (!res.headersSent) json(res, 502, { _tag: "BackendUnreachable", message: `${backend.label || backend.id}: ${e.message}` });
    else res.destroy();
  });
  res.on("close", () => up.destroy()); // browser went away: drop the upstream stream too
  req.pipe(up);
}

/** Changes whenever the UI is rebuilt (index.html names the hashed asset files), so open pages can offer a reload. */
let buildCache = { mtime: 0, id: "" };
function buildId() {
  try {
    const f = path.join(DIST, "index.html");
    const m = fs.statSync(f).mtimeMs;
    if (m !== buildCache.mtime) buildCache = { mtime: m, id: crypto.createHash("sha256").update(fs.readFileSync(f)).digest("hex").slice(0, 12) };
    return buildCache.id;
  } catch {
    return "";
  }
}

// The app's pages may run only HQ's own scripts: if a model's reply ever slipped past the Markdown sanitiser, an
// injected <script> or inline handler still wouldn't run. Images may come from anywhere (models link pictures).
const APP_CSP = [
  "default-src 'self'", "script-src 'self'", "style-src 'self' 'unsafe-inline'", "img-src 'self' data: blob: https: http:",
  "media-src 'self' data: blob:", "font-src 'self' data:", "connect-src 'self'", "worker-src 'self'", "manifest-src 'self'",
  "object-src 'none'", "base-uri 'self'", "form-action 'self'", "frame-ancestors 'self'",
].join("; ");

function serveStatic(req, res, pathname) {
  let file;
  try {
    file = path.normalize(path.join(DIST, decodeURIComponent(pathname)));
  } catch {
    return send(res, 400, "bad path");
  }
  if (file !== DIST && !file.startsWith(DIST + path.sep)) return send(res, 403, "forbidden");
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(DIST, "index.html");
  if (!fs.existsSync(file)) return send(res, 503, "UI not built yet: run `npm run build` in the hq folder.");
  const ext = path.extname(file);
  const cache = file.includes(`${path.sep}assets${path.sep}`) ? "public, max-age=31536000, immutable" : "no-cache";
  const csp = ext === ".html" ? { "Content-Security-Policy": APP_CSP } : {};
  send(res, 200, fs.readFileSync(file), { "Content-Type": MIME[ext] || "application/octet-stream", "Cache-Control": cache, ...csp });
}

/** A file with byte-range support: video players (Safari's above all) only play and seek with it. */
function sendFileRange(req, res, file, type) {
  const size = fs.statSync(file).size;
  const head = { "Content-Type": type, "Accept-Ranges": "bytes", "Cache-Control": "private, max-age=31536000, immutable", "X-Content-Type-Options": "nosniff" };
  const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || "");
  if (!m || (!m[1] && !m[2])) {
    res.writeHead(200, { ...head, "Content-Length": size });
    if (req.method === "HEAD") return res.end();
    return fs.createReadStream(file).pipe(res);
  }
  let start = m[1] ? Number(m[1]) : Math.max(0, size - Number(m[2]));
  let end = m[1] && m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
  if (start > end || start >= size) {
    res.writeHead(416, { "Content-Range": `bytes */${size}` });
    return res.end();
  }
  res.writeHead(206, { ...head, "Content-Range": `bytes ${start}-${end}/${size}`, "Content-Length": end - start + 1 });
  if (req.method === "HEAD") return res.end();
  fs.createReadStream(file, { start, end }).pipe(res);
}

/**
 * True when the request came from HQ's own page, or from a script with no browser headers (curl).
 * Browsers mark every request with Sec-Fetch-Site; that works behind proxies (Tailscale Serve, nginx) where the Host
 * header may differ from the address in the browser. Older browsers without it: compare Origin with Host.
 */
function sameOrigin(req) {
  const site = req.headers["sec-fetch-site"];
  if (site) return site === "same-origin" || site === "none";
  const o = req.headers.origin;
  if (!o || o === "null") return !o;
  try {
    const host = new URL(o).host;
    return host === req.headers.host || host === req.headers["x-forwarded-host"];
  } catch {
    return false;
  }
}

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

async function handle(req, res) {
  const url = new URL(req.url, "http://x");
  const p = url.pathname;
  // Cross-site requests can't change anything: a page on another site could otherwise make a signed-in browser send
  // a message or run a command (the cookie is SameSite=Lax, which covers forms; this covers everything else).
  if (req.method !== "GET" && req.method !== "HEAD" && !sameOrigin(req)) return json(res, 403, { message: "cross-site request refused" });
  if (config.auth && p === "/hq/login") return login(req, res);
  if (p === "/hq/logout") {
    res.writeHead(303, { Location: "/hq/login", "Set-Cookie": "hq_session=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax" });
    return res.end();
  }
  if (!authorised(req) && !(PUBLIC.has(p) && req.method === "GET")) {
    // Pages go to the login form; API calls get a plain 401 (no browser pop-up).
    if (req.method === "GET" && (req.headers.accept || "").includes("text/html")) {
      res.writeHead(303, { Location: "/hq/login" });
      return res.end();
    }
    return json(res, 401, { message: "Login required" });
  }

  if (p.startsWith("/oc/")) {
    const [, , id, ...rest] = p.split("/");
    const backend = backends.get(id);
    if (!backend) return json(res, 404, { message: `unknown backend ${id}` });
    return relay(req, res, backend, rest.join("/") + url.search);
  }
  if (p === "/hq/config") {
    return json(res, 200, {
      name: config.name || "HQ",
      backends: config.backends.map((b) => ({ id: b.id, label: b.label || b.id, home: b.home, chatsDir: b.chatsDir })),
      browser: !!browser,
      voice: { voice: VOICE.voice },
      login: !!config.auth,
      build: buildId(),
    });
  }
  if (p.startsWith("/hq/voice/")) return voiceRoute(req, res, p, url);
  if (p.startsWith("/hq/notes/")) return notesRoute(req, res, p);
  if (p === "/hq/health") return json(res, 200, await health());
  if (p.startsWith("/hq/copy/") && req.method === "POST") {
    try {
      const body = JSON.parse((await readBody(req, 64 << 10)).toString("utf8") || "{}");
      if (p === "/hq/copy/start") return json(res, 200, await copies.start(body.backend, body.directory, body));
      if (p === "/hq/copy/isgit") return json(res, 200, { git: await copies.isGit(body.backend, body.directory) });
      if (p === "/hq/copy/test") return json(res, 200, await copies.test(body.backend, body.sessionID));
      if (p === "/hq/copy/apply") return json(res, 200, await copies.apply(body.backend, body.sessionID));
      if (p === "/hq/copy/discard") return json(res, 200, await copies.discard(body.backend, body.sessionID));
      if (p === "/hq/copy/restart") return json(res, 200, await copies.restart(body.backend, body.sessionID));
    } catch (e) {
      // The app only shows this briefly; keep it in hq.log so a failed apply can be looked at later.
      stamp(`${p} failed: ${e.message}`);
      return json(res, 400, { message: e.message });
    }
    return send(res, 404, "");
  }
  if (p === "/hq/git/status" && req.method === "GET") {
    try {
      const project = url.searchParams.get("project");
      if (!project) return json(res, 400, { message: "missing project" });
      return json(res, 200, await git.status(project), { "Cache-Control": "no-store" });
    } catch (e) {
      stamp(`/hq/git/status failed: ${e.message}`);
      return json(res, 400, { message: e.message });
    }
  }
  if (p === "/hq/git/refresh" && req.method === "POST") {
    try {
      const body = JSON.parse((await readBody(req, 16 << 10)).toString("utf8") || "{}");
      return json(res, 200, await git.refresh(String(body.project)), { "Cache-Control": "no-store" });
    } catch (e) {
      stamp(`/hq/git/refresh failed: ${e.message}`);
      return json(res, 400, { message: e.message });
    }
  }
  if (p === "/hq/git/connect" && req.method === "POST") {
    try {
      const body = JSON.parse((await readBody(req, 16 << 10)).toString("utf8") || "{}");
      return json(res, 200, await git.connectRemote(String(body.project), String(body.url || "")), { "Cache-Control": "no-store" });
    } catch (e) {
      stamp(`/hq/git/connect failed: ${e.message}`);
      return json(res, 400, { message: e.message });
    }
  }
  if (p === "/hq/git/check-login" && req.method === "POST") {
    try {
      const body = JSON.parse((await readBody(req, 16 << 10)).toString("utf8") || "{}");
      return json(res, 200, await git.checkLogin(String(body.project)), { "Cache-Control": "no-store" });
    } catch (e) {
      stamp(`/hq/git/check-login failed: ${e.message}`);
      return json(res, 400, { message: e.message });
    }
  }
  if (p.startsWith("/hq/models/")) {
    try {
      if (p === "/hq/models/status") return json(res, 200, await modelSetup.status(url.searchParams.get("backend")), { "Cache-Control": "no-store" });
      if (p === "/hq/models/checks") return json(res, 200, modelSetup.checks(url.searchParams.get("backend")), { "Cache-Control": "no-store" });
      if (p === "/hq/models/byte-key") return json(res, 200, await modelSetup.byteKey(url.searchParams.get("backend"), url.searchParams.get("provider")), { "Cache-Control": "no-store" });
      if (req.method !== "POST") return send(res, 405, "");
      const body = JSON.parse((await readBody(req, 64 << 10)).toString("utf8") || "{}");
      if (p === "/hq/models/connect") return json(res, 200, await modelSetup.connectKey(body.backend, body.integrationID, body.key));
      if (p === "/hq/models/disconnect") return json(res, 200, await modelSetup.disconnectKey(body.backend, body.credentialID));
      if (p === "/hq/models/probe") return json(res, 200, await modelSetup.probe(body.backend, body.baseURL, body.apiKey));
      if (p === "/hq/models/add") return json(res, 200, await modelSetup.addServer(body.backend, body.spec || {}));
      if (p === "/hq/models/remove") return json(res, 200, await modelSetup.removeServer(body.backend, body.id));
      if (p === "/hq/models/check") return json(res, 200, await modelSetup.check(body.backend, body));
      if (p === "/hq/models/byte-ask-tools") return json(res, 200, await modelSetup.byteAskTools(body.backend, body.providerID));
      if (p === "/hq/models/chat-agent") return json(res, 200, await modelSetup.chatAgent(body.backend));
    } catch (e) {
      stamp(`${p} failed: ${e.message}`);
      return json(res, 400, { message: e.message });
    }
    return send(res, 404, "");
  }
  // Images and videos made with the Byte API: made and kept by HQ, shown in the chat that asked for them.
  if (p === "/hq/media/make" && req.method === "POST") {
    try {
      const body = JSON.parse((await readBody(req, 24 << 20)).toString("utf8") || "{}");
      return json(res, 200, await modelSetup.makeMedia(body.backend, body.providerID, body.kind, body.prompt, body.image, body.sid));
    } catch (e) {
      stamp(`${p} failed: ${e.message}`);
      return json(res, 400, { message: e.message });
    }
  }
  if (p === "/hq/media/list" && req.method === "GET") return json(res, 200, modelSetup.mediaList(), { "Cache-Control": "no-store" });
  if ((p === "/hq/media/share" || p === "/hq/media/forget" || p === "/hq/media/delete") && req.method === "POST") {
    try {
      const body = JSON.parse((await readBody(req, 16 << 10)).toString("utf8") || "{}");
      if (p === "/hq/media/share") return json(res, 200, modelSetup.mediaShare(String(body.backend), body.from, body.to));
      if (p === "/hq/media/forget") return json(res, 200, modelSetup.mediaForget(String(body.backend), String(body.sid)));
      return json(res, 200, modelSetup.mediaDelete(String(body.file)));
    } catch (e) {
      return json(res, 400, { message: e.message });
    }
  }
  if (p.startsWith("/hq/media/") && (req.method === "GET" || req.method === "HEAD")) {
    const f = modelSetup.mediaFile(p.slice("/hq/media/".length));
    if (!f) return send(res, 404, "");
    return sendFileRange(req, res, f.path, f.type);
  }
  if (p === "/hq/machines" && req.method === "GET") return json(res, 200, machines.list(), { "Cache-Control": "no-store" });
  if (p.startsWith("/hq/machines/")) {
    if (req.method !== "POST") return send(res, 405, "");
    try {
      const body = JSON.parse((await readBody(req, 16 << 10)).toString("utf8") || "{}");
      if (p === "/hq/machines/test") return json(res, 200, await machines.test(body));
      if (p === "/hq/machines/save") return json(res, 200, await machines.save(body));
      if (p === "/hq/machines/remove") return json(res, 200, machines.remove(body.id));
    } catch (e) {
      return json(res, 400, { message: e.message });
    }
    return send(res, 404, "");
  }
  if (p === "/hq/search") return json(res, 200, await chatSearch.search(url.searchParams.get("q")));
  if (p === "/hq/vault" && req.method === "GET") return json(res, 200, await readVault(), { "Cache-Control": "no-store" });
  if (p.startsWith("/hq/push/") && notifier) {
    if (p === "/hq/push/key") return json(res, 200, { publicKey: notifier.publicKey, devices: notifier.count() });
    if (req.method !== "POST") return send(res, 405, "");
    try {
      const body = JSON.parse((await readBody(req, 16 << 10)).toString("utf8") || "{}");
      if (p === "/hq/push/subscribe") return notifier.subscribe(body), json(res, 200, { ok: true, devices: notifier.count() });
      if (p === "/hq/push/unsubscribe") return notifier.unsubscribe(body.endpoint), json(res, 200, { ok: true });
      if (p === "/hq/push/test") return await notifier.send("HQ", "Notifications are on", "/", "test"), json(res, 200, { ok: true });
    } catch (e) {
      return json(res, 400, { message: e.message });
    }
    return send(res, 404, "");
  }
  if (p.startsWith("/hq/auto/") && auto) {
    try {
      if (p === "/hq/auto/status") return json(res, 200, await auto.status(url.searchParams.get("backend")));
      const body = JSON.parse((await readBody(req, 32 << 20)).toString("utf8") || "{}");
      if (p === "/hq/auto/send" && req.method === "POST") return json(res, 200, await auto.send(body.backend, body.sessionID, body.text, body.files));
      if (p === "/hq/auto/switch-model" && req.method === "POST") return json(res, 200, await auto.switchModel(body.backend, body.sessionID, body.model));
      if (p === "/hq/auto/review" && req.method === "POST") return json(res, 200, await auto.review(body.backend, body.sessionID, body.turn));
    } catch (e) {
      return json(res, 502, { message: e.message });
    }
    return send(res, 404, "");
  }
  if (p === "/hq/browser/stream" && browser) return browser.stream(req, res, url);
  if (p === "/hq/browser/action" && browser && req.method === "POST") {
    try {
      const out = await browser.action(JSON.parse((await readBody(req)).toString("utf8") || "{}"));
      return json(res, 200, { ok: true, result: out ?? null });
    } catch (e) {
      return json(res, 400, { message: e.message });
    }
  }
  if (p === "/hq/prefs") {
    if (req.method === "GET") return json(res, 200, fs.existsSync(PREFS_PATH) ? JSON.parse(fs.readFileSync(PREFS_PATH, "utf8")) : {});
    if (req.method === "PATCH") {
      const patch = JSON.parse((await readBody(req, 256 << 10)).toString("utf8") || "{}");
      const cur = fs.existsSync(PREFS_PATH) ? JSON.parse(fs.readFileSync(PREFS_PATH, "utf8")) : {};
      const next = { ...cur, ...patch };
      fs.writeFileSync(PREFS_PATH + ".tmp", JSON.stringify(next, null, 2));
      fs.renameSync(PREFS_PATH + ".tmp", PREFS_PATH);
      return json(res, 200, next);
    }
    return send(res, 405, "");
  }
  if (p === "/hq/projects") {
    if (req.method === "GET") {
      return json(res, 200, fs.existsSync(PROJECTS_PATH) ? JSON.parse(fs.readFileSync(PROJECTS_PATH, "utf8")) : []);
    }
    if (req.method === "PUT") {
      const list = JSON.parse((await readBody(req)).toString("utf8"));
      if (!Array.isArray(list)) return json(res, 400, { message: "expected an array" });
      const tmp = PROJECTS_PATH + ".tmp";
      fs.writeFileSync(tmp, JSON.stringify(list, null, 2));
      fs.renameSync(tmp, PROJECTS_PATH); // atomic: a crash can't leave half a file
      return json(res, 200, list);
    }
    return send(res, 405, "");
  }
  if (req.method !== "GET" && req.method !== "HEAD") return send(res, 405, "");
  serveStatic(req, res, p === "/" ? "/index.html" : p);
}

for (const l of config.listen) {
  const server = http.createServer((req, res) => {
    // HQ is never framed by another site (clickjacking), never MIME-sniffed, and leaks no URLs in Referer headers.
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "SAMEORIGIN");
    res.setHeader("Content-Security-Policy", "frame-ancestors 'self'");
    res.setHeader("Referrer-Policy", "same-origin");
    handle(req, res).catch((e) => { if (!res.headersSent) json(res, 500, { message: String(e.message || e) }); });
  });
  server.requestTimeout = 0; // event streams stay open
  server.headersTimeout = 60_000;
  server.on("error", (e) => {
    if (e.code === "EADDRINUSE") console.error(`Port ${l.port} on ${l.host} is already in use (another HQ, or another app). Pick another "port" in ${CONFIG_PATH}.`);
    else if (e.code === "EADDRNOTAVAIL") console.error(`${l.host} isn't an address of this computer. Use 127.0.0.1, or this computer's own address, in "listen".`);
    else if (e.code === "EACCES") console.error(`Not allowed to listen on port ${l.port}: use a port above 1024.`);
    else console.error(`Couldn't listen on ${l.host}:${l.port}: ${e.message}`);
    process.exit(1);
  });
  server.listen(l.port, l.host, () => console.log(`HQ listening on http://${l.host}:${l.port} (config ${CONFIG_PATH})`));
}
