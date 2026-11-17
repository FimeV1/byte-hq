#!/usr/bin/env node
// HQ self-test: checks that every OpenCode feature HQ relies on still works on each machine.
// Run it after updating OpenCode (or when HQ misbehaves) and it says exactly what changed.
//
//   node selftest.mjs              every machine in ~/.config/hq-app/config.json (no model is called)
//   node selftest.mjs <machine-id> one machine
//   node selftest.mjs --full       also run real turns against the dev stack (dev/run_dev_backend.sh
//                                  must be running): edit, diff, undo/redo, read-only review chat
//
// Nothing here calls a real model; it creates one throwaway chat per machine and deletes it.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const args = process.argv.slice(2);
const FULL = args.includes("--full");
const only = args.filter((a) => !a.startsWith("--"));
const cfgPath = (process.env.HQ_CONFIG || "~/.config/hq-app/config.json").replace(/^~/, os.homedir());
const config = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
// Relative machine folders ("./project") resolve from the config file's folder, exactly as server.mjs does.
for (const b of config.backends || []) for (const k of ["home", "chatsDir"])
  if (b[k] && /^\.\.?[\\/]/.test(b[k])) b[k] = path.resolve(path.dirname(path.resolve(cfgPath)), b[k]);

// Every endpoint HQ's UI or server calls (src/api.ts, src/store.ts). Keep this list in step with api.ts.
const USED = [
  ["get", "/api/info"], ["get", "/api/model"], ["get", "/api/model/default"], ["get", "/api/session"],
  ["post", "/api/session"], ["get", "/api/session/active"], ["get", "/api/session/{sessionID}"],
  ["patch", "/api/session/{sessionID}"], ["delete", "/api/session/{sessionID}"], ["post", "/api/session/{sessionID}/fork"],
  ["post", "/api/session/{sessionID}/model"], ["get", "/api/session/{sessionID}/message"],
  ["get", "/api/session/{sessionID}/message/{messageID}"], ["post", "/api/session/{sessionID}/prompt"],
  ["post", "/api/session/{sessionID}/interrupt"], ["get", "/api/session/{sessionID}/inbox"],
  ["patch", "/api/session/{sessionID}/inbox/{inboxID}"], ["delete", "/api/session/{sessionID}/inbox/{inboxID}"],
  ["get", "/api/session/{sessionID}/permission"], ["post", "/api/session/{sessionID}/permission/{requestID}/reply"],
  ["get", "/api/session/{sessionID}/form"], ["post", "/api/session/{sessionID}/form/{formID}/reply"],
  ["delete", "/api/session/{sessionID}/form/{formID}"], ["get", "/api/session/{sessionID}/diff"],
  ["post", "/api/session/{sessionID}/revert/stage"], ["delete", "/api/session/{sessionID}/revert"],
  ["put", "/api/experimental/session/{sessionID}/instructions/entries/{key}"],
  ["delete", "/api/experimental/session/{sessionID}/instructions/entries/{key}"],
  ["get", "/api/fs/list"], ["get", "/api/event"], ["post", "/api/location/reload"], ["get", "/api/mcp"],
  // Settings › Models (models.mjs)
  ["get", "/api/config"], ["get", "/api/provider"], ["get", "/api/integration"],
  ["post", "/api/integration/{integrationID}/connect/key"], ["delete", "/api/credential/{credentialID}"],
  ["post", "/api/experimental/fs/write"],
];

