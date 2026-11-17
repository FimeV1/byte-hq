import { useEffect, useState } from "react";
import { ArrowUp, ChevronRight, CircleCheck, Copy, Folder, FolderOpen, KeyRound, Link, LoaderCircle, Monitor, Pencil, Plus, RefreshCw, Shield, SquarePen } from "lucide-react";
import { api, hq } from "./api";
import { chatsSpace, createProject, newChat, openMachine, openModal, openModels, projectSpace, toast, useStore } from "./store";
import type { Backend, GitCheckLogin, GitStatus, Machine, Project, Space } from "./types";
import { applyTheme, Dialog, savedTheme, type Theme } from "./ui";
import { formatBytes } from "./Gallery";

/** Settings: how much room the saved images and videos take, and the way to the gallery. */
function MediaRow() {
  const [size, setSize] = useState<{ n: number; bytes: number } | null>(null);
  useEffect(() => void hq.mediaList().then((l) => setSize({ n: l.items.length, bytes: l.bytes })).catch(() => {}), []);
  return (
    <div className="rowline">
      <div className="grow">
        Images and videos
        <small>{size ? `${size.n} saved · ${formatBytes(size.bytes)}. Deleting a chat deletes its own; a branch keeps what it shows.` : "Every one made in HQ, with its chat."}</small>
      </div>
      <button type="button" className="btn" onClick={() => openModal("gallery")}>Open</button>
    </div>
  );
}

// Paths may be POSIX (/home/you) or Windows (C:\Users\you), depending on the machine.
const sepOf = (p: string) => (/^[A-Za-z]:\\/.test(p) || (p.includes("\\") && !p.includes("/")) ? "\\" : "/");
const isRoot = (p: string) => p === "/" || /^[A-Za-z]:\\?$/.test(p);
const parent = (p: string) => {
  if (isRoot(p)) return p;
  const sep = sepOf(p);
  const up = p.replace(/[\\/]+$/, "").replace(/[\\/][^\\/]+$/, "");
  return up === "" ? "/" : /^[A-Za-z]:$/.test(up) ? up + sep : up;
};
const join = (dir: string, name: string) => (dir.endsWith("/") || dir.endsWith("\\") ? dir : dir + sepOf(dir)) + name;
const baseName = (p: string) => p.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || p;

export function FolderBrowser({ backend, start, onPick }: { backend: Backend; start: string; onPick: (dir: string) => void }) {
  const [dir, setDir] = useState(start);
  const [entries, setEntries] = useState<string[] | null>(null);
  const [error, setError] = useState("");
  const [hidden, setHidden] = useState(false);
  const [typed, setTyped] = useState(start);
  useEffect(() => setTyped(dir), [dir]);
  useEffect(() => {
    let live = true;
    setEntries(null);
    setError("");
    api
      .listDir(backend.id, dir)
      .then((list) => live && setEntries(list.filter((e) => e.type === "directory").map((e) => e.path.replace(/[\\/]+$/, "")).sort((a, b) => a.localeCompare(b))))
      .catch((e) => live && setError(e.message));
    return () => void (live = false);
  }, [backend.id, dir]);
  const shown = (entries || []).filter((n) => hidden || !n.startsWith("."));
  return (
    <>
      <div className="browser">
        <div className="browser-path">
          <button type="button" className="icon-btn" onClick={() => setDir(parent(dir))} disabled={isRoot(dir)} aria-label="Up one folder" title="Up one folder"><ArrowUp size={16} /></button>
          {/* Type or paste a path and press Enter to jump there. */}
          <input
            className="browser-input"
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && typed.trim() && setDir(typed.trim().replace(/^~(?=$|[\\/])/, backend.home || "~"))}
            onBlur={() => setTyped(dir)}
            spellCheck={false}
            autoCapitalize="off"
            aria-label="Folder path"
            title="Type or paste a path, then press Enter"
          />
        </div>
        <div className="browser-list">
          {error && <div className="sb-empty" style={{ color: "var(--del)" }}>{error}</div>}
          {!entries && !error && <div className="sb-empty">Loading…</div>}
          {entries && shown.length === 0 && <div className="sb-empty">No folders here</div>}
          {shown.map((name) => (
            <button key={name} type="button" onClick={() => setDir(join(dir, name))}>
              <Folder size={15} />{name}
            </button>
          ))}
        </div>
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 12 }}>
        <label style={{ color: "var(--dim)", display: "flex", gap: 6, alignItems: "center", flex: 1 }}>
          <input type="checkbox" checked={hidden} onChange={(e) => setHidden(e.target.checked)} /> Show hidden folders
        </label>
        <button type="button" className="btn big primary" onClick={() => onPick(dir)}>Use this folder</button>
      </div>
    </>
  );
}

