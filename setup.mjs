#!/usr/bin/env node
// HQ setup: asks a few questions and writes your config (default ~/.config/hq-app/config.json, readable only by you).
//
//   npm run setup                 interactive
//   HQ_CONFIG=path npm run setup  write somewhere else
//
// It tests each OpenCode server as you add it and lets you pick Auto's models from the server's real model list.
// An existing config is backed up (config.json.bak-<time>) before it is replaced.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import net from "node:net";
import readline from "node:readline";
import { stdin, stdout } from "node:process";
import { createModels } from "./models.mjs";

const expand = (p) => (p.startsWith("~") ? path.join(os.homedir(), p.slice(1)) : path.resolve(p));
const CONFIG_PATH = expand(process.env.HQ_CONFIG || "~/.config/hq-app/config.json");
// In a terminal, readline shows the prompts and echoes what's typed (except secrets). Piped answers (scripted installs)
// are queued line by line instead.
const tty = !!stdin.isTTY;
const rl = readline.createInterface({ input: stdin, output: tty ? stdout : undefined, terminal: tty });
const lines = [], waiting = [];
let ended = false;
if (!tty) {
  rl.on("line", (l) => (waiting.length ? waiting.shift()(l) : lines.push(l)));
  rl.on("close", () => { ended = true; while (waiting.length) waiting.shift()(null); });
} else {
  rl.on("SIGINT", () => { stdout.write("\nSetup cancelled. Nothing was written.\n"); process.exit(130); });
  rl.on("close", () => { if (!finished) stdout.write("\nSetup cancelled. Nothing was written.\n"), process.exit(130); });
}
let muted = false, finished = false;
if (tty) {
  const write = rl._writeToOutput.bind(rl);
  rl._writeToOutput = (s) => { if (!muted) write(s); };
}
const nextLine = () => (lines.length ? Promise.resolve(lines.shift()) : ended ? Promise.resolve(null) : new Promise((r) => waiting.push(r)));
async function prompt(q, secret = false) {
  if (tty) {
    return new Promise((resolve) => {
      rl.question(q, (a) => {
        if (muted) (muted = false), stdout.write("\n");
        resolve(a);
      });
      muted = secret; // after the prompt is written: hide only what's typed
    });
  }
  stdout.write(q);
  const a = await nextLine();
  if (a === null) throw new Error("no more answers (input ended)");
  stdout.write((secret && a ? "********" : a) + "\n");
  return a;
}
const ask = async (q, def = "") => (await prompt(def ? `${q} [${def}]: ` : `${q}: `)).trim() || def;
/** Like ask, but nothing typed is shown (passwords, API keys). */
const askSecret = async (q) => (await prompt(`${q}: `, true)).trim();
const yes = async (q, def = true) => /^y/i.test(await ask(`${q} (y/n)`, def ? "y" : "n"));
const say = (s = "") => console.log(s);

/** Can HQ listen there? (false if another app has the port, or the address isn't this computer's) */
const portFree = (host, port) =>
  new Promise((resolve) => {
    if (!(port > 0 && port < 65536)) return resolve(false);
    const srv = net.createServer().once("error", () => resolve(false)).once("listening", () => srv.close(() => resolve(true)));
    srv.listen(port, host);
  });
async function freePort(host, from) {
  for (let p = from; p < from + 50; p++) if (await portFree(host, p)) return p;
  return from;
}

async function openCode(url, user, password, p) {
  const auth = password ? { authorization: "Basic " + Buffer.from(`${user}:${password}`).toString("base64") } : {};
  const r = await fetch(url.replace(/\/$/, "") + "/api" + p, { headers: auth, signal: AbortSignal.timeout(8000) });
  if (r.status === 401) throw new Error("wrong username or password");
  if (!r.ok) throw new Error(`answered ${r.status}`);
  return r.json();
}

