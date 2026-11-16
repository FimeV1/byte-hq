// HQ's shared browser: one headless Chromium on this machine that both the agent and the person
// use. The agent drives it through Playwright MCP (OpenCode config: --cdp-endpoint to this port);
// HQ shows it live in the side pane (CDP screencast) and sends the person's clicks and keys back.
//
// Routes (all behind HQ's login):
//   GET  /hq/browser/stream?tab=<id>  SSE: "tabs" (the tab list), "frame" (JPEG + page size), "info"
//   POST /hq/browser/action           {tab?, action: navigate|back|forward|reload|newTab|closeTab|activate|mouse|wheel|key|text, ...}
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const expand = (p) => (p.startsWith("~") ? path.join(os.homedir(), p.slice(1)) : p);

/** Playwright's Chromium (npx playwright install chromium) on macOS, Linux or Windows, else an installed Chrome/Chromium. */
function findChrome() {
  const home = os.homedir();
  const caches = {
    darwin: [path.join(home, "Library/Caches/ms-playwright")],
    linux: [path.join(home, ".cache/ms-playwright")],
    win32: [path.join(process.env.LOCALAPPDATA || path.join(home, "AppData/Local"), "ms-playwright")],
  }[process.platform] || [];
  if (process.env.PLAYWRIGHT_BROWSERS_PATH) caches.unshift(process.env.PLAYWRIGHT_BROWSERS_PATH);
  const inside = [
    "chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
    "chrome-mac/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
    "chrome-mac/Chromium.app/Contents/MacOS/Chromium",
    "chrome-linux64/chrome",
    "chrome-linux/chrome",
    "chrome-win64/chrome.exe",
    "chrome-win/chrome.exe",
  ];
  for (const cache of caches) {
    const builds = fs.existsSync(cache) ? fs.readdirSync(cache).filter((d) => /^chromium-\d+$/.test(d)).sort((a, b) => Number(b.slice(9)) - Number(a.slice(9))) : [];
    for (const b of builds) for (const rel of inside) if (fs.existsSync(path.join(cache, b, rel))) return path.join(cache, b, rel);
  }
  const installed = {
    darwin: ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/Applications/Chromium.app/Contents/MacOS/Chromium"],
    linux: ["/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/bin/google-chrome", "/snap/bin/chromium"],
    win32: [path.join(process.env.PROGRAMFILES || "C:/Program Files", "Google/Chrome/Application/chrome.exe")],
  }[process.platform] || [];
  return installed.find((p) => fs.existsSync(p)) || null;
}

/** A CDP WebSocket connection with request/response matching and event listeners. */
class Cdp {
  constructor(url) {
    this.ws = new WebSocket(url);
    this.next = 1;
    this.pending = new Map();
    this.listeners = new Set();
    this.open = new Promise((resolve, reject) => {
      this.ws.onopen = resolve;
      this.ws.onerror = () => reject(new Error("CDP connection failed"));
    });
    this.ws.onmessage = (m) => {
      const msg = JSON.parse(typeof m.data === "string" ? m.data : m.data.toString());
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
      } else if (msg.method) this.listeners.forEach((l) => l(msg));
    };
    this.closed = new Promise((resolve) => {
      this.ws.onclose = () => {
        this.pending.forEach(({ reject }) => reject(new Error("CDP closed")));
        this.pending.clear();
        resolve();
      };
    });
  }
  async send(method, params = {}) {
    await this.open;
    const id = this.next++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  close() {
    try { this.ws.close(); } catch { /* already closed */ }
  }
}

export class SharedBrowser {
  constructor(opts = {}) {
    this.port = opts.port || 9335;
    this.profile = expand(opts.profile || "~/.hq-app/browser-profile");
    this.exe = opts.executable || findChrome();
    this.base = `http://127.0.0.1:${this.port}`;
    this.pages = new Map(); // tab id -> { cdp, viewers:Set, last:frame, info }
    this.tabs = [];
    this.tabWatchers = new Set();
  }