export function NewProjectDialog() {
  const backends = useStore((s) => s.backends);
  const [name, setName] = useState("");
  const [backendId, setBackendId] = useState(backends[0]?.id || "");
  const [dir, setDir] = useState("");
  const [browsing, setBrowsing] = useState(false);
  const backend = backends.find((b) => b.id === backendId);
  const close = () => openModal(null);
  const ok = !!backend && !!dir;
  const create = () => {
    if (!ok) return;
    createProject(name.trim() || baseName(dir), backend!.id, dir);
    close();
  };

  if (browsing && backend) {
    return (
      <Dialog title="Choose a folder" onClose={() => setBrowsing(false)}>
        <FolderBrowser backend={backend} start={dir || backend.home || "/"} onPick={(d) => (setDir(d), setBrowsing(false))} />
      </Dialog>
    );
  }
  return (
    <Dialog
      title="Create new project"
      onClose={close}
      footer={
        <>
          <button type="button" className="btn big" onClick={close}>Cancel</button>
          <button type="button" className="btn big primary" disabled={!ok} onClick={create}>Create</button>
        </>
      }
    >
      <input className="input" autoFocus placeholder="Project name" value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === "Enter" && create()} />
      {backends.length > 1 && (
        <>
          <div className="field-label">Machine</div>
          <div className="seg">
            {backends.map((b) => (
              <button key={b.id} type="button" className={b.id === backendId ? "on" : ""} onClick={() => (setBackendId(b.id), setDir(""))}>{b.label}</button>
            ))}
          </div>
        </>
      )}
      <div className="field-label">Working directory</div>
      <button type="button" className={"pick" + (dir ? " set" : "")} onClick={() => setBrowsing(true)}>
        <FolderOpen size={16} />
        <span className="grow">{dir || "Choose a folder to work in"}</span>
        <ChevronRight size={16} />
      </button>
    </Dialog>
  );
}