async function addMachine(n) {
  say(`\nMachine ${n}: an OpenCode server. Start one with: OPENCODE_SERVER_PASSWORD=… opencode serve --port 4096`);
  if (n === 1) say("  (On another computer add --hostname 0.0.0.0, and keep it on a private network such as Tailscale.)");
  for (;;) {
    const label = await ask("  Name to show in HQ", n === 1 ? "This computer" : `Machine ${n}`);
    // install.sh starts the first OpenCode server itself and passes its address and password here, so the user
    // never has to copy the password. Only for machine 1; anything typed wins.
    const pre = n === 1 && process.env.HQ_SETUP_OPENCODE_PASSWORD ? { url: process.env.HQ_SETUP_OPENCODE_URL || "http://127.0.0.1:4096", password: process.env.HQ_SETUP_OPENCODE_PASSWORD } : null;
    const url = await ask("  OpenCode server address", pre?.url || "http://127.0.0.1:4096");
    const user = await ask("  Username (OpenCode's default is opencode)", "opencode");
    const password = (await askSecret(pre ? "  Password (leave empty to use the one the installer set)" : "  Password (OPENCODE_SERVER_PASSWORD; leave empty if none)")) || (pre && url === pre.url ? pre.password : "");
    try {
      const info = (await openCode(url, user, password, "/info")).data ?? (await openCode(url, user, password, "/info"));
      say(`  ✓ Connected: ${info.hostname || "server"} · OpenCode ${info.version || "?"}`);
      const home = await ask("  Folder that plain chats on this machine work in (full path)", os.homedir());
      const id = label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || `m${n}`;
      return { id, label, url, ...(password ? { user, password } : {}), home, chatsDir: home };
    } catch (e) {
      say(`  ✗ Couldn't connect (${e.message}).`);
      if (!(await yes("  Try again?"))) return null;
    }
  }
}

async function pickModel(machine, what, allowNone) {
  let models = [];
  try {
    const q = `/model?location[directory]=${encodeURIComponent(machine.chatsDir)}`;
    const r = await openCode(machine.url, machine.user, machine.password, q);
    models = (r.data || r).filter((m) => m.enabled !== false && (!m.type || m.type === "chat"));
  } catch (e) {
    say(`  Couldn't list models (${e.message}).`);
    return null;
  }
  if (!models.length) return say("  This server has no models yet (add some in HQ: Settings › Models)."), null;
  say(`\n${what}:`);
  if (models.length > 20) {
    const t = (await ask(`  ${models.length} models: type part of a name to narrow them down`)).toLowerCase();
    const hits = models.filter((m) => `${m.name} ${m.id} ${m.providerID}`.toLowerCase().includes(t));
    if (hits.length) models = hits;
  }
  models = models.slice(0, 40);
  models.forEach((m, i) => say(`  ${i + 1}. ${m.name || m.id}  (${m.providerID}/${m.id})`));
  if (allowNone) say("  0. none");
  for (;;) {
    const a = await ask("  Number", allowNone ? "0" : "1");
    const i = Number(a);
    if (allowNone && i === 0) return null;
    if (i >= 1 && i <= models.length) {
      const m = models[i - 1];
      const images = (m.capabilities?.input || ["image"]).includes("image");
      return { providerID: m.providerID, modelID: m.id, label: await ask("  Short name to show for it", m.name || m.id), images };
    }
  }
}

// ---- models ---------------------------------------------------------------------------------------
// The same as HQ's Settings › Models (models.mjs): a hosted API, a model server, or a cloud provider's key.
const BYTE_API = "https://api.bytedev.co.uk/v1";
async function offerModels(machine) {
  const tools = createModels({ backends: new Map([[machine.id, machine]]), configDir: path.dirname(CONFIG_PATH) });
  for (;;) {
    let st;
    try {
      st = await tools.status(machine.id);
    } catch (e) {
      return say(`  Couldn't check ${machine.label}'s models (${e.message}). Add them later in HQ: Settings › Models.`);
    }
    const n = st.providers.length;
    say(`\nModels on ${machine.label}: ${n ? st.providers.map((p) => `${p.name} (${p.models})`).join(", ") : "none yet"}.`);
    say("  1. Byte API: hosted models, no GPU needed (needs a key from api.bytedev.co.uk)");
    say("  2. A model server: Ollama, LM Studio, llama.cpp, vLLM or any OpenAI-compatible address");
    say("  3. A cloud provider with an API key (OpenAI, Anthropic, OpenRouter…)");
    say(`  0. ${n ? "Done" : "Skip (add them later in HQ: Settings › Models)"}`);
    const a = await ask("  Number", "0");
    try {
      if (a === "1") await addServer(tools, machine, { id: "byte-api", name: "Byte API", url: BYTE_API, key: true, keep: /^byte-(chat|coder)/ });
      else if (a === "2") await addServer(tools, machine, {});
      else if (a === "3") await addCloud(tools, machine, st.integrations);
      else return;
    } catch (e) {
      say(`  ✗ ${e.message}`);
    }
  }
}