  async start() {
    if (await this.alive()) return this.watchTabs(); // already running (e.g. after an HQ restart)
    if (!this.exe) throw new Error("no Chromium found (install one with: npx playwright install chromium)");
    fs.mkdirSync(this.profile, { recursive: true });
    const launch = () => {
      this.proc = spawn(this.exe, [
        "--headless=new", `--remote-debugging-port=${this.port}`, "--remote-debugging-address=127.0.0.1",
        `--user-data-dir=${this.profile}`, "--no-first-run", "--no-default-browser-check", "--window-size=1280,800",
        "--disable-features=Translate",
        // Never touch the macOS keychain: without these Chrome asks for the login keychain
        // password to encrypt its cookie store. This profile holds no real logins anyway.
        "--use-mock-keychain", "--password-store=basic",
        "about:blank",
      ], { stdio: "ignore" });
      this.proc.on("exit", (code) => {
        console.log(`browser exited (${code}); restarting in 3s`);
        setTimeout(launch, 3000);
      });
    };
    launch();
    for (let i = 0; i < 50 && !(await this.alive()); i++) await new Promise((r) => setTimeout(r, 200));
    console.log(`browser on ${this.base} (profile ${this.profile})`);
    this.watchTabs();
  }

  async alive() {
    try {
      return (await fetch(`${this.base}/json/version`, { signal: AbortSignal.timeout(1000) })).ok;
    } catch {
      return false;
    }
  }

  async listTabs() {
    const r = await fetch(`${this.base}/json/list`, { signal: AbortSignal.timeout(2000) });
    return (await r.json()).filter((t) => t.type === "page").map((t) => ({ id: t.id, title: t.title, url: t.url, ws: t.webSocketDebuggerUrl }));
  }

  /** Poll the tab list once a second and tell viewers when it changes (new agent tabs show up this way). */
  watchTabs() {
    if (this.tabTimer) return;
    this.tabTimer = setInterval(async () => {
      try {
        const tabs = await this.listTabs();
        const key = JSON.stringify(tabs.map((t) => [t.id, t.title, t.url]));
        if (key !== this.tabsKey) {
          this.tabsKey = key;
          this.tabs = tabs;
          this.tabWatchers.forEach((w) => w(tabs));
        }
      } catch { /* browser restarting */ }
    }, 1000);
  }

  async page(id) {
    let p = this.pages.get(id);
    if (p) return p;
    const tab = (this.tabs.find((t) => t.id === id)) || (await this.listTabs()).find((t) => t.id === id);
    if (!tab) throw new Error("no such tab");
    p = { cdp: new Cdp(tab.ws), viewers: new Set(), last: null, size: { w: 1280, h: 800 } };
    this.pages.set(id, p);
    p.cdp.closed.then(() => {
      this.pages.delete(id);
      p.viewers.forEach((v) => v.end());
    });
    p.cdp.listeners.add((msg) => {
      if (msg.method === "Page.screencastFrame") {
        const { data, metadata, sessionId } = msg.params;
        p.cdp.send("Page.screencastFrameAck", { sessionId }).catch(() => {});
        p.last = { data, w: metadata.deviceWidth, h: metadata.deviceHeight };
        p.viewers.forEach((v) => v.frame(p.last));
      }
    });
    await p.cdp.send("Page.enable");
    return p;
  }

  async startScreencast(p) {
    if (p.casting) return;
    p.casting = true;
    await p.cdp.send("Page.startScreencast", { format: "jpeg", quality: 75, maxWidth: 2400, maxHeight: 2400, everyNthFrame: 1 });
    // A static page sends no frames; take one picture so the pane is never blank.
    const m = await p.cdp.send("Page.getLayoutMetrics").catch(() => null);
    const shot = await p.cdp.send("Page.captureScreenshot", { format: "jpeg", quality: 70 }).catch(() => null);
    if (shot) {
      const v = m?.cssVisualViewport || m?.visualViewport;
      p.last = { data: shot.data, w: v?.clientWidth || 1280, h: v?.clientHeight || 800 };
      p.viewers.forEach((x) => x.frame(p.last));
    }
  }

  async stopScreencastIfIdle(id) {
    const p = this.pages.get(id);
    if (p && p.viewers.size === 0 && p.casting) {
      p.casting = false;
      await p.cdp.send("Page.stopScreencast").catch(() => {});
    }
  }

  // ---- HTTP ---------------------------------------------------------------------------------