/** "Phone notifications" in Settings: subscribe this device to HQ's Web Push. */
function NotificationsRow() {
  const [state, setState] = useState<"checking" | "unsupported" | "needs-app" | "off" | "on" | "blocked">("checking");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  useEffect(() => {
    (async () => {
      const standalone = matchMedia("(display-mode: standalone)").matches || (navigator as unknown as { standalone?: boolean }).standalone;
      const ios = /iPhone|iPad|iPod/.test(navigator.userAgent);
      if (!("serviceWorker" in navigator) || !("PushManager" in window) || !window.isSecureContext) {
        return setState(ios && !standalone ? "needs-app" : "unsupported");
      }
      if (Notification.permission === "denied") return setState("blocked");
      const reg = await navigator.serviceWorker.ready;
      setState((await reg.pushManager.getSubscription()) ? "on" : "off");
    })().catch(() => setState("unsupported"));
  }, []);
  const turnOn = async () => {
    setBusy(true);
    setMsg("");
    try {
      if ((await Notification.requestPermission()) !== "granted") return setState("blocked");
      const { publicKey } = await fetch("/hq/push/key").then((r) => r.json());
      const reg = await navigator.serviceWorker.ready;
      const key = Uint8Array.from(atob(publicKey.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((publicKey.length + 3) % 4)), (c) => c.charCodeAt(0));
      const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
      const r = await fetch("/hq/push/subscribe", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(sub) });
      if (!r.ok) throw new Error((await r.json()).message);
      setState("on");
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  const test = () => fetch("/hq/push/test", { method: "POST" }).then(() => setMsg("Sent. It should arrive in a few seconds."));
  const word = {
    checking: "Checking…",
    unsupported: "This browser can't receive notifications from HQ.",
    "needs-app": "On iPhone: Share › Add to Home Screen, open HQ from there, then turn them on.",
    off: "Off on this device.",
    on: "On for this device.",
    blocked: "Blocked. Allow notifications for HQ in this device's settings.",
  }[state];
  return (
    <div className="rowline">
      <div className="grow">
        Phone notifications
        <small>{word} When a job finishes or needs your answer. They never show what was said.</small>
        {msg && <small>{msg}</small>}
      </div>
      {state === "off" && <button type="button" className="btn primary" disabled={busy} onClick={turnOn}>Turn on</button>}
      {state === "on" && <button type="button" className="btn" onClick={test}>Test</button>}
    </div>
  );
}

function ThemeRow() {
  const [t, setT] = useState<Theme>(savedTheme());
  const pick = (v: Theme) => (setT(v), applyTheme(v));
  return (
    <div className="rowline">
      <div className="grow">Theme<small>Dark by default. System follows this device's light or dark setting.</small></div>
      <div className="seg">
        {(["dark", "light", "system"] as const).map((v) => (
          <button key={v} type="button" className={t === v ? "on" : ""} onClick={() => pick(v)}>{v[0].toUpperCase() + v.slice(1)}</button>
        ))}
      </div>
    </div>
  );
}

/** The state of one project in Settings › Git: a loaded GitStatus, an error, or still loading. */
type GitRow = GitStatus | { error: string };
const rowHasProblems = (r: GitRow | undefined) => (r !== undefined && ("error" in r || r.problems.length > 0));
const fmtWhen = (ms: number | null) => {
  if (!ms) return "";
  const d = Date.now() - ms;
  if (d < 3600e3) return `${Math.max(1, Math.round(d / 60e3))} min ago`;
  if (d < 86400e3) return `${Math.round(d / 3600e3)} h ago`;
  if (d < 7 * 86400e3) return `${Math.round(d / 86400e3)} days ago`;
  return new Date(ms).toLocaleDateString();
};

/** Connect a project to a repo: the URL is checked here (and again on the server) before the
 *  user confirms, and the user sees the exact command that will run before they run it. */
function GitConnectDialog({ project, onDone, onCancel }: { project: Project; onDone: (s: GitStatus) => void; onCancel: () => void }) {
  const backends = useStore((s) => s.backends);
  const backend = backends.find((b) => b.id === project.backend);
  const [url, setUrl] = useState("");
  const [err, setErr] = useState("");
  const [phase, setPhase] = useState<"input" | "confirm">("input");
  const [busy, setBusy] = useState(false);
  const bad = hqValidateUrl(url);
  const command = `git remote add origin ${url.trim()}`;
  const connect = () => {
    if (bad) return setErr(bad);
    setBusy(true);
    hq.gitConnect(project.id, url.trim())
      .then((s) => {
        toast(`Connected ${project.name} to that repo`);
        onDone(s);
      })
      .catch((e) => setErr(e instanceof Error ? e.message : String(e)))
      .finally(() => setBusy(false));
  };
  return (
    <Dialog
      title={`Connect ${project.name} to a repo`}
      onClose={() => !busy && onCancel()}
      footer={
        phase === "input" ? (
          <>
            <button type="button" className="btn big" disabled={busy} onClick={onCancel}>Cancel</button>
            <button type="button" className="btn big primary" disabled={!!bad || busy} onClick={() => setPhase("confirm")}>Continue</button>
          </>
        ) : phase === "confirm" ? (
          <>
            <button type="button" className="btn big" disabled={busy} onClick={() => setPhase("input")}>Back</button>
            <button type="button" className="btn big primary" disabled={busy} onClick={connect}>
              {busy ? "Connecting…" : "Connect"}
            </button>
          </>
        ) : undefined
      }
    >
      {phase === "confirm" ? (
        <>
          <small>Before it runs, here is exactly what HQ will do on {backend?.label || project.backend}:</small>
          <code className="git-command">{command}</code>
          <small>
            That only writes the remote into the project's git config — it contacts nothing, and nothing is pushed.
            After it, use <b>Check login</b> to see whether {backend?.label || "this machine"} can push to it.
          </small>
        </>
      ) : (
        <>
          <small>Paste the repo's address, from its "Clone" menu. HTTPS and SSH addresses both work.</small>
          <input
            className="input"
            autoFocus
            spellCheck={false}
            autoCapitalize="off"
            placeholder="https://github.com/you/your-repo.git"
            value={url}
            onChange={(e) => {
              setUrl(e.target.value);
              setErr("");
            }}
            onKeyDown={(e) => !bad && e.key === "Enter" && setPhase("confirm")}
          />
          {url.trim() && bad && <div className="git-problem">{bad}</div>}
          {err && <div className="git-problem">{err}</div>}
        </>
      )}
    </Dialog>
  );
}

// The client-side half of the check: good enough to disable the button and show a reason before
// the user confirms. The server re-runs its own check on the same URL before anything runs.
const URL_FORMS = [
  /^https:\/\/[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*(?::\d{1,5})?\/[A-Za-z0-9._~%/-]+$/i,
  /^ssh:\/\/(?:[a-z0-9][a-z0-9._-]*@)?[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*(?::\d{1,5})?\/[A-Za-z0-9._~%/-]+$/i,
  /^[a-z0-9][a-z0-9._-]*@[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*:[A-Za-z0-9._~%/-]+$/i,
];
function hqValidateUrl(u: string): string {
  const s = u.trim();
  if (!s) return "paste a URL first";
  if (/[\s"'`;|&<>\r\n\\]/.test(s)) return "that URL contains characters a repo address can't have (a space, quote, ; | & < > or similar)";
  if (!URL_FORMS.some((re) => re.test(s))) return "not a repo URL: use https://host/path, ssh://host/path, or user@host:path";
  return "";
}

/** Settings › Git: every project's repo, branch and sync state, grouped by machine.
 *  HQ only reads state and (on request) fetches; pushing belongs to agents and terminals. */
export function GitDialog() {
  const projects = useStore((s) => s.projects);
  const backends = useStore((s) => s.backends);
  const [rows, setRows] = useState<Record<string, GitRow | undefined>>({});
  const [needsOnly, setNeedsOnly] = useState(false);
  const [busy, setBusy] = useState<Record<string, boolean>>({});
  const [connectTo, setConnectTo] = useState<Project | null>(null);
  const [login, setLogin] = useState<Record<string, GitCheckLogin | undefined>>({});
  const checkLogin = (p: Project) => {
    setBusy((b) => ({ ...b, [p.id]: true }));
    setLogin((l) => ({ ...l, [p.id]: undefined }));
    hq.gitCheckLogin(p.id)
      .then((r) => setLogin((l) => ({ ...l, [p.id]: r })))
      .catch((e) => setLogin((l) => ({ ...l, [p.id]: { ok: false, why: e instanceof Error ? e.message : String(e) } })))
      .finally(() => setBusy((b) => ({ ...b, [p.id]: false })));
  };
  // Load every row at once; a slow or offline machine only delays its own rows.
  useEffect(() => {
    projects.forEach((p) =>
      hq.gitStatus(p.id)
        .then((s) => setRows((r) => ({ ...r, [p.id]: s })))
        .catch((e) => setRows((r) => ({ ...r, [p.id]: { error: e instanceof Error ? e.message : String(e) } }))),
    );
  }, [projects]);
  const refresh = (p: Project) => {
    setBusy((b) => ({ ...b, [p.id]: true }));
    hq.gitRefresh(p.id)
      .then((s) => setRows((r) => ({ ...r, [p.id]: s })))
      .catch((e) => toast(e instanceof Error ? e.message : String(e)))
      .finally(() => setBusy((b) => ({ ...b, [p.id]: false })));
  };

  // Install the push guard on a public repo that has none. The server re-checks that
  // it is public and that no foreign hook sits there, then writes it and makes it
  // executable on POSIX.
  const installGuard = (p: Project) => {
    if (!confirm(
      `Install a push guard on ${p.name}?\n\n` +
      `HQ writes a pre-push hook where git runs it -- this repo's .git/hooks by default -- on the machine it lives on. From then on, anything pushed to this public repo is checked first: a force-push or a branch deletion is refused, a file that looks like a secret or a .env is refused, and a file over 50 MB is refused. Normal pushes and pulls are never affected.\n\n` +
      `If you already have a hook you want to keep, HQ leaves it in place and won't overwrite it. You can always skip this guard with git push --no-verify.`
    )) return;
    setBusy((b) => ({ ...b, [p.id]: true }));
    hq.gitInstallGuard(p.id)
      .then((s) => setRows((r) => ({ ...r, [p.id]: s })))
      .catch((e) => toast(e instanceof Error ? e.message : String(e)))
      .finally(() => setBusy((b) => ({ ...b, [p.id]: false })));
  };
  // All hooks above: replacing the list with the connect dialog must not change the hook count.
  if (connectTo)
    return (
      <GitConnectDialog
        project={connectTo}
        onDone={(s) => {
          setConnectTo(null);
          setRows((r) => ({ ...r, [s.id]: s }));
        }}
        onCancel={() => setConnectTo(null)}
      />
    );
  const shown = needsOnly ? projects.filter((p) => rowHasProblems(rows[p.id])) : projects;
  return (
    <Dialog title="Git" onClose={() => openModal(null)}>
      <div className="seg" style={{ marginBottom: 12 }}>
        <button type="button" className={!needsOnly ? "on" : ""} onClick={() => setNeedsOnly(false)}>All</button>
        <button type="button" className={needsOnly ? "on" : ""} onClick={() => setNeedsOnly(true)}>Needs attention</button>
      </div>
      {projects.length === 0 && (
        <div className="rowline">
          <div className="grow">No projects yet.</div>
          <button type="button" className="btn primary" onClick={() => openModal("newProject")}>Add one</button>
        </div>
      )}
      {backends.map((b) => {
        const mine = shown.filter((p) => p.backend === b.id);
        if (!mine.length) return null;
        return (
          <div key={b.id} className="git-group">
            <div className="git-machine"><Monitor size={14} />{b.label || b.id}</div>
            <div className="rows">
              {mine.map((p) => {
                const r = rows[p.id];
                const err = r && "error" in r;
                const lg = login[p.id];
                return (
                  <div className="rowline git-row" key={p.id}>
                    <div className="grow">
                      <span className="git-name">{p.name}</span>
                      {r && !err && r.visibility !== "unknown" && (
                        <span className={"badge " + (r.visibility === "public" ? "pub" : "priv")}>
                          {r.visibility === "public" ? "Public" : r.visibility === "private" ? "Private" : "Private or not found"}
                        </span>
                      )}
                      {r && !err && r.isGit && r.branch && <span className="git-branch">{r.branch}</span>}
                      <small>
                        {!r && "Loading…"}
                        {err && r.error}
                        {r && !err && !r.isGit && p.directory}
                        {r && !err && r.isGit && (
                          <>
                            {r.remote || "no remote"}
                            {` · ${r.ahead || r.behind ? `${r.ahead} to push, ${r.behind} to pull` : "up to date"}`}
                            {` · ${r.uncommitted ? `${r.uncommitted} uncommitted` : "clean"}`}
                            {r.lastCommitAt ? ` · last commit ${fmtWhen(r.lastCommitAt)}` : ""}
                          </>
                        )}
                      </small>
                      {r && !err && r.problems.map((t) => (
                        <div className="git-problem" key={t}>{t}</div>
                      ))}
                      {lg && (
                        <div className={lg.ok ? "git-ok" : "git-problem"}>
                          {lg.ok ? <CircleCheck size={12} className="git-ok-icon" /> : null}
                          {lg.why}
                        </div>
                      )}
                    </div>
                    {r && !err && r.isGit && (
                      <div className="git-actions">
                        {!r.remote && (
                          <button type="button" className="icon-btn" disabled={!!busy[p.id]} onClick={() => setConnectTo(p)} title="Connect this project to a repo" aria-label={`Connect ${p.name}`}>
                            <Link size={14} />
                          </button>
                        )}
                        {r.remote && (
                          <button type="button" className="icon-btn" disabled={!!busy[p.id]} onClick={() => checkLogin(p)} title="Check this machine's login can push (nothing is pushed)" aria-label={`Check login for ${p.name}`}>
                            {busy[p.id] ? <LoaderCircle size={15} className="spin" /> : <KeyRound size={14} />}
                          </button>
                        )}
                        <button type="button" className="icon-btn" disabled={!!busy[p.id]} onClick={() => refresh(p)} title="Fetch the remote" aria-label={`Fetch ${p.name}`}>
                          {busy[p.id] ? <LoaderCircle size={15} className="spin" /> : <RefreshCw size={14} />}
                        </button>
                        {r.visibility === "public" && !r.hasGuard && (
                          <button type="button" className="icon-btn" disabled={!!busy[p.id]} onClick={() => installGuard(p)} title="Install a pre-push hook that blocks force-pushes, branch deletions, secrets and huge files (you can skip it with --no-verify)" aria-label={`Install push guard for ${p.name}`}>
                            {busy[p.id] ? <LoaderCircle size={15} className="spin" /> : <Shield size={14} />}
                        </button>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        );
      })}
      <div className="notice" style={{ marginTop: 12 }}>
        HQ reads the state, runs <code>git fetch</code> when you ask, and can connect a project to a repo after you see the command.
        <b> Check login</b> is a dry-run push: it tests the machine's login and pushes nothing. Pushing happens in agents and terminals, which know their own rules.
        <b>Push guard</b> is a pre-push hook you can install on a public repo. It blocks force-pushes and branch deletions, and refuses a file that looks like a secret or is over 50 MB. A normal push and pull are never affected; you can skip it with git push --no-verify.
      </div>
    </Dialog>
  );
}

export function SettingsDialog() {
  const backends = useStore((s) => s.backends);
  const conn = useStore((s) => s.conn);
  const models = useStore((s) => s.models);
  const [info, setInfo] = useState<Record<string, string>>({});
  useEffect(() => {
    backends.forEach((b) =>
      api.info(b.id).then((i) => setInfo((x) => ({ ...x, [b.id]: `${i.hostname} · OpenCode ${i.version}` }))).catch(() => {}),
    );
  }, [backends]);
  const word = { open: "Connected", down: "Not reachable", connecting: "Connecting…" } as const;
  return (
    <Dialog title="Settings" onClose={() => openModal(null)}>
      <div className="field-label" style={{ marginTop: 0 }}>Servers</div>
      <div className="rows">
        {backends.map((b) => (
          <div className="rowline" key={b.id}>
            <span className={"status " + (conn[b.id] || "connecting")} />
            <div className="grow">
              {b.label}
              <small>{word[conn[b.id] || "connecting"]}{info[b.id] ? ` · ${info[b.id]}` : ""}</small>
              <small>Chats folder: {b.chatsDir || b.home} · {(models[b.id] || []).length} models</small>
            </div>
            <button type="button" className={"btn" + ((models[b.id] || []).length ? "" : " primary")} onClick={() => openModels(b.id)}>
              {(models[b.id] || []).length ? "Models" : "Add models"}
            </button>
            <button type="button" className="btn" onClick={() => openMachine(b.id)} title={`Change ${b.label}`} aria-label={`Change ${b.label}`}><Pencil size={14} /></button>
          </div>
        ))}
      </div>
      <button type="button" className="btn" style={{ marginTop: 8 }} onClick={() => openMachine()}><Plus size={14} /> Add a machine</button>
      <div className="field-label">Git</div>
      <div className="rows">
        <div className="rowline">
          <div className="grow">Repos<small>Every project's branch, sync state and problems, in plain words.</small></div>
          <button type="button" className="btn" onClick={() => openModal("git")}>Open</button>
        </div>
      </div>
      <div className="field-label">This device</div>
      <div className="rows">
        <ThemeRow />
        <NotificationsRow />
      </div>
      <div className="field-label">Help</div>
      <div className="rows">
        <div className="rowline">
          <div className="grow">Personal<small>Custom instructions, memory and personas: what every chat is told.</small></div>
          <button type="button" className="btn" onClick={() => openModal("personal")}>Edit</button>
        </div>
        <div className="rowline">
          <div className="grow">Saved prompts<small>Type / in the message box to use one.</small></div>
          <button type="button" className="btn" onClick={() => openModal("prompts")}>Edit</button>
        </div>
        <MediaRow />
        <div className="rowline">
          <div className="grow">Byte API help<small>Getting a key, tool access for editing files, credit.</small></div>
          <button type="button" className="btn" onClick={() => openModal("byteHelp")}>Open</button>
        </div>
      </div>
      <div className="field-label">Where things are set</div>
      <div className="rows">
        <div className="rowline"><div className="grow">Servers<small>Above (saved in ~/.config/hq-app/config.json on the machine that runs HQ)</small></div></div>
        <div className="rowline"><div className="grow">HQ's login<small>~/.config/hq-app/config.json (or run npm run setup again)</small></div></div>
        <div className="rowline"><div className="grow">Models<small>Models above (or each server's own OpenCode config)</small></div></div>
        <div className="rowline"><div className="grow">Tools and permission rules<small>Each server's own OpenCode config</small></div></div>
      </div>
    </Dialog>
  );
}

/**
 * "Where should this chat work?" — opened by every New Chat button, so picking the project is part of starting a
 * chat (a project change started as a plain chat by mistake gets no copy and no review, and edits live).
 * Projects are listed first under each machine; a plain chat in the machine's home folder is the last choice.
 */
export function NewChatDialog() {
  const backends = useStore((s) => s.backends);
  const projects = useStore((s) => s.projects);
  const conn = useStore((s) => s.conn);
  const cur = useStore((s) => s.current?.space);
  const close = () => openModal(null);
  const go = (space: Space) => (close(), newChat(space));
  const here = (sp: Space) => !!cur && cur.backend === sp.backend && cur.directory === sp.directory;
  return (
    <Dialog title="New chat — where should it work?" onClose={close}>
      <div className="nc-list">
        {backends.map((b) => {
          const mine = projects.filter((p) => p.backend === b.id);
          const home = chatsSpace(b);
          return (
            <div key={b.id} className="nc-group">
              <div className="nc-machine">
                <Monitor size={14} />{b.label || b.id}
                {conn[b.id] !== "open" && <span className="nc-off">not connected</span>}
              </div>
              {mine.map((p) => (
                <button key={p.id} type="button" className={"nc-opt proj" + (here(projectSpace(p)) ? " here" : "")} onClick={() => go(projectSpace(p))}>
                  <FolderOpen size={17} />
                  <span className="grow">{p.name}<small>{p.directory} · works on a copy</small></span>
                </button>
              ))}
              <button type="button" className={"nc-opt" + (here(home) ? " here" : "")} onClick={() => go(home)}>
                <SquarePen size={17} />
                <span className="grow">Plain chat<small>{home.directory} · not a project</small></span>
              </button>
            </div>
          );
        })}
      </div>
    </Dialog>
  );
}

type Vault = { from: "source" | "copy" | "none"; error?: string; links: { group: string; name: string; url: string; note: string }[];
  logins: { name: string; url: string; user: string; password: string; note: string }[] };

function LoginCard({ l }: { l: Vault["logins"][number] }) {
  const [shown, setShown] = useState(false);
  const [copied, setCopied] = useState("");
  const copy = (what: string, v: string) =>
    navigator.clipboard.writeText(v).then(() => (setCopied(what), setTimeout(() => setCopied(""), 1500))).catch(() => setCopied("Can't copy"));
  return (
    <div className="vault-login">
      <div className="vault-name">{l.name}</div>
      {l.url && <a className="vault-url" href={l.url} target="_blank" rel="noopener">{l.url.replace(/^https?:\/\//, "")}</a>}
      {l.user && (
        <div className="vault-row"><span className="vault-k">Username</span><code className="vault-v">{l.user}</code>
          <button type="button" className="btn" onClick={() => copy("user", l.user)}>{copied === "user" ? "Copied" : "Copy"}</button></div>
      )}
      {l.password && (
        <div className="vault-row"><span className="vault-k">Password</span><code className="vault-v">{shown ? l.password : "••••••••••"}</code>
          <button type="button" className="btn" onClick={() => setShown(!shown)}>{shown ? "Hide" : "Show"}</button>
          <button type="button" className="btn" onClick={() => copy("pw", l.password)}>{copied === "pw" ? "Copied" : "Copy"}</button></div>
      )}
      {l.note && <div className="vault-note">{l.note}</div>}
    </div>
  );
}

/** Important links and saved logins (config.vault). Never shown to models. */
export function VaultDialog() {
  const [v, setV] = useState<Vault | null>(null);
  useEffect(() => void fetch("/hq/vault", { cache: "no-store" }).then((r) => r.json()).then(setV).catch((e) => setV({ from: "none", error: String(e), links: [], logins: [] })), []);
  const groups: Record<string, Vault["links"]> = {};
  for (const l of v?.links || []) (groups[l.group] = groups[l.group] || []).push(l);
  return (
    <Dialog title="Links & logins" onClose={() => openModal(null)}>
      {!v && <div className="sb-empty">Loading…</div>}
      {v?.error && <div className="notice err">{v.error}</div>}
      {v?.from === "copy" && <div className="vault-note" style={{ marginBottom: 10 }}>The list's source isn't answering, so this is HQ's last saved copy.</div>}
      {Object.entries(groups).map(([g, links]) => (
        <div key={g}>
          <div className="field-label">{g}</div>
          <div className="vault-links">
            {links.map((l) => (
              <a key={l.name + l.url} className="vault-link" href={l.url} target="_blank" rel="noopener">
                <span className="vault-name">{l.name}</span>
                {l.note && <span className="vault-note">{l.note}</span>}
              </a>
            ))}
          </div>
        </div>
      ))}
      {!!v?.logins.length && <div className="field-label">Logins</div>}
      {v?.logins.map((l) => <LoginCard key={l.name} l={l} />)}
      <div className="vault-note" style={{ marginTop: 14 }}>
        Edit the list in the file set as config.vault. Passwords are never shown to any model.
      </div>
    </Dialog>
  );
}

const START = "OPENCODE_SERVER_PASSWORD=choose-a-password opencode serve --port 4096";

/** Settings › Servers › add or change a machine (an OpenCode server). HQ tests it before saving. */
export function MachineDialog() {
  const id = useStore((s) => s.ui.modalBackend);
  const [m, setM] = useState<Machine | null>(null);
  const [loadErr, setLoadErr] = useState("");
  useEffect(() => {
    if (!id) return setM({ id: "", label: "", url: "http://127.0.0.1:4096", user: "opencode", hasPassword: false, home: "", chatsDir: "" });
    hq.machines().then((all) => {
      const hit = all.find((x) => x.id === id);
      if (hit) setM(hit);
      else setLoadErr("That machine isn't in HQ any more.");
    }).catch((e) => setLoadErr(e.message));
  }, [id]);
  const close = () => openModal("settings");
  return (
    <Dialog title={id ? `Change ${m?.label || "machine"}` : "Add a machine"} onClose={close}>
      {loadErr && <div className="notice err">{loadErr}</div>}
      {!m && !loadErr && <div className="sb-empty"><LoaderCircle size={15} className="spin" /> Loading…</div>}
      {m && <MachineForm initial={m} onClose={close} />}
    </Dialog>
  );
}

function MachineForm({ initial, onClose }: { initial: Machine; onClose: () => void }) {
  const editing = !!initial.id;
  const [label, setLabel] = useState(initial.label);
  const [url, setUrl] = useState(initial.url);
  const [user, setUser] = useState(initial.user || "opencode");
  const [password, setPassword] = useState("");
  const [home, setHome] = useState(initial.home);
  const [busy, setBusy] = useState<"" | "test" | "save" | "remove">("");
  const [ok, setOk] = useState("");
  const [error, setError] = useState("");
  const [sure, setSure] = useState(false);
  const spec = () => ({ id: initial.id || undefined, label, url, user, password: password || undefined, home });
  const test = async () => {
    setBusy("test");
    setError("");
    setOk("");
    try {
      const r = await hq.machineTest(spec());
      setOk(`Connected: ${r.hostname} · OpenCode ${r.version}`);
      if (!home && r.suggestHome) setHome(r.suggestHome);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy("");
    }
  };
  const done = (msg: string) => {
    toast(msg, "ok");
    // The machine list is part of how the app starts (connections, chat lists): reload to show the change.
    setTimeout(() => location.reload(), 700);
  };
  const save = async () => {
    setBusy("save");
    setError("");
    try {
      await hq.machineSave(spec());
      done(editing ? `Saved ${label}` : `Added ${label}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy("");
    }
  };
  const remove = async () => {
    if (!sure) return setSure(true);
    setBusy("remove");
    try {
      await hq.machineRemove(initial.id);
      done(`Removed ${initial.label}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy("");
      setSure(false);
    }
  };
  return (
    <>
      {!editing && (
        <div className="vault-note">
          A machine is an OpenCode server. Start one on the computer the models should work on:
          <div className="help-quote">
            <code>{START}</code>
            <button type="button" className="btn" onClick={() => navigator.clipboard.writeText(START).then(() => toast("Copied", "info"))}><Copy size={13} /> Copy</button>
          </div>
          On another computer add <code>--hostname 0.0.0.0</code>, and only on a private network such as Tailscale.
        </div>
      )}
      <div className="field-label">Name</div>
      <input className="input" autoFocus={!editing} placeholder="e.g. Desktop" value={label} onChange={(e) => setLabel(e.target.value)} />
      <div className="field-label">Address</div>
      <input className="input" placeholder="http://127.0.0.1:4096" value={url} onChange={(e) => (setUrl(e.target.value), setOk(""))} spellCheck={false} autoCapitalize="off" />
      <div className="field-label">Username <em>· OpenCode's is opencode</em></div>
      <input className="input" value={user} onChange={(e) => setUser(e.target.value)} spellCheck={false} autoCapitalize="off" />
      <div className="field-label">Password <em>· OPENCODE_SERVER_PASSWORD</em></div>
      <input className="input" type="password" autoComplete="new-password" placeholder={editing && initial.hasPassword ? "Unchanged" : "The server's password"} value={password} onChange={(e) => setPassword(e.target.value)} />
      <div className="field-label">Folder for plain chats <em>· a full path on that machine</em></div>
      <input className="input" placeholder="/home/you" value={home} onChange={(e) => setHome(e.target.value)} spellCheck={false} autoCapitalize="off" />
      {ok && <div className="notice ok-note"><CircleCheck size={14} /> {ok}</div>}
      {error && <div className="notice err">{error}</div>}
      <div className="dialog-foot" style={{ padding: "16px 0 0", flexWrap: "wrap" }}>
        {editing && (
          <button type="button" className={"btn big" + (sure ? " danger" : "")} disabled={!!busy} onClick={remove} onBlur={() => setSure(false)}>
            {sure ? "Remove from HQ?" : "Remove"}
          </button>
        )}
        <span className="spacer" />
        <button type="button" className="btn big" onClick={onClose}>Cancel</button>
        <button type="button" className="btn big" disabled={!url || !!busy} onClick={test}>{busy === "test" && <LoaderCircle size={14} className="spin" />} Test</button>
        <button type="button" className="btn big primary" disabled={!label.trim() || !url || !home.trim() || !!busy} onClick={save}>
          {busy === "save" && <LoaderCircle size={14} className="spin" />} {editing ? "Save" : "Add"}
        </button>
      </div>
      <div className="vault-note" style={{ marginTop: 10 }}>HQ tests the connection before saving. Removing a machine only removes it from HQ: its chats stay on it.</div>
    </>
  );
}
