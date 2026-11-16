// Models: add model providers to an OpenCode server from HQ (Settings › Models, and `npm run setup`).
//
// Two ways, both on the OpenCode server itself (it is the one that calls the models):
//  1. A provider OpenCode already knows (OpenAI, Anthropic, OpenRouter… ~300 of them): just a key, through
//     OpenCode's own API (POST /api/integration/<id>/connect/key). Removing it deletes that credential.
//  2. Any OpenAI-compatible server (a hosted API such as the Byte API, or Ollama, LM Studio, llama.cpp, vLLM):
//     a `providers` block. OpenCode has no API for that, so HQ writes it to `opencode.json` in the server's global
//     config folder (OpenCode merges that file with your own `opencode.jsonc` and reloads it within seconds).
//     HQ only ever writes that file if HQ created it: it keeps a record of what it wrote in
//     <HQ config folder>/models/<machine>.json. If you already have your own `opencode.json` there, HQ leaves it
//     alone and gives you the block to paste instead.
//
// Every model HQ writes says how big its context is and whether it can see images, because OpenCode's defaults
// (200K, images on) are wrong for most local models: a too-big context means long chats are never compacted.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const OC_SCHEMA = "https://opencode.ai/config.json";
const ID_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;

export function createModels({ backends, configDir, log = () => {} }) {
  const recordDir = path.join(configDir, "models");

  function backend(id) {
    const b = backends.get(id);
    if (!b) throw new Error(`unknown machine ${id}`);
    return b;
  }
  const loc = (b) => `location[directory]=${encodeURIComponent(b.chatsDir || b.home || "/")}`;
  async function oc(b, method, p, body, type = "application/json") {
    const headers = {};
    if (b.user || b.password) headers.authorization = "Basic " + Buffer.from(`${b.user || "opencode"}:${b.password || ""}`).toString("base64");
    if (body !== undefined) headers["content-type"] = type;
    const url = `${b.url.replace(/\/$/, "")}/api${p}${p.includes("?") ? "&" : "?"}${loc(b)}`;
    const r = await fetch(url, { method, headers, body: body === undefined ? undefined : type === "application/json" ? JSON.stringify(body) : body, signal: AbortSignal.timeout(15_000) });
    const text = await r.text();
    if (!r.ok) {
      let msg = text;
      try { msg = JSON.parse(text).message || text; } catch {}
      throw new Error(`${b.label || b.id} answered ${r.status}: ${String(msg).slice(0, 200)}`);
    }
    return text ? JSON.parse(text) : null;
  }

  // ---- what HQ wrote ------------------------------------------------------------------------------
  const recordPath = (id) => path.join(recordDir, `${id.replace(/[^a-zA-Z0-9_-]/g, "_")}.json`);
  const readRecord = (id) => {
    try { return JSON.parse(fs.readFileSync(recordPath(id), "utf8")); } catch { return null; }
  };
  function writeRecord(id, rec) {
    fs.mkdirSync(recordDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(recordPath(id) + ".tmp", JSON.stringify(rec, null, 2), { mode: 0o600 });
    fs.renameSync(recordPath(id) + ".tmp", recordPath(id));
  }

  /** Where HQ's file goes on that server, and whether HQ may write it. */
  async function target(b) {
    const docs = await oc(b, "GET", "/config");
    const dir = (docs || []).find((d) => d.type === "directory")?.path;
    if (!dir) throw new Error("couldn't find that server's config folder");
    const sep = /^[A-Za-z]:\\/.test(dir) || (dir.includes("\\") && !dir.includes("/")) ? "\\" : "/";
    const file = dir.replace(/[\\/]+$/, "") + sep + "opencode.json";
    const rec = readRecord(b.id);
    const exists = (docs || []).some((d) => d.type === "document" && d.path === file);
    const state = !exists ? "absent" : rec?.path === file ? "ours" : "theirs";
    return { file, state, rec: rec?.path === file ? rec : { path: file, providers: {} } };
  }

  // ---- status ---------------------------------------------------------------------------------------
  async function status(id) {
    const b = backend(id);
    const [providers, models, integrations, where] = await Promise.all([
      oc(b, "GET", "/provider").then((r) => r.data || r),
      oc(b, "GET", "/model").then((r) => r.data || r),
      oc(b, "GET", "/integration").then((r) => r.data || r).catch(() => []),
      target(b).catch((e) => ({ error: e.message })),
    ]);
    const count = {};
    for (const m of models) if (m.enabled !== false) count[m.providerID] = (count[m.providerID] || 0) + 1;
    const ours = where.rec?.providers || {};
    const connected = new Map();
    for (const i of integrations) for (const c of i.connections || []) if (c.type === "credential") connected.set(i.id, c.id);
    return {
      file: where.file || null,
      fileState: where.state || null,
      fileError: where.error || null,
      providers: providers.map((p) => ({
        id: p.id,
        name: p.name || p.id,
        models: count[p.id] || 0,
        baseURL: p.settings?.baseURL || "",
        // "hq": written by HQ (removable here); "key": a key added through OpenCode (removable here); "config": your own config.
        source: ours[p.id] ? "hq" : connected.has(p.id) ? "key" : "config",
        credentialID: connected.get(p.id) || null,
      })),
      integrations: integrations
        .filter((i) => (i.methods || []).some((m) => m.type === "key"))
        .map((i) => ({ id: i.id, name: i.name || i.id, connected: connected.has(i.id) })),
    };
  }

  // ---- 1. a known provider with a key -------------------------------------------------------------
  async function connectKey(id, integrationID, key) {
    const b = backend(id);
    if (!/^[a-z0-9._-]{1,80}$/i.test(String(integrationID || ""))) throw new Error("pick a provider");
    if (!String(key || "").trim()) throw new Error("paste the API key");
    await oc(b, "POST", `/integration/${encodeURIComponent(integrationID)}/connect/key`, { key: String(key).trim() });
    log(`models: connected ${integrationID} on ${b.id}`);
    return waitForProvider(b, integrationID);
  }
  async function disconnectKey(id, credentialID) {
    const b = backend(id);
    if (!/^cred_[A-Za-z0-9]+$/.test(String(credentialID || ""))) throw new Error("bad credential id");
    const owner = (await oc(b, "GET", "/integration").then((r) => r.data || r).catch(() => []))
      .find((i) => (i.connections || []).some((c) => c.id === credentialID))?.id;
    await oc(b, "DELETE", `/credential/${credentialID}`);
    log(`models: removed credential on ${b.id}`);
    if (owner) await waitForProviderGone(b, owner);
    return { ok: true };
  }

  // ---- 2. an OpenAI-compatible server -------------------------------------------------------------
  /**
   * Ask an OpenAI-compatible server which models it has (and their context size where it says).
   * HQ makes this request itself. "localhost" in the address means the OpenCode machine, so when that machine is
   * another computer, the same port on that computer's address is tried too.
   */
  /** The addresses HQ tries for a server OpenCode reaches at `base` (localhost = the OpenCode machine). */
  function addresses(b, base) {
    const tries = [base];
    const u = new URL(base);
    const ocHost = new URL(b.url).hostname;
    if (/^(localhost|127\.0\.0\.1|\[::1\])$/.test(u.hostname) && !/^(localhost|127\.0\.0\.1|\[::1\])$/.test(ocHost)) {
      const alt = new URL(base);
      alt.hostname = ocHost;
      tries.push(alt.toString().replace(/\/$/, ""));
    }
    return tries;
  }

  async function probe(id, baseURL, apiKey) {
    const b = backend(id);
    const base = cleanURL(baseURL);
    const tries = addresses(b, base);
    const headers = apiKey ? { authorization: `Bearer ${apiKey}` } : {};
    let last = "";
    for (const t of tries) {
      try {
        const r = await fetch(`${t}/models`, { headers, signal: AbortSignal.timeout(8000) });
        if (r.status === 401 || r.status === 403) throw new Error("the key was refused");
        if (!r.ok) throw new Error(`answered ${r.status}`);
        const list = (await r.json()).data || [];
        const models = list
          .filter((m) => m && typeof m.id === "string")
          .map((m) => ({ id: m.id, context: Number(m.context_length || m.max_context_length || m.max_model_len || m.meta?.n_ctx_train || 0) || 0 }));
        // llama.cpp's server reports the context it was actually started with at /props.
        if (models.length === 1 && !models[0].context) {
          const props = await fetch(t.replace(/\/v1$/, "") + "/props", { headers, signal: AbortSignal.timeout(4000) }).then((x) => (x.ok ? x.json() : null)).catch(() => null);
          const n = Number(props?.default_generation_settings?.n_ctx || props?.n_ctx || 0);
          if (n) models[0].context = n;
        }
        return { models, reachedAt: t, viaMachine: t !== base };
      } catch (e) {
        last = e.message;
        if (last === "the key was refused") break;
      }
    }
    throw new Error(`couldn't list models at ${base} (${last})`);
  }

  /** The `providers` block for one server, exactly as it goes into OpenCode's config. */
  function block(spec) {
    const id = String(spec.id || "").toLowerCase();
    if (!ID_RE.test(id)) throw new Error("the short name may use only a-z, 0-9 and -, starting with a letter or digit");
    const models = (spec.models || []).filter((m) => m && String(m.id || "").trim());
    if (!models.length) throw new Error("pick at least one model");
    return [id, {
      name: String(spec.name || id).slice(0, 80),
      package: "aisdk:@ai-sdk/openai-compatible",
      settings: { baseURL: cleanURL(spec.baseURL), apiKey: String(spec.apiKey || "").trim() || "none" },
      models: Object.fromEntries(models.map((m) => [String(m.id).trim(), {
        name: String(m.name || m.id).slice(0, 120),
        capabilities: { tools: m.tools !== false, input: m.images ? ["text", "image"] : ["text"] },
        limit: { context: clampInt(m.context, 2048, 10_000_000, 32768), output: clampInt(m.output, 256, 1_000_000, 8192) },
      }])),
    }];
  }

  // Every file HQ writes also holds the Chat agent: plain chats use it, so they get a short system prompt and no tools
  // instead of the coding agent's (about 6K tokens less per message, and models without tool calls work).
  const fileText = (providers) => JSON.stringify({ $schema: OC_SCHEMA, providers, agents: { [CHAT_AGENT_ID]: CHAT_AGENT } }, null, 2) + "\n";

  /** Make sure the Chat agent exists on this machine. Never touches a settings file HQ didn't create. */
  async function chatAgent(id) {
    const b = backend(id);
    const has = async () => {
      const list = await oc(b, "GET", "/agent").then((r) => r.data || r).catch(() => []);
      return Array.isArray(list) && list.some((a) => a.id === CHAT_AGENT_ID);
    };
    if (await has()) return { ok: true };
    const t = await target(b);
    if (t.state === "theirs") return { ok: false, reason: `${b.label || b.id}'s OpenCode settings file wasn't made by HQ, so HQ won't add the Chat setup to it` };
    await writeFile(b, t.file, t.rec.providers || {});
    log(`models: added the Chat agent on ${b.id}`);
    for (let i = 0; i < 12; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      if (await has()) return { ok: true };
    }
    return { ok: false, reason: "OpenCode hasn't loaded the Chat setup yet: try again in a minute, or restart that OpenCode server" };
  }

  async function addServer(id, spec) {
    const b = backend(id);
    const [pid, entry] = block(spec);
    const t = await target(b);
    const st = await status(id);
    const existing = st.providers.find((p) => p.id === pid);
    if (existing && existing.source !== "hq") throw new Error(`"${pid}" is already a provider on ${b.label || b.id}: pick another short name`);
    // A built-in provider's name would merge with OpenCode's own catalogue for it.
    if (!existing && st.integrations.some((i) => i.id === pid)) throw new Error(`"${pid}" is the name of one of OpenCode's built-in providers: pick another short name`);
    if (t.state === "theirs") {
      // Never edit a file HQ didn't create: hand over the block instead.
      return { pasted: false, file: t.file, snippet: JSON.stringify({ providers: { [pid]: entry } }, null, 2) };
    }
    const providers = { ...t.rec.providers, [pid]: entry };
    await writeFile(b, t.file, providers);
    forgetChecks(b.id, pid); // a new address or key: earlier results no longer say anything
    log(`models: wrote ${pid} (${Object.keys(entry.models).length} models) to ${b.id}`);
    return { pasted: true, file: t.file, ...(await waitForProvider(b, pid)) };
  }

  async function removeServer(id, pid) {
    const b = backend(id);
    const t = await target(b);
    if (t.state !== "ours" || !t.rec.providers[pid]) throw new Error(`HQ didn't add "${pid}", so it won't remove it: edit that server's OpenCode config`);
    const providers = { ...t.rec.providers };
    delete providers[pid];
    await writeFile(b, t.file, providers);
    forgetChecks(b.id, pid);
    log(`models: removed ${pid} from ${b.id}`);
    await waitForProviderGone(b, pid);
    return { ok: true };
  }

  async function writeFile(b, file, providers) {
    // Through OpenCode itself, so it works for a server on another computer too.
    await oc(b, "POST", `/experimental/fs/write?path=${encodeURIComponent(file)}`, fileText(providers), "application/octet-stream");
    writeRecord(b.id, { path: file, providers });
  }

  /** OpenCode reloads its config by itself; wait (up to ~12 s) until the provider's models show up. */
  async function waitForProvider(b, pid) {
    for (let i = 0; i < 12; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      const models = await oc(b, "GET", "/model").then((r) => r.data || r).catch(() => []);
      const mine = models.filter((m) => m.providerID === pid);
      if (mine.length) return { models: mine.length };
    }
    return { models: 0, warning: "OpenCode hasn't shown the models yet. If they don't appear in a minute, restart that OpenCode server." };
  }

  async function waitForProviderGone(b, pid) {
    for (let i = 0; i < 12; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      const models = await oc(b, "GET", "/model").then((r) => r.data || r).catch(() => null);
      if (models && !models.some((m) => m.providerID === pid)) return;
    }
  }

  // ---- "Try it": can this model chat, and can it call tools? ----------------------------------------
  // Coding needs tool calls (reading, editing, running commands). A model or server without them still chats, so
  // the problem only shows as "it never edits anything". HQ asks the model once to call a harmless test tool.
  // Only for servers HQ knows the address and key of (added in HQ, or typed into the form): cloud providers'
  // keys stay inside OpenCode, and their models all support tools.
  const checksPath = path.join(recordDir, "checks.json");
  const readChecks = () => {
    try { return JSON.parse(fs.readFileSync(checksPath, "utf8")); } catch { return {}; }
  };
  const running = new Map();
  function saveChecks(all) {
    fs.mkdirSync(recordDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(checksPath + ".tmp", JSON.stringify(all, null, 2), { mode: 0o600 });
    fs.renameSync(checksPath + ".tmp", checksPath);
  }
  function forgetChecks(bid, pid) {
    const all = readChecks();
    const left = Object.fromEntries(Object.entries(all).filter(([k]) => !k.startsWith(`${bid}/${pid}/`)));
    if (Object.keys(left).length !== Object.keys(all).length) saveChecks(left);
  }

  /**
   * spec: { providerID, modelID } for a server HQ added, or { baseURL, apiKey, modelID } from the add form.
   * Result: { ok, chat, tools, ms, problem? } where problem is a short reason in plain words.
   */
  async function check(id, spec) {
    const b = backend(id);
    let base = spec.baseURL, key = spec.apiKey, providerID = spec.providerID || "";
    if (!base) {
      const prov = readRecord(b.id)?.providers?.[providerID];
      if (!prov) throw new Error("HQ can only test servers it added (their address and key are on file)");
      base = prov.settings.baseURL;
      key = prov.settings.apiKey === "none" ? "" : prov.settings.apiKey;
    }
    const model = String(spec.modelID || "").trim();
    if (!model) throw new Error("pick a model");
    const k = `${b.id}/${providerID || base}/${model}`;
    if (running.has(k)) return running.get(k);
    const job = runCheck(b, cleanURL(base), key, model).then((r) => {
      if (providerID) {
        const all = readChecks();
        all[`${b.id}/${providerID}/${model}`] = { ...r, at: Date.now() };
        saveChecks(all);
      }
      log(`models: tried ${model} on ${b.id}: ${r.ok ? "ok" : r.problem}`);
      return r;
    }).finally(() => running.delete(k));
    running.set(k, job);
    return job;
  }

  async function runCheck(b, base, key, model) {
    const headers = { "content-type": "application/json", ...(key ? { authorization: `Bearer ${key}` } : {}) };
    const body = {
      model, stream: false, max_tokens: 1500, temperature: 0,
      messages: [{ role: "user", content: 'Connection test. Call the hq_check tool with word set to "ok". Don\'t answer in text.' }],
      tools: [{ type: "function", function: { name: "hq_check", description: "Confirms the connection works.", parameters: { type: "object", properties: { word: { type: "string" } }, required: ["word"] } } }],
      tool_choice: "auto",
    };
    // The Byte API runs its own web search for some questions; this test is about the model's own tool calls.
    if (isByte(base)) body.server_tools = false;
    const t0 = Date.now();
    // The Byte API says what a key may do, so a key without tool access (or credit) is known at once, with no tokens spent.
    if (isByte(base) && key) {
      const info = await byteGet(base, key);
      const ms = Date.now() - t0;
      if (info?.status === 401 || info?.status === 403) return { ok: false, chat: false, tools: false, ms, code: "key", problem: `the key was refused (${info.said})` };
      const d = info?.data;
      if (d?.metered && Number(d.balance_pennies) <= 0) return { ok: false, chat: false, tools: false, ms, code: "credit", problem: "your Byte API balance is empty" };
      if (d && d.tools === false) return { ok: false, chat: true, tools: false, ms, code: "tools", problem: "your key has no tool access yet" };
    }
    let last = "";
    for (const t of addresses(b, base)) {
      let r;
      try {
        r = await fetch(`${t}/chat/completions`, { method: "POST", headers, body: JSON.stringify(body), signal: AbortSignal.timeout(150_000) });
      } catch (e) {
        last = e.name === "TimeoutError" ? "no answer in 2.5 minutes" : "couldn't reach it";
        continue;
      }
      const text = await r.text();
      let d = null;
      try { d = JSON.parse(text); } catch {}
      const said = String(d?.error?.message || d?.detail || d?.message || text).slice(0, 300);
      const ms = Date.now() - t0;
      if (r.status === 401 || r.status === 403) return { ok: false, chat: false, tools: false, ms, code: "key", problem: `the key was refused (${said})` };
      if (r.status === 402) return { ok: false, chat: false, tools: false, ms, code: "credit", problem: said || "out of credit" };
      if (r.status === 429) return { ok: false, chat: false, tools: false, ms, code: "limit", problem: said || "rate limit reached" };
      if (r.status === 404) return { ok: false, chat: false, tools: false, ms, code: "model", problem: `the server doesn't know a model called ${model} (${said})` };
      if (!r.ok) {
        // Some servers refuse the request outright when tools aren't supported (llama.cpp without --jinja does).
        const toolsRefused = /tool/i.test(said);
        return { ok: false, chat: false, tools: false, ms, code: toolsRefused ? "tools" : "error", problem: toolsRefused ? `the server refused tool calls (${said})` : `it answered ${r.status} (${said})` };
      }
      const msg = d?.choices?.[0]?.message || {};
      const tools = Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0;
      // A model that writes the call as text ("<tool_call>…") has tools in its training but not in the server's chat template.
      const asText = !tools && /tool_call|hq_check/.test(String(msg.content || ""));
      const chat = tools || !!String(msg.content || msg.reasoning_content || msg.reasoning || "").trim();
      if (tools) return { ok: true, chat: true, tools: true, ms };
      if (!chat) return { ok: false, chat: false, tools: false, ms, code: "empty", problem: "it answered with nothing (it may have run out of room thinking: try again)" };
      return { ok: false, chat: true, tools: false, ms, code: "tools", problem: asText ? "it wrote the tool call as text instead of making one: the server's chat template doesn't handle tools" : "it answered in text but never called the tool" };
    }
    return { ok: false, chat: false, tools: false, ms: Date.now() - t0, code: "reach", problem: last || "couldn't reach it" };
  }

  /** Saved results of earlier tries, keyed "<machine>/<provider>/<model>", for servers HQ added. */
  function checks(id) {
    const all = readChecks();
    const ours = readRecord(id)?.providers || {};
    return {
      results: Object.fromEntries(Object.entries(all).filter(([k]) => k.startsWith(id + "/") && ours[k.split("/")[1]])),
      hq: Object.keys(ours),
      byte: Object.keys(ours).filter((p) => isByte(ours[p].settings?.baseURL)),
    };
  }

  /** A Byte API provider HQ added: its address and key. */
  function byteProvider(id, providerID) {
    const prov = readRecord(backend(id).id)?.providers?.[providerID];
    if (!prov || !isByte(prov.settings?.baseURL)) throw new Error("that isn't a Byte API provider HQ added");
    return { base: cleanURL(prov.settings.baseURL), key: prov.settings.apiKey === "none" ? "" : prov.settings.apiKey };
  }

  /** What the key may do and how much of its limits is used (read-only; the gateway's GET /v1/balance). */
  async function byteKey(id, providerID) {
    const { base, key } = byteProvider(id, providerID);
    const r = await byteGet(base, key);
    if (!r) throw new Error("couldn't reach the Byte API");
    if (r.status !== 200) throw new Error(r.status === 401 ? "the Byte API doesn't recognise this key" : r.status === 403 ? "this key has been revoked" : `the Byte API answered ${r.status}`);
    const d = r.data || {};
    const L = d.limits || {};
    return {
      name: String(d.name || ""), metered: !!d.metered, balance: String(d.balance_display || ""),
      tools: d.tools === undefined ? null : !!d.tools, toolsRequested: !!d.tools_requested,
      scopes: Array.isArray(d.scopes) ? d.scopes.map(String) : [],
      tokensUsed: L.tokens_used ?? null, tokenBudget: L.token_budget ?? null, tokenWindow: L.token_window ?? null, tokensRenew: L.tokens_renew ?? null,
      requestsToday: L.requests_today ?? null, dailyRequests: L.daily_requests ?? null,
    };
  }

  /** Ask the Byte API's owner to turn tool access on for this key. Granting is theirs to do. */
  async function byteAskTools(id, providerID) {
    const { base, key } = byteProvider(id, providerID);
    let r;
    try {
      r = await fetch(`${base}/request-tools`, {
        method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
        body: JSON.stringify({ note: "Asked from HQ." }), signal: AbortSignal.timeout(15_000),
      });
    } catch {
      throw new Error("couldn't reach the Byte API");
    }
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(String(d.detail || d.error || `the Byte API answered ${r.status}`));
    log(`models: asked for tool access on ${providerID} (${d.status})`);
    return { status: d.status === "on" ? "on" : "pending" };
  }

  // ---- images and videos (Byte API keys with the image or video permission) ------------------------------
  // HQ keeps its own copy of each file, so a chat doesn't depend on the API's link lasting.
  const mediaDir = path.join(configDir, "media");
  const MEDIA_TYPES = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif", "video/mp4": "mp4", "video/webm": "webm" };
  const MAX_MEDIA = 200 << 20;

  // Which chats each file belongs to (index.json beside the files), so deleting a chat can delete its files: a file is
  // only removed once no chat uses it any more (a branch of a chat shares its pictures). Also feeds the gallery.
  const indexPath = path.join(mediaDir, "index.json");
  const readIndex = () => {
    try { return JSON.parse(fs.readFileSync(indexPath, "utf8")); } catch { return {}; }
  };
  function writeIndex(ix) {
    fs.mkdirSync(mediaDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(indexPath + ".tmp", JSON.stringify(ix), { mode: 0o600 });
    fs.renameSync(indexPath + ".tmp", indexPath);
  }
  const sameOwner = (a, b) => a.backend === b.backend && a.sid === b.sid;
  const SID_RE = /^[\w-]{1,100}$/;

  async function makeMedia(id, providerID, kind, prompt, image, sid) {
    if (kind !== "image" && kind !== "video") throw new Error("kind must be image or video");
    const text = String(prompt || "").trim().slice(0, 2000);
    if (!text) throw new Error(`describe the ${kind} to make`);
    if (image != null && (typeof image !== "string" || !/^data:image\/[\w.+-]+;base64,/.test(image))) throw new Error("the picture to start from must be an image");
    const { base, key } = byteProvider(id, providerID);
    const t0 = Date.now();
    let r;
    try {
      r = await fetch(`${base}/${kind}s/generations`, {
        method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
        body: JSON.stringify({ prompt: text, ...(image ? { image } : {}) }),
        signal: AbortSignal.timeout(kind === "video" ? 1_560_000 : 660_000),
      });
    } catch (e) {
      throw new Error(e.name === "TimeoutError" ? `the Byte API took too long to make the ${kind}` : "couldn't reach the Byte API");
    }
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(String(d.detail || d.error?.message || d.error || `the Byte API answered ${r.status}`));
    const item = d.data?.[0] || {};
    let buf, type = "";
    if (item.b64_json) {
      buf = Buffer.from(String(item.b64_json), "base64");
    } else if (item.url && mediaHost(item.url, base)) {
      let f;
      try {
        f = await fetch(item.url, { signal: AbortSignal.timeout(180_000) });
      } catch {
        throw new Error(`couldn't download the ${kind}`);
      }
      if (!f.ok) throw new Error(`couldn't download the ${kind} (${f.status})`);
      if (Number(f.headers.get("content-length")) > MAX_MEDIA) throw new Error(`the ${kind} is too big`);
      type = (f.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
      buf = Buffer.from(await f.arrayBuffer());
    } else {
      throw new Error(`the Byte API sent no ${kind}`);
    }
    if (buf.length > MAX_MEDIA) throw new Error(`the ${kind} is too big`);
    const fromName = String(item.filename || "").split(".").pop()?.toLowerCase();
    const ext = MEDIA_TYPES[type] || (Object.values(MEDIA_TYPES).includes(fromName) ? fromName : kind === "video" ? "mp4" : "png");
    const file = `${crypto.randomUUID()}.${ext}`;
    fs.mkdirSync(mediaDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(mediaDir, file), buf, { mode: 0o600 });
    const ix = readIndex();
    ix[file] = { kind, prompt: text, providerID, at: Date.now(), size: buf.length, owners: sid && SID_RE.test(sid) ? [{ backend: id, sid }] : [] };
    writeIndex(ix);
    log(`media: made a ${kind} with ${providerID} on ${id} (${Math.round(buf.length / 1024)} KB, ${Math.round((Date.now() - t0) / 1000)} s)`);
    return { kind, file, prompt: text, providerID, ms: Date.now() - t0 };
  }

  /** A saved image or video: { path, type }, or null for a name that isn't one HQ made. */
  function mediaFile(name) {
    const m = /^[0-9a-f-]{36}\.(\w+)$/.exec(String(name || ""));
    const type = m && Object.keys(MEDIA_TYPES).find((t) => MEDIA_TYPES[t] === m[1]);
    if (!type) return null;
    const p = path.join(mediaDir, name);
    return fs.existsSync(p) ? { path: p, type } : null;
  }

  /** Every saved image and video, newest first, with the chats it belongs to; files HQ has no record of are listed too. */
  function mediaList() {
    const ix = readIndex();
    let names = [];
    try { names = fs.readdirSync(mediaDir).filter((n) => mediaFile(n)); } catch {}
    const items = names.map((file) => {
      const st = fs.statSync(path.join(mediaDir, file));
      const r = ix[file] || {};
      const ext = file.split(".").pop();
      return {
        file, kind: r.kind || (ext === "mp4" || ext === "webm" ? "video" : "image"), prompt: r.prompt || "",
        at: r.at || st.mtimeMs, size: st.size, owners: r.owners || [],
      };
    });
    items.sort((a, b) => b.at - a.at);
    return { items, bytes: items.reduce((n, x) => n + x.size, 0) };
  }
  /** A chat was branched: its files now belong to the branch as well. */
  function mediaShare(backend, from, to) {
    if (!SID_RE.test(String(from)) || !SID_RE.test(String(to))) throw new Error("bad chat id");
    const ix = readIndex();
    let n = 0;
    for (const r of Object.values(ix)) {
      if (r.owners?.some((o) => sameOwner(o, { backend, sid: from })) && !r.owners.some((o) => sameOwner(o, { backend, sid: to }))) {
        r.owners.push({ backend, sid: to });
        n++;
      }
    }
    if (n) writeIndex(ix);
    return { shared: n };
  }
  /** A chat was deleted: forget it, and delete the files no other chat uses. Files with no record are never touched here. */
  function mediaForget(backend, sid) {
    const ix = readIndex();
    let deleted = 0, freed = 0;
    for (const [file, r] of Object.entries(ix)) {
      if (!r.owners?.some((o) => sameOwner(o, { backend, sid }))) continue;
      r.owners = r.owners.filter((o) => !sameOwner(o, { backend, sid }));
      if (r.owners.length) continue;
      const f = mediaFile(file);
      if (f) {
        freed += fs.statSync(f.path).size;
        fs.rmSync(f.path, { force: true });
        deleted++;
      }
      delete ix[file];
    }
    writeIndex(ix);
    if (deleted) log(`media: deleted ${deleted} file(s) of a deleted chat (${Math.round(freed / 1024)} KB)`);
    return { deleted, freed };
  }
  /** Delete one file from the gallery (the chats that showed it then say it was deleted). */
  function mediaDelete(file) {
    const f = mediaFile(file);
    if (!f) throw new Error("no such file");
    fs.rmSync(f.path, { force: true });
    const ix = readIndex();
    delete ix[file];
    writeIndex(ix);
    return { deleted: 1 };
  }

  return { status, connectKey, disconnectKey, probe, addServer, removeServer, block, fileText, check, checks, byteKey, byteAskTools, chatAgent, makeMedia, mediaFile, mediaList, mediaShare, mediaForget, mediaDelete };
}

const CHAT_AGENT_ID = "hq-chat";
const CHAT_AGENT = {
  description: "Plain chat from HQ: no tools and no files.",
  mode: "primary",
  system:
    "You are a helpful assistant in a chat app. Answer clearly and directly, in the language the user writes in. " +
    "Use Markdown when it helps (lists, tables, code blocks). If you don't know something, say so instead of guessing. " +
    "Messages like \"[Image made from: …]\" mean the app made that picture for the user; you can talk about it, but you can't see it.",
  permissions: [{ action: "*", resource: "*", effect: "deny" }],
};

/** Only download a made file from the Byte API's own domain (its files are served from a sister host). */
function mediaHost(u, base) {
  try {
    const host = new URL(u).hostname;
    const api = new URL(base).hostname;
    const domain = api.split(".").slice(1).join(".");
    return new URL(u).protocol === "https:" && (host === api || host.endsWith("." + domain));
  } catch {
    return false;
  }
}

const isByte = (u) => {
  try { return new URL(u).hostname === "api.bytedev.co.uk"; } catch { return false; }
};

/** GET <base>/balance on the Byte API: { status, data, said }, or null when it can't be reached. */
async function byteGet(base, key) {
  try {
    const r = await fetch(`${base}/balance`, { headers: { authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(10_000) });
    const text = await r.text();
    let data = null;
    try { data = JSON.parse(text); } catch {}
    return { status: r.status, data: r.ok ? data : null, said: String(data?.detail || data?.error || text).slice(0, 200) };
  } catch {
    return null;
  }
}

function cleanURL(u) {
  let s = String(u || "").trim().replace(/\/+$/, "");
  if (!/^https?:\/\//i.test(s)) throw new Error("the address must start with http:// or https://");
  s = s.replace(/\/chat\/completions$/, "").replace(/\/models$/, "");
  new URL(s); // throws on nonsense
  return s;
}
const clampInt = (v, lo, hi, def) => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) && n > 0 ? Math.min(hi, Math.max(lo, n)) : def;
};