async function addServer(tools, machine, preset) {
  let url = preset.url;
  if (!url) {
    say("  Usual addresses: Ollama http://localhost:11434/v1 · LM Studio http://localhost:1234/v1 · llama.cpp http://localhost:8080/v1 · vLLM http://localhost:8000/v1");
    say(`  (localhost means ${machine.label}, the machine running OpenCode.)`);
    url = await ask("  Address (ends in /v1)", "http://localhost:11434/v1");
  }
  const key = preset.key ? await askSecret("  API key") : await askSecret("  API key (leave empty if none)");
  if (preset.key && !key) return say("  No key, nothing added.");
  const found = await tools.probe(machine.id, url, key);
  let models = preset.keep ? found.models.filter((m) => preset.keep.test(m.id)) : found.models;
  if (!models.length) models = found.models;
  if (!models.length) return say("  It answered but lists no models: load one on it first.");
  models.forEach((m, i) => say(`  ${i + 1}. ${m.id}${m.context ? `  (context ${m.context})` : ""}`));
  const pick = await ask("  Which ones? (numbers like 1,3 or all)", models.length <= 8 ? "all" : "1");
  const chosen = pick === "all" ? models : pick.split(/[ ,]+/).map((x) => models[Number(x) - 1]).filter(Boolean);
  if (!chosen.length) return say("  None picked.");
  const unknown = chosen.some((m) => !m.context);
  const ctx = unknown ? Number(await ask("  Context size the server runs them with, in tokens (check its settings)", "32768")) : 0;
  const images = await yes("  Can they see images?", false);
  const name = preset.name || (await ask("  Name to show for this server", new URL(url).hostname === "localhost" ? "Local models" : new URL(url).hostname));
  const id = preset.id || name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "models";
  const r = await tools.addServer(machine.id, { id, name, baseURL: url, apiKey: key, models: chosen.map((m) => ({ id: m.id, context: m.context || ctx, images })) });
  if (!r.pasted) {
    say(`  ${machine.label} already has its own ${r.file}, and HQ never edits a config it didn't create. Add this to it:`);
    return say(r.snippet.split("\n").map((l) => "    " + l).join("\n"));
  }
  say(r.models ? `  ✓ Added ${name}: ${chosen.length} model(s).` : `  Added, but ${r.warning}`);
  // Coding needs tool calls; a model without them chats fine but never edits anything, so say so now.
  say(`  Testing ${chosen[0].id} (can it call tools?)…`);
  const c = await tools.check(machine.id, { providerID: id, modelID: chosen[0].id }).catch((e) => ({ ok: false, problem: e.message }));
  if (c.ok) say("  ✓ It can use tools: it can edit files and run commands.");
  else if (c.code === "tools" && c.chat && preset.id === "byte-api") {
    say("  ✗ It chats, but your Byte API key has no tool access yet, so it can't edit files or run commands.");
    say("    Ask for it on api.bytedev.co.uk (send the request form again with the same email). You keep the same key.");
  } else if (c.code === "tools" && c.chat) say("  ✗ It chats, but can't use tools, so it can't edit files. That's a setting of the model server (see README › Troubleshooting).");
  else say(`  ✗ ${c.problem}`);
}

async function addCloud(tools, machine, integrations) {
  const t = (await ask("  Provider name (e.g. openai, anthropic, openrouter)")).toLowerCase();
  const hits = integrations.filter((i) => i.id === t || i.name.toLowerCase().includes(t)).slice(0, 15);
  if (!hits.length) return say("  No provider called that. Any OpenAI-compatible API works through option 2.");
  let pick = hits[0];
  if (hits.length > 1 && hits[0].id !== t) {
    hits.forEach((h, i) => say(`  ${i + 1}. ${h.name}`));
    pick = hits[Number(await ask("  Number", "1")) - 1];
    if (!pick) return;
  }
  const key = await askSecret(`  ${pick.name} API key`);
  if (!key) return say("  No key, nothing added.");
  const r = await tools.connectKey(machine.id, pick.id, key);
  say(r.models ? `  ✓ Connected ${pick.name}: ${r.models} models.` : `  Connected, but ${r.warning}`);
}

