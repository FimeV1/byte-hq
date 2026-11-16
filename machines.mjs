// Machines: add, edit and remove OpenCode servers from HQ (Settings › Servers) instead of re-running setup.
//
// Every change is tested first (HQ must be able to sign in to the server), then written to HQ's config file
// (the old one is kept as config.json.bak, both readable only by you) and applied without a restart: the relay,
// Auto and notifications pick the machine up straight away. Passwords are never sent back to the browser.
import fs from "node:fs";
import os from "node:os";

const LOOPBACK = /^(localhost|127\.\d+\.\d+\.\d+|\[::1\])$/;
const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
const absolute = (p) => /^(\/|[A-Za-z]:\\)/.test(p);

export function createMachines({ configPath, config, backends, fromConfig, usedBy, onAdd = () => {}, log = () => {} }) {
  const stopWatchers = (b) => { for (const c of b.watchers || []) c.abort(); };

  function list() {
    return config.backends.map((b) => ({
      id: b.id, label: b.label || b.id, url: b.url, user: b.user || "", hasPassword: !!b.password, home: b.home || "", chatsDir: b.chatsDir || "",
    }));
  }

  /** Can HQ sign in to this OpenCode server? Returns what it says about itself. */
  async function test({ id, url, user, password }) {
    const u = cleanURL(url);
    const old = id ? backends.get(id) : null;
    const pw = password || old?.password || "";
    const name = user || old?.user || "opencode";
    const headers = pw ? { authorization: "Basic " + Buffer.from(`${name}:${pw}`).toString("base64") } : {};
    let r;
    try {
      r = await fetch(`${u}/api/info`, { headers, signal: AbortSignal.timeout(6000) });
    } catch (e) {
      const why = e.name === "TimeoutError" ? "no answer in 6 s (is it on, and is the address right?)" : e.cause?.code === "ECONNREFUSED" ? "nothing is listening there (is `opencode serve` running?)" : e.message;
      throw new Error(`Couldn't reach ${u}: ${why}`);
    }
    if (r.status === 401) throw new Error(pw ? "Wrong username or password." : "That server needs a password (OPENCODE_SERVER_PASSWORD).");
    const info = await r.json().catch(() => null);
    if (!r.ok || !info?.version) throw new Error(`${u} answers, but not like an OpenCode 2 server (HQ needs OpenCode 2.x).`);
    if (!/^2\./.test(info.version)) throw new Error(`That's OpenCode ${info.version}; HQ needs OpenCode 2.x.`);
    const host = new URL(u).hostname;
    return { hostname: info.hostname || host, version: info.version, suggestHome: LOOPBACK.test(host) ? os.homedir() : "" };
  }

  function writeConfig(change) {
    const raw = JSON.parse(fs.readFileSync(configPath, "utf8"));
    change(raw);
    fs.copyFileSync(configPath, configPath + ".bak");
    fs.chmodSync(configPath + ".bak", 0o600);
    fs.writeFileSync(configPath + ".tmp", JSON.stringify(raw, null, 2) + "\n", { mode: 0o600 });
    fs.renameSync(configPath + ".tmp", configPath);
  }

  async function save(spec) {
    const label = String(spec.label || "").trim().slice(0, 60);
    if (!label) throw new Error("Give the machine a name.");
    const url = cleanURL(spec.url);
    const user = String(spec.user || "").trim() || "opencode";
    const home = String(spec.home || "").trim();
    if (!home || !absolute(home)) throw new Error("The chats folder must be a full path on that machine (e.g. /home/you or C:\\Users\\you).");
    const old = spec.id ? backends.get(spec.id) : null;
    if (spec.id && !old) throw new Error("That machine isn't in HQ any more: reload the page.");
    const password = spec.password ? String(spec.password) : spec.clearPassword ? "" : old?.password || "";
    const info = await test({ url, user, password: password || undefined, id: spec.clearPassword ? undefined : spec.id });

    if (old) {
      // Plain chats follow a new home folder unless the config gave them a folder of their own.
      const followHome = !old.chatsDir || old.chatsDir === old.home;
      writeConfig((raw) => {
        const e = raw.backends.find((x) => x.id === old.id);
        if (!e) throw new Error("That machine isn't in the config file any more.");
        Object.assign(e, { label, url, home });
        if (followHome) e.chatsDir = home;
        if (password) Object.assign(e, { user, password });
        else delete e.user, delete e.password;
      });
      Object.assign(old, { label, url, home: fromConfig(home), ...(followHome ? { chatsDir: fromConfig(home) } : {}) });
      if (password) Object.assign(old, { user, password });
      else delete old.user, delete old.password;
      stopWatchers(old); // they reconnect to the new address
      log(`machines: changed ${old.id}`);
      return { id: old.id, ...info };
    }

    let id = slug(label) || "machine";
    for (let n = 2; backends.has(id); n++) id = `${slug(label) || "machine"}-${n}`;
    const entry = { id, label, url, ...(password ? { user, password } : {}), home, chatsDir: home };
    writeConfig((raw) => raw.backends.push(entry));
    const b = { ...entry, home: fromConfig(home), chatsDir: fromConfig(home) };
    config.backends.push(b);
    backends.set(id, b);
    onAdd(b);
    log(`machines: added ${id}`);
    return { id, ...info };
  }

  function remove(id) {
    const b = backends.get(id);
    if (!b) throw new Error("That machine isn't in HQ.");
    if (backends.size === 1) throw new Error("HQ needs at least one machine. Add another before removing this one.");
    const used = usedBy(id);
    if (used.length) throw new Error(`${used.length === 1 ? `The project “${used[0]}” uses` : `${used.length} projects use`} this machine: remove ${used.length === 1 ? "it" : "them"} from the sidebar first.`);
    writeConfig((raw) => (raw.backends = raw.backends.filter((x) => x.id !== id)));
    b.removed = true;
    stopWatchers(b);
    backends.delete(id);
    config.backends.splice(config.backends.indexOf(b), 1);
    log(`machines: removed ${id}`);
    return { ok: true };
  }

  return { list, test, save, remove };
}

function cleanURL(u) {
  const s = String(u || "").trim().replace(/\/+$/, "");
  if (!/^https?:\/\/[^/]+/i.test(s)) throw new Error("The address must start with http:// or https:// (e.g. http://127.0.0.1:4096).");
  const url = new URL(s);
  if (url.pathname !== "/" && url.pathname !== "") throw new Error("Use just the server's address and port, without a path (e.g. http://127.0.0.1:4096).");
  return url.origin;
}