let failures = 0;
const line = (ok, what, detail = "") => {
  if (!ok) failures++;
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${what}${detail ? `  (${detail})` : ""}`);
};

function client(b) {
  const auth = b.user ? "Basic " + Buffer.from(`${b.user}:${b.password}`).toString("base64") : undefined;
  const base = b.url.replace(/\/$/, "");
  const self = async (method, p, body, tries = 0) => {
    const r = await fetch(base + p, {
      method,
      headers: { ...(auth ? { authorization: auth } : {}), ...(body ? { "content-type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(30000),
    });
    const text = await r.text();
    let data;
    try { data = text ? JSON.parse(text) : null; } catch { data = text; }
    if (r.status === 503 && !body && tries < 3) {
      // the machine is still loading that folder: wait and ask again
      await new Promise((res) => setTimeout(res, 2000));
      return self(method, p, body, tries + 1);
    }
    if (!r.ok) throw new Error(`${method} ${p} -> ${r.status} ${typeof data === "string" ? data.slice(0, 120) : JSON.stringify(data).slice(0, 160)}`);
    return data;
  };
  return self;
}
const loc = (d) => `location[directory]=${encodeURIComponent(d)}`;

// Per-machine state: once the machine drops off, the checks that never ran
// are skipped (the offline line above is the only thing printed for it).
async function check(state, name, fn) {
  if (state.offline) return;
  try {
    const detail = await fn();
    line(true, name, detail || "");
  } catch (e) {
    const why = offlineCause(e, false);
    if (why) {
      state.offline = true;
      console.log(`  offline: not reachable  (${why})`);
      return;
    }
    line(false, name, e.message);
  }
}

// A connect-stage network error (DNS, refused, reset, connect timeout) means
// the machine is switched off or unreachable: report it as offline, not as a
// failed check. A 30 s stall counts ONLY during the initial reachability
// probe, where a dead blackholed machine and a hung server are indistinguishable;
// after /api/info has succeeded the machine is known to be alive, so a stalled
// connection there means a hung server and must FAIL. HTTP errors from a live
// server (5xx, changed shapes, missing endpoints) always fail as before.
// Only connect-stage UND_ERR_ codes count: UND_ERR_HEADERS_TIMEOUT /
// UND_ERR_BODY_TIMEOUT mean a live machine whose server hangs, which must
// fail, not go quiet.
const NET_CODES = new Set([
  "ENOTFOUND", "ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "EAI_AGAIN",
  "EHOSTUNREACH", "ENETUNREACH", "UND_ERR_CONNECT_TIMEOUT",
]);
function offlineCause(e, probe) {
  for (const c of [e?.cause, e]) {
    const code = c?.code;
    if (code && NET_CODES.has(code)) return code;
    // AbortSignal.timeout() rejects with DOMException name "TimeoutError" (code 23).
    // Not counted when probe=false: by then the machine answered /api/info, so a
    // stall is a hung server, not a dead machine. (The event-stream check's
    // manual abort() -> "AbortError" is likewise never offline.)
    if (probe && (c?.name === "TimeoutError" || code === 23)) return "timed out";
  }
  return null;
}

async function testBackend(b) {
  console.log(`\n${b.label || b.id}  ${b.url}`);
  const api = client(b);
  const dir = b.chatsDir || b.home || "/";
  const st = {};
  let info;
  try {
    info = await api("GET", "/api/info");
  } catch (e) {
    // The probe is the only point where a stalled connection is ambiguous:
    // a dead (blackholed) machine and a hung server look identical, but a
    // machine being switched off is the case this test is for. Later, the
    // machine has already proved alive, so check() classifies stalls as
    // failures (see the comment in offlineCause).
    const why = offlineCause(e, true);
    if (why) {
      console.log(`  offline: not reachable  (${why})`);
      return;
    }
    line(false, "server reachable", e.message);
    return;
  }
  line(true, "server reachable", `OpenCode ${info.version} on ${info.hostname}`);
  if (!["2.2.7", "2.3.0"].includes(info.version)) console.log(`  note  HQ was tested with OpenCode 2.2.7 and 2.3.0; this is ${info.version}. Failures below show what changed.`);

  await check(st, "API description lists every endpoint HQ uses", async () => {
    const spec = await api("GET", "/openapi.json");
    const missing = USED.filter(([m, p]) => !spec.paths?.[p]?.[m]).map(([m, p]) => `${m.toUpperCase()} ${p}`);
    if (missing.length) throw new Error("missing: " + missing.join(", "));
    return `${USED.length} endpoints`;
  });
  await check(st, "models", async () => {
    const r = await api("GET", `/api/model?${loc(dir)}`);
    if (!Array.isArray(r.data) || !r.data.length) throw new Error("no models");
    const bad = r.data.find((m) => !m.id || !m.providerID || !m.limit);
    if (bad) throw new Error("model shape changed: " + JSON.stringify(bad).slice(0, 120));
    return r.data.map((m) => m.providerID).join(", ");
  });
  await check(st, "chat list", async () => {
    const r = await api("GET", `/api/session?directory=${encodeURIComponent(dir)}&limit=5`);
    if (!Array.isArray(r.data)) throw new Error("no data array");
  });

  let sid;
  await check(st, "create, rename, read a chat", async () => {
    const s = (await api("POST", "/api/session", { location: { directory: dir }, title: "HQ self-test (safe to delete)" })).data;
    sid = s.id;
    if (!s.location?.directory || !s.time?.created) throw new Error("session shape changed");
    await api("PATCH", `/api/session/${sid}`, { title: "HQ self-test" });
    const again = (await api("GET", `/api/session/${sid}`)).data;
    if (again.title !== "HQ self-test") throw new Error("rename did not stick");
  });
  if (sid) {
    await check(st, "messages / queue / permissions / questions endpoints", async () => {
      const m = await api("GET", `/api/session/${sid}/message?limit=10`);
      if (!Array.isArray(m.data) || !("cursor" in m)) throw new Error("message list shape changed");
      for (const p of ["inbox", "permission", "form"]) {
        const r = await api("GET", `/api/session/${sid}/${p}`);
        if (!Array.isArray(r.data)) throw new Error(`${p} shape changed`);
      }
    });
    await check(st, "per-chat instructions (voice mode)", async () => {
      await api("PUT", `/api/experimental/session/${sid}/instructions/entries/hq-selftest`, { value: "test" });
      await api("DELETE", `/api/experimental/session/${sid}/instructions/entries/hq-selftest`);
    });
    await check(st, "read-only child chat (reviews)", async () => {
      const child = (await api("POST", "/api/session", {
        location: { directory: dir }, parentID: sid, title: "HQ self-test review",
        permissions: [{ action: "*", resource: "*", effect: "deny" }, { action: "read", resource: "*", effect: "allow" }],
        metadata: { hqReview: true, turn: "msg_x" },
      })).data;
      const kids = (await api("GET", `/api/session?parentID=${sid}&limit=5`)).data;
      if (!kids.some((k) => k.id === child.id)) throw new Error("child not listed by parentID");
      if (!kids.find((k) => k.id === child.id)?.metadata?.hqReview) throw new Error("metadata not kept");
    });
    await check(st, "delete chat", async () => {
      await api("DELETE", `/api/session/${sid}`);
    });
  }
  await check(st, "folder listing", async () => {
    const r = await api("GET", `/api/fs/list?${loc(dir)}`);
    if (!Array.isArray(r.data) || (r.data[0] && !("type" in r.data[0]))) throw new Error("shape changed");
    return `${r.data.length} entries`;
  });
  await check(st, "live event stream", async () => {
    const auth = b.user ? { authorization: "Basic " + Buffer.from(`${b.user}:${b.password}`).toString("base64") } : {};
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 8000);
    const r = await fetch(b.url.replace(/\/$/, "") + "/api/event", { headers: auth, signal: ctl.signal });
    const reader = r.body.getReader();
    let buf = "";
    while (!buf.includes("server.connected")) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += Buffer.from(value).toString();
    }
    clearTimeout(t);
    ctl.abort();
    if (!buf.includes("server.connected")) throw new Error("no server.connected event");
  });
  await check(st, "tool servers (MCP)", async () => {
    const r = await api("GET", `/api/mcp?${loc(dir)}`);
    return (r.data || []).map((m) => `${m.name}:${m.status?.status}`).join(", ") || "none connected yet";
  });
}

async function full() {
  // Real turns on the dev stack's scripted model (never a real model).
  const dev = { id: "dev", label: "Dev stack (scripted model)", url: "http://127.0.0.1:4298", user: "opencode", password: "dev" };
  console.log(`\n${dev.label}  ${dev.url}`);
  const api = client(dev);
  const st = {};
  const dir = path.join(os.homedir(), "hq-devproj");
  const file = path.join(dir, "hello.txt");
  const idle = async (sid) => {
    for (let i = 0; i < 60; i++) {
      await new Promise((r) => setTimeout(r, 500));
      if (!(await api("GET", "/api/session/active")).data[sid]) return;
    }
    throw new Error("turn did not finish");
  };
  try {
    await api("GET", "/api/info");
  } catch {
    line(false, "dev stack running", "start it with dev/run_dev_backend.sh");
    return;
  }
  fs.mkdirSync(dir, { recursive: true });
  fs.rmSync(file, { force: true });
  let sid;
  let userId;
  await check(st, "an editing turn writes the file and streams to idle", async () => {
    sid = (await api("POST", "/api/session", { location: { directory: dir }, model: { id: "mock", providerID: "mock" } })).data.id;
    await api("POST", `/api/session/${sid}/prompt`, { text: "please edit a file" });
    await idle(sid);
    if (!fs.existsSync(file)) throw new Error("file not written");
    const msgs = (await api("GET", `/api/session/${sid}/message`)).data;
    userId = msgs.reverse().find((m) => m.type === "user")?.id;
    if (!msgs.some((m) => m.type === "idle")) throw new Error("no idle marker");
  });
  await check(st, "per-turn diff (Edited files card)", async () => {
    const d = (await api("GET", `/api/session/${sid}/diff?from=${userId}&context=3`)).data;
    if (!d.length || !("additions" in d[0])) throw new Error("empty or changed: " + JSON.stringify(d).slice(0, 100));
    return `${d[0].file} +${d[0].additions} -${d[0].deletions}`;
  });
  await check(st, "undo then redo restores the file", async () => {
    await api("POST", `/api/session/${sid}/revert/stage`, { messageID: userId, files: true });
    if (fs.existsSync(file)) throw new Error("undo did not remove the file");
    await api("DELETE", `/api/session/${sid}/revert`);
    if (!fs.existsSync(file)) throw new Error("redo did not restore the file");
  });
  await check(st, "read-only review chat cannot write", async () => {
    fs.rmSync(file, { force: true });
    const child = (await api("POST", "/api/session", {
      location: { directory: dir }, parentID: sid, model: { id: "mock", providerID: "mock" },
      permissions: [{ action: "*", resource: "*", effect: "deny" }, { action: "read", resource: "*", effect: "allow" }],
    })).data.id;
    await api("POST", `/api/session/${child}/prompt`, { text: "please edit a file" });
    await idle(child);
    if (fs.existsSync(file)) throw new Error("the read-only chat wrote a file");
  });
  if (sid) await api("DELETE", `/api/session/${sid}`).catch(() => {});
}

for (const b of config.backends) if (!only.length || only.includes(b.id)) await testBackend(b);
if (FULL) await full();
console.log(failures ? `\n${failures} check(s) failed.` : "\nAll checks passed.");
process.exit(failures ? 1 : 0);