async function main() {
  say("HQ setup\n");
  if (fs.existsSync(CONFIG_PATH)) {
    say(`A config already exists at ${CONFIG_PATH}.`);
    if (!(await yes("Replace it? (it's backed up first)", false))) return say("Nothing changed.");
  }
  const cfg = { name: await ask("App name", "HQ") };

  say("\nWhere HQ listens. 127.0.0.1 = this computer only (use Tailscale Serve or a reverse proxy for other devices).");
  const host = await ask("  Host", "127.0.0.1");
  let port = Number(await ask("  Port", String(await freePort(host, 4110))));
  while (!(await portFree(host, port))) port = Number(await ask(`  Port ${port} is in use here. Another port`, String(await freePort(host, port + 1))));
  cfg.listen = [{ host, port }];

  say("\nYour HQ login (the sign-in page; needed whenever HQ is reachable from other devices).");
  const user = await ask("  Username", os.userInfo().username);
  let password = await askSecret("  Password, at least 8 characters (leave empty to generate one)");
  while (password && password.length < 8) password = await askSecret("  That's too short. At least 8 characters (or empty to generate one)");
  if (!password) password = crypto.randomBytes(12).toString("base64url"), say(`  Generated password: ${password}  (save it somewhere safe)`);
  cfg.auth = { user, password };

  cfg.backends = [];
  for (let n = 1; ; n++) {
    const m = await addMachine(n);
    if (m) {
      if (cfg.backends.some((b) => b.id === m.id)) m.id += `-${n}`;
      cfg.backends.push(m);
    }
    if (!(await yes("\nAdd another machine?", false))) break;
  }
  if (!cfg.backends.length) return say("\nNo machines added, so no config was written.");

  for (const m of cfg.backends) await offerModels(m);

  if (await yes("\nSet up Auto (HQ picks the model, reviews and fixes its own changes)?")) {
    const m0 = cfg.backends[0];
    const primary = await pickModel(m0, "Main model (does the work when it's available)", false);
    const fallback = await pickModel(m0, "Fallback model (used when the main one is busy or down)", true);
    if (primary) {
      if (primary.images) delete primary.images; // only "false" matters for the primary (CONFIG.md)
      cfg.auto = { primary, ...(fallback ? { fallback } : {}) };
      say("  Optional extras (busy check, start command, vision model) are explained in CONFIG.md.");
    }
  } else cfg.auto = false;

  say("\nPhone notifications need a real contact address for the push services (Apple rejects made-up ones).");
  const contact = await ask("  Your email for that (leave empty to turn notifications off)");
  cfg.push = contact ? { contact: contact.includes(":") ? contact : `mailto:${contact}` } : false;

  say("\nVoice, Save to guide, Links & logins, commit credit and health checks are optional: see CONFIG.md.");

  fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
  if (fs.existsSync(CONFIG_PATH)) {
    const bak = `${CONFIG_PATH}.bak-${new Date().toISOString().replace(/[:.]/g, "-")}`;
    fs.copyFileSync(CONFIG_PATH, bak);
    fs.chmodSync(bak, 0o600);
    say(`\nOld config backed up to ${bak}`);
  }
  fs.writeFileSync(CONFIG_PATH + ".tmp", JSON.stringify(cfg, null, 2) + "\n", { mode: 0o600 });
  fs.renameSync(CONFIG_PATH + ".tmp", CONFIG_PATH);
  say(`\n✓ Wrote ${CONFIG_PATH} (readable only by you).`);
  say("Next: npm run build, then npm start, and open " + `http://${cfg.listen[0].host}:${cfg.listen[0].port}`);
}

main().catch((e) => say(`\nSetup stopped: ${e.message}`)).finally(() => ((finished = true), rl.close()));