  async stream(req, res, url) {
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "X-Accel-Buffering": "no" });
    const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    const tabsW = (tabs) => send("tabs", tabs.map(({ ws, ...t }) => t));
    this.tabWatchers.add(tabsW);
    tabsW(this.tabs.length ? this.tabs : await this.listTabs().catch(() => []));
    const keep = setInterval(() => res.write(": keepalive\n\n"), 15000);
    let viewer = null;
    let pageId = url.searchParams.get("tab");
    const cleanup = () => {
      clearInterval(keep);
      this.tabWatchers.delete(tabsW);
      if (viewer) {
        this.pages.get(pageId)?.viewers.delete(viewer);
        this.stopScreencastIfIdle(pageId);
      }
    };
    req.on("close", cleanup);
    if (!pageId) return;
    try {
      const p = await this.page(pageId);
      viewer = { frame: (f) => send("frame", f), end: () => res.end() };
      p.viewers.add(viewer);
      if (p.last) viewer.frame(p.last);
      await this.startScreencast(p);
    } catch (e) {
      send("error", { message: e.message });
      res.end();
    }
  }

  async action(body) {
    const { action, tab } = body;
    if (action === "newTab") {
      const r = await fetch(`${this.base}/json/new?${encodeURIComponent(body.url || "about:blank")}`, { method: "PUT" });
      return await r.json();
    }
    if (action === "closeTab") return (await fetch(`${this.base}/json/close/${tab}`)).ok;
    if (action === "activate") return (await fetch(`${this.base}/json/activate/${tab}`)).ok;
    const p = await this.page(tab);
    const c = p.cdp;
    switch (action) {
      case "navigate": {
        let u = String(body.url || "").trim();
        if (!/^[a-z]+:/i.test(u)) u = /^[\w-]+(\.[\w-]+)+(:\d+)?(\/|$)/.test(u) || u.startsWith("localhost") ? "http://" + u : "https://duckduckgo.com/?q=" + encodeURIComponent(u);
        return c.send("Page.navigate", { url: u });
      }
      case "reload": return c.send("Page.reload");
      case "resize": { // make the page's viewport the size of the side pane, so it is shown 1:1
        const width = Math.max(320, Math.min(2400, Math.round(body.width)));
        const height = Math.max(240, Math.min(2400, Math.round(body.height)));
        // A phone-width pane gets the site's phone layout (else desktop pages overflow sideways).
        const mobile = width < 600;
        const r = await c.send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: Math.min(2, body.scale || 1), mobile });
        await c.send("Emulation.setTouchEmulationEnabled", { enabled: mobile, maxTouchPoints: mobile ? 5 : 1 }).catch(() => {});
        p.last = null;
        return r;
      }
      case "back":
      case "forward": {
        const h = await c.send("Page.getNavigationHistory");
        const e = h.entries[h.currentIndex + (action === "back" ? -1 : 1)];
        return e ? c.send("Page.navigateToHistoryEntry", { entryId: e.id }) : null;
      }
      case "mouse": // {type: mousePressed|mouseReleased|mouseMoved, x, y, button, clickCount}
        return c.send("Input.dispatchMouseEvent", {
          type: body.type, x: body.x, y: body.y, button: body.button || "left", clickCount: body.clickCount || 1,
          buttons: body.type === "mouseReleased" ? 0 : body.type === "mousePressed" ? 1 : body.buttons || 0,
        });
      case "wheel":
        return c.send("Input.dispatchMouseEvent", { type: "mouseWheel", x: body.x, y: body.y, deltaX: body.deltaX || 0, deltaY: body.deltaY || 0 });
      case "text":
        return c.send("Input.insertText", { text: String(body.text || "") });
      case "key": { // {key, code, keyCode, modifiers, text?}
        const base = { key: body.key, code: body.code, windowsVirtualKeyCode: body.keyCode, nativeVirtualKeyCode: body.keyCode, modifiers: body.modifiers || 0 };
        // Keys that produce input (Enter submits a form) need keyDown with text; others rawKeyDown.
        await c.send("Input.dispatchKeyEvent", body.text ? { type: "keyDown", text: body.text, unmodifiedText: body.text, ...base } : { type: "rawKeyDown", ...base });
        return c.send("Input.dispatchKeyEvent", { type: "keyUp", ...base });
      }
      default:
        throw new Error(`unknown action ${action}`);
    }
  }
}
