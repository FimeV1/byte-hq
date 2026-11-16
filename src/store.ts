// App state + everything that talks to the backends. Components read with useStore(selector)
// and call the exported actions. Updates are immutable, so a selector that returns an untouched
// slice keeps its identity and the component does not re-render.
import { useSyncExternalStore } from "react";
import { api, eventsUrl, hq } from "./api";
import type {
  AssistantMsg, Attachment, Backend, Form, TestResult, FileDiff, InboxItem, Model, ModelCheck, ModelChecks, MediaMakers, ModelRef, Msg, Part, PermissionRequest, PermissionRule, Project, SavedPrompt, Session, Space, UserMsg,
} from "./types";
import { spaceKey } from "./types";

/** An image or video being made (shown in the chat until it's done, or with what went wrong). */
export type MediaJob = { id: string; kind: "image" | "video"; prompt: string; started: number; error?: string };
export type MemoryFact = { id: string; text: string; at: number };
export type Persona = { id: string; name: string; instructions: string };
export const CHAT_AGENT = "hq-chat";
import { buildTurns, filesFromTools, viewTurn, type Turn } from "./turns";

export type Chat = {
  loaded: boolean;
  messages: Msg[];
  inbox: InboxItem[];
  permissions: PermissionRequest[];
  forms: Form[];
  /** Files changed per turn, keyed by the turn's first user message id. */
  diffs: Record<string, FileDiff[]>;
  /** Independent reviews of a turn's changes (a separate read-only chat), keyed like `diffs`. */
  reviews: Record<string, Review>;
  error?: string;
};

export type Review = { sid: string; model: ModelRef; label: string };

export type Conn = "connecting" | "open" | "down";

export type State = {
  ready: boolean;
  fatal?: string;
  appName: string;
  backends: Backend[];
  conn: Record<string, Conn>;
  projects: Project[];
  sessions: Record<string, Session[]>; // by spaceKey
  /** Folders known to be git repositories (a plain chat there can work on a copy), by spaceKey. */
  gitDirs: Record<string, boolean>;
  active: Record<string, boolean>; // session id -> a turn is running
  current: { space: Space; sessionId: string | null } | null;
  chat: Record<string, Chat>;
  models: Record<string, Model[]>;
  defaultModel: Record<string, ModelRef | undefined>;
  /** Choices for a chat that has not been created yet. */
  draft: { model?: ModelRef; allowAll: boolean; auto: boolean; copy: boolean; /** a plain chat with no tools (the Chat agent) */ chat: boolean; persona?: string; /** a Chat-mode chat may search the web */ web?: boolean };
  /** Last test result per copy chat (shown in the copy bar). */
  copyTests: Record<string, TestResult | "running">;
  /** What Auto chose for a chat's last message, e.g. "Main model · it's available". */
  autoNote: Record<string, string>;
  ui: { sidebar: boolean; panel: false | "browser" | "changes"; modal: null | "newProject" | "settings" | "newChat" | "vault" | "models" | "machine" | "byteHelp" | "prompts" | "personal" | "gallery"; modalBackend?: string; toast?: string; toastKind?: ToastKind };
  /** "Try it" results per machine (Settings › Models), and which providers HQ added there. */
  checks: Record<string, ModelChecks>;
  /** Saved prompts for the / menu (follow you between devices). */
  prompts: SavedPrompt[];
  /** Text to put in the message box (a saved prompt picked outside the box). */
  insertText: { text: string; at: number } | null;
  /** Per machine: which Byte API provider can make images / videos (its key has the permission). */
  makers: Record<string, MediaMakers>;
  /** Images and videos being made, per chat. */
  mediaJobs: Record<string, MediaJob[]>;
  /** Per machine: the Chat agent is there (true), or why it can't be (text). */
  chatAgent: Record<string, true | string>;
  /** Custom instructions ("about you and how to answer"), remembered facts and personas: on every device and chat. */
  about: string;
  memory: MemoryFact[];
  personas: Persona[];
  /** The chat an edit is being made in: the undo bar then says "Editing your message". */
  editing: string | null;
  /** Which answer is being read aloud (its turn key). */
  speaking: string | null;
  /** A chat laid out for printing (Print or save as PDF). */
  printing: { title: string; markdown: string } | null;
  /** HQ runs a shared browser the agent can drive (shown in the side pane). */
  hasBrowser: boolean;
  /** Kokoro voice for spoken replies, or null when the server has no voice set up. */
  voiceName: string | null;
  voiceOpen: boolean;
  /** Text to put back in the message box after an undo. */
  restoreDraft: { sessionId: string; text: string } | null;
  /** Bumped when the agent uses a browser tool in the open chat, so the pane can follow it. */
  browserActivity: number;
};

export const ALLOW_ALL: PermissionRule[] = [{ action: "*", resource: "*", effect: "allow" }];

const saved = (k: string) => {
  try {
    return JSON.parse(localStorage.getItem("hq." + k) || "null");
  } catch {
    return null;
  }
};
const save = (k: string, v: unknown) => localStorage.setItem("hq." + k, JSON.stringify(v));
// These follow you between devices: stored on the HQ server as well as in this browser.
const SYNCED = (k: string) =>
  k.startsWith("model.") || k === "voice" || k === "reviewsAsked" || k === "prompts" || k === "about" || k === "memory" || k === "personas";
let prefsTimer: number | undefined;
const pendingPrefs: Record<string, unknown> = {};
const savePref = (k: string, v: unknown) => {
  save(k, v);
  if (!SYNCED(k)) return;
  pendingPrefs[k] = v;
  window.clearTimeout(prefsTimer);
  prefsTimer = window.setTimeout(() => {
    const patch = { ...pendingPrefs };
    for (const key of Object.keys(pendingPrefs)) delete pendingPrefs[key];
    hq.savePrefs(patch).catch(() => {});
  }, 400);
};

export const isPhone = () => typeof window !== "undefined" && window.matchMedia("(max-width: 760px)").matches;
/** On a phone the sidebar covers the chat, so picking something closes it. */
const closeSidebarOnPhone = () => isPhone() && state.ui.sidebar && set((s) => ({ ui: { ...s.ui, sidebar: false } }));

let state: State = {
  ready: false,
  appName: "HQ",
  backends: [],
  conn: {},
  projects: [],
  sessions: {},
  gitDirs: {},
  active: {},
  current: null,
  chat: {},
  models: {},
  defaultModel: {},
  draft: { allowAll: false, auto: true, copy: true, chat: (saved("chatDefault") as boolean | null) ?? true },
  autoNote: {},
  copyTests: {},
  ui: { sidebar: isPhone() ? false : saved("sidebar") ?? true, panel: false, modal: null },
  hasBrowser: false,
  voiceName: null,
  voiceOpen: false,
  restoreDraft: null,
  browserActivity: 0,
  checks: {},
  prompts: [],
  insertText: null,
  makers: {},
  mediaJobs: {},
  chatAgent: {},
  about: "",
  memory: [],
  personas: [],
  editing: null,
  speaking: null,
  printing: null,
};

const listeners = new Set<() => void>();
export const getState = () => state;
/** Small direct updates from components (kept rare; prefer named actions). */
export const setState = (patch: Partial<State>) => set(patch);
function set(patch: Partial<State> | ((s: State) => Partial<State>)) {
  state = { ...state, ...(typeof patch === "function" ? patch(state) : patch) };
  listeners.forEach((l) => l());
}
export function useStore<T>(selector: (s: State) => T): T {
  return useSyncExternalStore(
    (cb) => (listeners.add(cb), () => listeners.delete(cb)),
    () => selector(state),
  );
}

const emptyChat = (): Chat => ({ loaded: false, messages: [], inbox: [], permissions: [], forms: [], diffs: {}, reviews: {} });
function setChat(id: string, fn: (c: Chat) => Chat) {
  const c = state.chat[id];
  if (!c) return;
  const next = fn(c);
  if (next !== c) set({ chat: { ...state.chat, [id]: next } });
}

let toastTimer: number | undefined;
/** error = red (something failed), ok = green (it worked), info = neutral. Red only ever means a failure (2026-11-15:
 * a success shown in red reads as a failure). */
export type ToastKind = "error" | "ok" | "info";
export function toast(message: string, kind: ToastKind = "error") {
  set((s) => ({ ui: { ...s.ui, toast: message, toastKind: kind } }));
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => set((s) => ({ ui: { ...s.ui, toast: undefined } })), 4000);
}
const fail = (what: string) => (e: unknown) => toast(`${what}: ${e instanceof Error ? e.message : String(e)}`);

// ---- lookups ------------------------------------------------------------------------------------

export function chatsSpace(backend: Backend): Space {
  return { backend: backend.id, directory: backend.chatsDir || backend.home || "/" };
}
export function projectSpace(p: Project): Space {
  return { backend: p.backend, directory: p.directory, projectId: p.id };
}
function findSession(id: string): { session: Session; key: string } | undefined {
  for (const [key, list] of Object.entries(state.sessions)) {
    const session = list.find((x) => x.id === id);
    if (session) return { session, key };
  }
}
export function currentSession(s: State = state): Session | undefined {
  const c = s.current;
  if (!c?.sessionId) return;
  const direct = s.sessions[spaceKey(c.space)]?.find((x) => x.id === c.sessionId);
  if (direct) return direct;
  // A chat in a folder of its own is listed under its machine, not under its own folder.
  for (const list of Object.values(s.sessions)) {
    const hit = list.find((x) => x.id === c.sessionId);
    if (hit) return hit;
  }
}
export function currentModel(s: State = state): ModelRef | undefined {
  const c = s.current;
  if (!c) return;
  if (!c.sessionId) return s.draft.model || s.defaultModel[c.space.backend];
  const ses = currentSession(s);
  if (ses?.model) return ses.model;
  const msgs = s.chat[c.sessionId]?.messages || [];
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i];
    if (m.type === "assistant") return m.model;
  }
  return s.defaultModel[c.space.backend];
}

/** The folder a chat is listed under: a copy chat belongs to the project it was copied from. */
const homeDir = (ses: Session) => ((ses.metadata?.hqCopy as { base?: string } | undefined)?.base) || ses.location.directory;

/** The sidebar list a chat in `directory` belongs to: its project's, or else its machine's (any other folder). */
function listKey(backend: string, directory: string): string {
  const p = state.projects.find((x) => x.backend === backend && x.directory === directory);
  if (p) return spaceKey(projectSpace(p));
  const b = state.backends.find((x) => x.id === backend);
  return spaceKey(b ? chatsSpace(b) : { backend, directory });
}

function upsertSession(ses: Session, backend: string) {
  const key = listKey(backend, homeDir(ses));
  // A chat that moved folder leaves its old list.
  for (const [k, l] of Object.entries(state.sessions)) {
    if (k !== key && l.some((x) => x.id === ses.id)) set({ sessions: { ...state.sessions, [k]: l.filter((x) => x.id !== ses.id) } });
  }
  if (!(key in state.sessions)) return; // a folder HQ is not showing
  const list = state.sessions[key];
  const next = list.some((x) => x.id === ses.id) ? list.map((x) => (x.id === ses.id ? ses : x)) : [ses, ...list];
  next.sort((a, b) => b.time.created - a.time.created);
  set({ sessions: { ...state.sessions, [key]: next } });
}
function patchSession(id: string, patch: Partial<Session>) {
  const f = findSession(id);
  if (!f) return;
  set({ sessions: { ...state.sessions, [f.key]: state.sessions[f.key].map((x) => (x.id === id ? { ...x, ...patch } : x)) } });
}
function dropSession(id: string) {
  const f = findSession(id);
  if (!f) return;
  const { [id]: _gone, ...chat } = state.chat;
  set({ sessions: { ...state.sessions, [f.key]: state.sessions[f.key].filter((x) => x.id !== id) }, chat });
  if (state.current?.sessionId === id) set({ current: { space: state.current.space, sessionId: null } });
}

// ---- startup ------------------------------------------------------------------------------------

export async function boot() {
  try {
    const [cfg, projects, prefs] = await Promise.all([hq.config(), hq.projects(), hq.prefs().catch(() => ({}) as Record<string, unknown>)]);
    // Server copies of synced preferences win over this browser's.
    for (const [k, v] of Object.entries(prefs)) if (SYNCED(k)) save(k, v);
    for (const id of (prefs.reviewsAsked as string[] | undefined) || []) askedReviews.add(id);
    document.title = cfg.name;
    set({
      prompts: (saved("prompts") as SavedPrompt[] | null) ?? EXAMPLE_PROMPTS,
      about: (saved("about") as string | null) ?? "",
      memory: (saved("memory") as MemoryFact[] | null) ?? [],
      personas: (saved("personas") as Persona[] | null) ?? EXAMPLE_PERSONAS,
    });
    set({ appName: cfg.name, hasBrowser: !!cfg.browser, voiceName: saved("voice") || cfg.voice?.voice || null, backends: cfg.backends, projects, conn: Object.fromEntries(cfg.backends.map((b) => [b.id, "connecting" as Conn])) });
    cfg.backends.forEach((b) => connect(b));
    cfg.backends.forEach((b) => void loadChecks(b.id));
    // Each machine gets 5 s before HQ opens: a machine that's off (a desktop overnight) must never keep the whole app
    // from loading. Whatever is still loading carries on in the background and fills in when it answers.
    const within = (p: Promise<unknown>) => Promise.race([p, new Promise((r) => setTimeout(r, 5000))]);
    await Promise.all([
      ...cfg.backends.map((b) => within(loadSpace(chatsSpace(b)))),
      ...projects.map((p) => within(loadSpace(projectSpace(p)))),
      ...cfg.backends.map((b) => within(loadBackend(b))),
    ]);
    // Opened from a notification: /?open={"backend","sid","dir"}
    let fromLink: { backend: string; sid: string; dir?: string } | null = null;
    try {
      const o = new URLSearchParams(location.search).get("open");
      if (o) fromLink = JSON.parse(o);
      if (o) history.replaceState(null, "", "/");
    } catch {
      fromLink = null;
    }
    if (fromLink) {
      set({ ready: true });
      return openLinked(fromLink);
    }
    const last = saved("current") as { space: Space; sessionId: string | null } | null;
    const lastOk = last && cfg.backends.some((b) => b.id === last.space.backend) && spaceKey(last.space) in state.sessions;
    set({ ready: true });
    if (lastOk && last.sessionId && findSession(last.sessionId)) openSession(last.space, last.sessionId);
    else if (cfg.backends[0]) newChat(lastOk ? last!.space : chatsSpace(cfg.backends[0]));
  } catch (e) {
    set({ fatal: e instanceof Error ? e.message : String(e) });
  }
}

async function loadBackend(b: Backend, attempt = 0): Promise<void> {
  const dir = chatsSpace(b).directory;
  try {
    const [models, def, active] = await Promise.all([api.models(b.id, dir), api.defaultModel(b.id, dir), api.active(b.id)]);
    set((s) => ({
      models: { ...s.models, [b.id]: models.filter((m) => m.enabled && (!m.type || m.type === "chat")) },
      // A model picked in HQ before beats the server's default, as long as the server still has it.
      defaultModel: {
        ...s.defaultModel,
        [b.id]: (() => {
          const pick = saved("model." + b.id) as ModelRef | null;
          if (pick && models.some((m) => m.id === pick.id && m.providerID === pick.providerID)) return pick;
          return def ? { id: def.id, providerID: def.providerID } : undefined;
        })(),
      },
      active: { ...s.active, ...Object.fromEntries(Object.keys(active).map((id) => [id, true])) },
    }));
  } catch {
    // A server's first request for a folder can fail while it loads that folder; try again a few times.
    if (attempt < 3) {
      await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
      return loadBackend(b, attempt + 1);
    }
  }
}

async function loadSpace(space: Space) {
  const key = spaceKey(space);
  const project = state.projects.find((p) => p.backend === space.backend && p.directory === space.directory);
  const b = state.backends.find((x) => x.id === space.backend);
  try {
    if (!project && b && chatsSpace(b).directory === space.directory) {
      // A machine's list: every chat on it that isn't in one of its projects, whatever folder it's in.
      const inProjects = new Set(state.projects.filter((p) => p.backend === space.backend).map((p) => p.directory));
      const list = (await api.allSessions(space.backend)).filter((s) => !inProjects.has(homeDir(s)));
      list.sort((a, b2) => b2.time.created - a.time.created);
      set((s) => ({ sessions: { ...s.sessions, [key]: list.filter((x) => !x.parentID && !x.time.archived) } }));
      return;
    }
    const list = await api.sessions(space.backend, space.directory);
    if (project) {
      // Copy chats run in a worktree elsewhere; show them under the project they came from.
      const all = await api.allSessions(space.backend).catch(() => [] as Session[]);
      for (const s of all) if (homeDir(s) === space.directory && !list.some((x) => x.id === s.id)) list.push(s);
    }
    list.sort((a, b) => b.time.created - a.time.created);
    set((s) => ({ sessions: { ...s.sessions, [key]: list.filter((x) => !x.parentID && !x.time.archived) } }));
  } catch {
    set((s) => ({ sessions: { ...s.sessions, [key]: s.sessions[key] || [] } }));
  }
}

// ---- live events --------------------------------------------------------------------------------

type Ev = { type: string; data: any };
const queue: { backend: string; ev: Ev }[] = [];
let scheduled = false;

// An EventSource retries by itself only while it is CONNECTING. Once the browser CLOSES it (Safari does this to a
// web app left in the background on the Mac, and on some server errors) it never comes back, so HQ looked dead
// until it was reopened. Reopen closed streams after a short wait, and whenever the window
// becomes visible again or the network returns.
const streams = new Map<string, { es: EventSource; b: Backend; retry?: number }>();

function reopen(b: Backend, delayMs: number) {
  const cur = streams.get(b.id);
  if (cur?.retry) return;
  const t = window.setTimeout(() => {
    const now = streams.get(b.id);
    if (now) now.retry = undefined;
    if (!now || now.es.readyState === EventSource.CLOSED) {
      now?.es.close();
      connect(b, true);
    }
  }, delayMs);
  if (cur) cur.retry = t;
}

function reopenClosed() {
  for (const { es, b } of streams.values()) if (es.readyState !== EventSource.OPEN) reopen(b, 0);
}
document.addEventListener("visibilitychange", () => document.visibilityState === "visible" && reopenClosed());
window.addEventListener("pageshow", reopenClosed);
window.addEventListener("online", reopenClosed);

function connect(b: Backend, missed = false) {
  const es = new EventSource(eventsUrl(b.id));
  streams.set(b.id, { es, b });
  let wasDown = missed;
  let failures = 0;
  es.onopen = () => {
    failures = 0;
    set((s) => ({ conn: { ...s.conn, [b.id]: "open" } }));
    if (wasDown) resync(b); // events were missed while disconnected
    wasDown = false;
  };
  es.onerror = () => {
    wasDown = true;
    set((s) => ({ conn: { ...s.conn, [b.id]: "down" } }));
    // Closed for good: reopen it ourselves, backing off to 30 s while the machine stays unreachable.
    if (es.readyState === EventSource.CLOSED) reopen(b, Math.min(30_000, 2000 * 2 ** failures++));
  };
  es.onmessage = (m) => {
    try {
      queue.push({ backend: b.id, ev: JSON.parse(m.data) });
    } catch {
      return;
    }
    // Apply a whole animation frame's worth of events in one update: a fast model sends many
    // small deltas, and one render per frame keeps typing and scrolling smooth.
    if (!scheduled) {
      scheduled = true;
      requestAnimationFrame(flush);
    }
  };
}

function flush() {
  scheduled = false;
  const batch = queue.splice(0);
  const before = state;
  const held = [...listeners];
  listeners.clear(); // hold notifications until the whole batch is applied
  try {
    for (const { backend, ev } of batch) {
      try {
        applyEvent(backend, ev);
      } catch (e) {
        console.error("event failed", ev.type, e);
      }
    }
  } finally {
    held.forEach((l) => listeners.add(l));
  }
  if (state !== before) listeners.forEach((l) => l());
}

async function resync(b: Backend) {
  await loadBackend(b);
  for (const key of Object.keys(state.sessions)) {
    const [backend, directory] = [key.slice(0, key.indexOf("|")), key.slice(key.indexOf("|") + 1)];
    if (backend === b.id) loadSpace({ backend, directory });
  }
  const c = state.current;
  if (c?.sessionId && c.space.backend === b.id) reloadChat(c.space.backend, c.sessionId);
}

const refetchTimers: Record<string, number> = {};
function refetchSoon(backend: string, sid: string) {
  window.clearTimeout(refetchTimers[sid]);
  refetchTimers[sid] = window.setTimeout(() => reloadChat(backend, sid), 250);
}

function mapAssistant(sid: string, mid: string, fn: (m: AssistantMsg) => AssistantMsg) {
  setChat(sid, (c) => {
    const i = c.messages.findIndex((m) => m.id === mid);
    if (i < 0 || c.messages[i].type !== "assistant") return c;
    const messages = c.messages.slice();
    messages[i] = fn(messages[i] as AssistantMsg);
    return { ...c, messages };
  });
}
/** The n-th part of one kind: the API numbers text and reasoning parts separately ("ordinal"). */
function mapNth(content: Part[], kind: "text" | "reasoning", ordinal: number, fn: (p: any) => Part): Part[] {
  let n = -1;
  return content.map((p) => (p.type === kind && ++n === ordinal ? fn(p) : p));
}
function mapTool(content: Part[], id: string, fn: (p: Extract<Part, { type: "tool" }>) => Part): Part[] {
  return content.map((p) => (p.type === "tool" && p.id === id ? fn(p) : p));
}

const usesBrowser = (input: unknown) => /\bbrowser_[a-z_]+\s*\(/.test(typeof input === "string" ? input : JSON.stringify(input ?? ""));

/** When each chat last showed any sign of life (streamed text, a tool, a status change): spots a stuck model. */
const lastActivity = new Map<string, number>();
export const lastActivityAt = (sid?: string | null) => (sid ? lastActivity.get(sid) : undefined);

function applyEvent(backend: string, ev: Ev) {
  const d = ev.data || {};
  // Most events carry sessionID at the top; form events nest it in `form`.
  const sid: string | undefined = d.sessionID ?? d.form?.sessionID;
  const t = ev.type;
  if (sid) lastActivity.set(sid, Date.now());

  // ---- things that matter for every chat (sidebar state) ----
  if (t === "session.created") {
    api
      .session(backend, sid!)
      .then((s) => {
        if (!s.parentID) return upsertSession(s, backend);
        // A review chat (started by Auto or the review card): show it under its turn, live.
        const turn = s.metadata?.turn;
        if (s.metadata?.hqReview && typeof turn === "string" && state.chat[s.parentID]) {
          set((st) => ({ chat: { ...st.chat, [s.id]: { ...emptyChat(), loaded: true } }, active: { ...st.active, [s.id]: true } }));
          setChat(s.parentID, (c) => ({ ...c, reviews: { ...c.reviews, [turn]: { sid: s.id, model: s.model || { id: "", providerID: "" }, label: String(s.metadata?.label || "Reviewer") } } }));
          reloadChat(backend, s.id);
        }
      })
      .catch(() => {});
    return;
  }
  if (t === "session.renamed") return patchSession(sid!, { title: d.title });
  if (t === "session.deleted" || t === "session.archived") return dropSession(sid!);
  if (t === "session.execution.started") return set({ active: { ...state.active, [sid!]: true } });
  if (t === "session.execution.succeeded" || t === "session.execution.failed" || t === "session.execution.interrupted") {
    set({ active: { ...state.active, [sid!]: false } });
    api.session(backend, sid!).then((s) => !s.parentID && upsertSession(s, backend)).catch(() => {});
    if (state.chat[sid!]?.loaded) reloadChat(backend, sid!);
    return;
  }
  if (t === "session.model.selected" || t === "session.forked" || t === "session.moved" || t.startsWith("session.revert.")) {
    if (t === "session.revert.committed" && sid && state.chat[sid]?.loaded) refetchSoon(backend, sid);
    if (sid) api.session(backend, sid).then((s) => !s.parentID && upsertSession(s, backend)).catch(() => {});
    return;
  }
  if (!sid || !state.chat[sid]?.loaded) return;

  // ---- the open chat ----
  const mid: string = d.assistantMessageID;
  switch (t) {
    case "session.inbox.enqueued":
      return setChat(sid, (c) =>
        c.inbox.some((i) => i.id === d.inboxID)
          ? c
          : { ...c, inbox: [...c.inbox, { id: d.inboxID, sessionID: sid, time: { created: Date.now() }, ...d.item }] },
      );
    case "session.inbox.delivered":
      return setChat(sid, (c) => {
        const item = c.inbox.find((i) => i.id === d.inboxID);
        const inbox = c.inbox.filter((i) => i.id !== d.inboxID);
        if (c.messages.some((m) => m.id === d.inboxID)) return { ...c, inbox };
        const media = item?.type === "synthetic" ? item.payload?.metadata?.hqMedia : undefined;
        if (item && media) {
          // Before the prompt it was sent with (that one is often already on screen as a pending copy).
          const syn: Msg = { type: "synthetic", id: item.id, time: item.time, text: item.payload?.text, metadata: { hqMedia: media } };
          const at = c.messages.findIndex((m) => m.type === "user" && m.pending);
          const messages = c.messages.slice();
          messages.splice(at >= 0 ? at : messages.length, 0, syn);
          return { ...c, inbox, messages };
        }
        if (item && item.type !== "user") return { ...c, inbox };
        const text = item?.payload?.text;
        if (text === undefined || (item?.payload as { files?: unknown[] } | undefined)?.files?.length) {
          refetchSoon(backend, sid);
          return { ...c, inbox };
        }
        const user: UserMsg = { type: "user", id: d.inboxID, time: { created: Date.now() }, text };
        // Replace the optimistic copy (same text, still pending) if there is one.
        // startsWith: Auto may append a picture's description for a model that can't see images (auto.mjs).
        const i = c.messages.findIndex((m) => m.type === "user" && m.pending && (m.text === text || (!!m.text && text.startsWith(m.text))));
        const messages = c.messages.slice();
        // Keep the moment Send was pressed: in Auto the model is picked first, and taking the delivery time
        // made "Working for…" jump back to 0 a couple of seconds in.
        if (i >= 0) messages[i] = { ...user, time: messages[i].time };
        else messages.push(user);
        return { ...c, inbox, messages };
      });
    case "session.inbox.cancelled":
      return setChat(sid, (c) => ({ ...c, inbox: c.inbox.filter((i) => i.id !== d.inboxID) }));
    case "session.inbox.delivery.changed":
      api.inbox(backend, sid).then((inbox) => setChat(sid, (c) => ({ ...c, inbox }))).catch(() => {});
      return;

    case "session.step.started":
      return setChat(sid, (c) =>
        c.messages.some((m) => m.id === mid)
          ? c
          : {
              ...c,
              messages: [...c.messages, { type: "assistant", id: mid, time: { created: d.started || Date.now() }, agent: d.agent, model: d.model, content: [] }],
            },
      );
    case "session.text.started":
      return mapAssistant(sid, mid, (m) => ({ ...m, content: [...m.content, { type: "text", text: "" }] }));
    case "session.reasoning.started":
      return mapAssistant(sid, mid, (m) => ({ ...m, content: [...m.content, { type: "reasoning", text: "", time: { created: Date.now() } }] }));
    case "session.text.delta":
      return mapAssistant(sid, mid, (m) => ({ ...m, content: mapNth(m.content, "text", d.ordinal, (p) => ({ ...p, text: p.text + d.delta })) }));
    case "session.reasoning.delta":
      return mapAssistant(sid, mid, (m) => ({ ...m, content: mapNth(m.content, "reasoning", d.ordinal, (p) => ({ ...p, text: p.text + d.delta })) }));
    case "session.text.ended":
      return mapAssistant(sid, mid, (m) => ({ ...m, content: mapNth(m.content, "text", d.ordinal, (p) => ({ ...p, text: d.text })) }));
    case "session.reasoning.ended":
      return mapAssistant(sid, mid, (m) => ({
        ...m,
        content: mapNth(m.content, "reasoning", d.ordinal, (p) => ({ ...p, text: d.text, time: { ...(p.time || { created: Date.now() }), completed: Date.now() } })),
      }));

    case "session.tool.input.started":
      return mapAssistant(sid, mid, (m) => ({
        ...m,
        content: [...m.content, { type: "tool", id: d.id, name: d.name, state: { status: "streaming", input: "" }, time: { created: Date.now() } }],
      }));
    case "session.tool.input.delta":
      return mapAssistant(sid, mid, (m) => ({
        ...m,
        content: mapTool(m.content, d.id, (p) => (p.state.status === "streaming" ? { ...p, state: { status: "streaming", input: p.state.input + (d.delta || "") } } : p)),
      }));
    case "session.tool.input.ended":
      return mapAssistant(sid, mid, (m) => ({
        ...m,
        content: mapTool(m.content, d.id, (p) => (p.state.status === "streaming" ? { ...p, state: { status: "streaming", input: d.text || "" } } : p)),
      }));
    case "session.tool.called":
      // MCP tools run inside OpenCode's code-mode `execute` tool, so look at the script it runs.
      if (state.hasBrowser && state.current?.sessionId === sid && usesBrowser(d.input)) {
        set((s) => ({ browserActivity: s.browserActivity + 1, ui: { ...s.ui, panel: "browser" } }));
      }
      return mapAssistant(sid, mid, (m) => ({
        ...m,
        content: mapTool(m.content, d.id, (p) => ({ ...p, state: { status: "running", input: d.input || {}, metadata: {} }, time: { ...p.time, ran: Date.now() } })),
      }));
    case "session.tool.progress":
      return mapAssistant(sid, mid, (m) => ({
        ...m,
        content: mapTool(m.content, d.id, (p) =>
          p.state.status === "running" ? { ...p, state: { ...p.state, metadata: { ...p.state.metadata, ...d.metadata } } } : p,
        ),
      }));
    case "session.tool.success":
      return mapAssistant(sid, mid, (m) => ({
        ...m,
        content: mapTool(m.content, d.id, (p) => ({
          ...p,
          state: { status: "completed", input: typeof p.state.input === "string" ? {} : p.state.input, content: d.content, metadata: d.metadata },
          time: { ...p.time, completed: Date.now() },
        })),
      }));
    case "session.tool.failed":
      return mapAssistant(sid, mid, (m) => ({
        ...m,
        content: mapTool(m.content, d.id, (p) => ({
          ...p,
          state: { status: "error", input: typeof p.state.input === "string" ? {} : p.state.input, error: d.error || { type: "error", message: "Tool failed" } },
          time: { ...p.time, completed: Date.now() },
        })),
      }));

    case "session.step.ended":
    case "session.step.failed":
      // Swap the streamed copy for the stored one (final tokens, snapshot, error), then refresh
      // the turn's file list if this step touched files.
      api
        .message(backend, sid, mid)
        .then((msg) => {
          setChat(sid, (c) => ({ ...c, messages: c.messages.map((m) => (m.id === mid ? msg : m)) }));
          if (msg.type === "assistant") refreshTurnDiff(backend, sid, mid);
        })
        .catch(() => {});
      return;

    case "permission.asked":
      return setChat(sid, (c) => (c.permissions.some((p) => p.id === d.id) ? c : { ...c, permissions: [...c.permissions, d] }));
    case "form.created":
    case "form.replied":
    case "form.cancelled":
      api.forms(backend, sid).then((forms) => setChat(sid, (c) => ({ ...c, forms }))).catch(() => {});
      return;
    case "permission.replied":
      return setChat(sid, (c) => ({ ...c, permissions: c.permissions.filter((p) => p.id !== d.requestID) }));

    case "session.step.streamed":
    case "session.usage.updated":
    case "session.usage.recorded":
    case "session.instructions.updated":
    case "session.viewed":
      return;
    default:
      // Anything else that changes the transcript (shell, compaction, skills, reverts...):
      // re-read it rather than model every event.
      if (t.startsWith("session.")) refetchSoon(backend, sid);
  }
}

// ---- chats --------------------------------------------------------------------------------------

/** A copy chat whose copy was applied or discarded: its folder is gone. */
function finishedCopy(sid: string): boolean {
  const copy = findSession(sid)?.session.metadata?.hqCopy as { applied?: string; discarded?: boolean } | undefined;
  return !!(copy?.applied || copy?.discarded);
}
async function reloadChat(backend: string, sid: string) {
  try {
    const [messages, inbox, permissions, forms] = await Promise.all([
      // Only the messages decide whether the chat exists. A copy chat whose copy was applied or discarded has no folder
      // any more, and OpenCode answers 404 for its permissions/forms/inbox: that hid the chat as "no longer exists" (2026-11-15).
      api.messages(backend, sid),
      api.inbox(backend, sid).catch(() => [] as InboxItem[]),
      // A finished copy can't be waiting for an answer, and asking only logs two 404s in the console: skip it.
      finishedCopy(sid) ? ([] as PermissionRequest[]) : api.permissions(backend, sid).catch(() => [] as PermissionRequest[]),
      finishedCopy(sid) ? ([] as Form[]) : api.forms(backend, sid).catch(() => [] as Form[]),
    ]);
    if (!state.chat[sid]) return;
    setChat(sid, (c) => {
      // A message just sent sits in the server's inbox until the model starts, so it isn't in `messages` yet.
      // Replacing the list wholesale made it vanish for a few seconds and come back on delivery (2026-11-15).
      // Keep the on-screen copy, and hide its inbox row (a pending copy only exists when the chat was idle,
      // so that item is about to be delivered, not queued behind other work).
      const same = (a?: string, b?: string) => !!a && !!b && (a === b || b.startsWith(a));
      const pending = c.messages.filter(
        (m): m is UserMsg => m.type === "user" && !!m.pending && !messages.some((x) => x.type === "user" && same(m.text, x.text)),
      );
      const shown = inbox.filter((i) => !pending.some((p) => same(p.text, i.payload?.text)));
      return { ...c, loaded: true, error: undefined, messages: [...messages, ...pending], inbox: shown, permissions, forms };
    });
    loadDiffs(backend, sid);
    loadReviews(backend, sid);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // The chat was deleted (on another device, or a test chat a notification pointed at): don't leave an error
    // page where the app opens; start a new chat in the same folder and say why.
    if (/not found/i.test(msg) && state.current?.sessionId === sid) {
      const space = state.current.space;
      set((s) => { const chat = { ...s.chat }; delete chat[sid]; return { chat }; });
      dropSession(sid);
      newChat(space);
      return toast("That chat no longer exists, so here's a new one in the same folder.", "info");
    }
    setChat(sid, (c) => ({ ...c, loaded: true, error: msg }));
  }
}

/** Fetch the changed-file list of every turn that touched files (newest 30 turns). */
function loadDiffs(backend: string, sid: string) {
  const c = state.chat[sid];
  if (!c) return;
  for (const turn of buildTurns(c.messages).slice(-30)) if (turn.userId && turn.touchedFiles) fetchTurnDiff(backend, sid, turn);
}
function refreshTurnDiff(backend: string, sid: string, assistantId: string) {
  const c = state.chat[sid];
  if (!c) return;
  const turn = buildTurns(c.messages).find((t) => t.items.some((m) => m.id === assistantId));
  if (turn?.userId && turn.touchedFiles) fetchTurnDiff(backend, sid, turn);
}
function fetchTurnDiff(backend: string, sid: string, turn: Turn) {
  const session = findSession(sid)?.session;
  const put = (files: FileDiff[]) => setChat(sid, (x) => ({ ...x, diffs: { ...x.diffs, [turn.userId!]: files } }));
  // A copy that was applied or discarded has no folder any more: the snapshot diff can only fail (a 500 in the console).
  const copy = session?.metadata?.hqCopy as { applied?: string; discarded?: boolean } | undefined;
  if (copy?.applied || copy?.discarded) return put(filesFromTools(turn));
  api
    .turnDiff(backend, sid, turn.userId!)
    // Nothing from the snapshot diff (not a git repository, or ignored files): use the edits themselves.
    .then((files) => put(files.length || turn.snapshotMoved ? relativise(files, session) : filesFromTools(turn)))
    .catch(() => put(filesFromTools(turn)));
}
/** The API reports paths from the repository root; show them from the chat's own folder. */
function relativise(files: FileDiff[], session?: Session): FileDiff[] {
  const prefix = session?.subpath ? session.subpath.replace(/\/?$/, "/") : "";
  return files.map((f) => (prefix && f.file.startsWith(prefix) ? { ...f, file: f.file.slice(prefix.length) } : f));
}

// ---- independent review of a turn's changes ----------------------------------------------------
// The HQ server (auto.mjs) runs reviews: a fresh read-only child chat that sees only the request and
// the diff. Here we only find them and show them.

/** Find reviews made earlier (they live on the server as child chats). */
async function loadReviews(backend: string, sid: string) {
  try {
    const kids = (await api.children(backend, sid)).filter((k) => k.metadata?.hqReview && typeof k.metadata.turn === "string");
    if (!kids.length) return;
    const reviews: Record<string, Review> = {};
    for (const k of kids) {
      reviews[k.metadata!.turn as string] = { sid: k.id, model: k.model || { id: "", providerID: "" }, label: String(k.metadata!.label || "Reviewer") };
      if (!state.chat[k.id]) set((s) => ({ chat: { ...s.chat, [k.id]: emptyChat() } }));
      reloadChat(backend, k.id);
    }
    setChat(sid, (c) => ({ ...c, reviews: { ...c.reviews, ...reviews } }));
  } catch {
    /* reviews are optional */
  }
}

/** The review card's Yes: the server reviews with Auto's model choice (main model if free, else the fallback). */
export async function startReview(turnUserId: string) {
  const c = state.current;
  if (!c?.sessionId) return;
  markReviewAsked(turnUserId);
  try {
    await hq.autoReview(c.space.backend, c.sessionId, turnUserId);
  } catch (e) {
    fail("Could not start the review")(e);
  }
}

/** Turns you already said yes or no to, so the question isn't asked again. */
const askedReviews = new Set<string>((saved("reviewsAsked") as string[] | null) || []);
export const reviewAsked = (turnUserId: string) => askedReviews.has(turnUserId);
export function markReviewAsked(turnUserId: string) {
  askedReviews.add(turnUserId);
  savePref("reviewsAsked", [...askedReviews].slice(-500));
  set({}); // re-render
}

/** Open a chat named by a notification link, in its project if it belongs to one. */
export async function openLinked(o: { backend: string; sid: string; dir?: string }) {
  const b = state.backends.find((x) => x.id === o.backend);
  if (!b) return;
  const p = state.projects.find((x) => x.backend === o.backend && x.directory === o.dir);
  const space = p ? projectSpace(p) : o.dir ? { backend: o.backend, directory: o.dir } : chatsSpace(b);
  if (!(spaceKey(space) in state.sessions)) await loadSpace(space);
  openSession(space, o.sid);
}
if (typeof navigator !== "undefined" && "serviceWorker" in navigator) {
  navigator.serviceWorker.addEventListener("message", (e) => {
    if (e.data?.type !== "hq-open") return;
    try {
      const o = new URL(e.data.url).searchParams.get("open");
      if (o) openLinked(JSON.parse(o));
    } catch { /* ignore */ }
  });
}

export function openSession(listSpace: Space, sessionId: string) {
  // A chat listed under its machine but working in another folder opens in that folder (paths, models, new chats).
  const ses = findSession(sessionId)?.session;
  const space = !listSpace.projectId && ses && homeDir(ses) !== listSpace.directory ? { backend: listSpace.backend, directory: homeDir(ses) } : listSpace;
  closeSidebarOnPhone();
  set({ current: { space, sessionId }, chat: state.chat[sessionId] ? state.chat : { ...state.chat, [sessionId]: emptyChat() } });
  save("current", { space, sessionId });
  if (!state.chat[sessionId].loaded) reloadChat(space.backend, sessionId);
}

export function newChat(space?: Space) {
  closeSidebarOnPhone();
  const target = space || state.current?.space || (state.backends[0] && chatsSpace(state.backends[0]));
  if (!target) return;
  set({ current: { space: target, sessionId: null }, draft: { ...state.draft, allowAll: false, auto: (saved("autoDefault") as boolean | null) ?? true } });
  save("current", { space: target, sessionId: null });
  checkGit(target);
}

/** A plain chat in a git repository gets the same "On a copy" option as a project (a model can't touch live code). */
export function checkGit(space: Space) {
  const key = spaceKey(space);
  if (space.projectId || key in state.gitDirs) return;
  hq.copyIsGit(space.backend, space.directory)
    .then((r) => set((s) => ({ gitDirs: { ...s.gitDirs, [key]: r.git } })))
    .catch(() => {});
}
export const draftCanCopy = (s: State) =>
  !!s.current && !s.current.sessionId && !isChatMode(s) && (!!s.current.space.projectId || !!s.gitDirs[spaceKey(s.current.space)]);

// ---- plain chat (no tools) ------------------------------------------------------------------------
/** The open chat (or the new one about to start) is a plain chat: the Chat agent, no tools, no files. Projects never are. */
export function isChatMode(s: State = state): boolean {
  const cur = s.current;
  if (!cur || cur.space.projectId) return false;
  if (cur.sessionId) return currentSession(s)?.agent === CHAT_AGENT;
  return s.draft.chat && typeof s.chatAgent[cur.space.backend] !== "string"; // a text = not available on this machine
}
/** Make sure the machine has the Chat agent (HQ adds it to its own OpenCode settings file the first time). */
async function chatAgentReady(backend: string): Promise<boolean> {
  const known = state.chatAgent[backend];
  if (known === true) return true;
  if (typeof known === "string") return false;
  const r = await hq.chatAgent(backend).catch((e) => ({ ok: false, reason: e.message as string }));
  set((s) => ({ chatAgent: { ...s.chatAgent, [backend]: r.ok ? true : r.reason || "not available" } }));
  if (!r.ok) toast(`Plain chat isn't available here: ${r.reason}. Using the coding agent.`, "info");
  return r.ok;
}
/** Chat (no tools) or Agent (tools, files, commands) for a plain chat; remembered as the default for new ones. */
export async function setChatMode(on: boolean) {
  const cur = state.current;
  if (!cur || cur.space.projectId) return;
  save("chatDefault", on);
  if (!cur.sessionId) return set({ draft: { ...state.draft, chat: on } });
  if (on && !(await chatAgentReady(cur.space.backend))) return;
  const agent = on ? CHAT_AGENT : "build";
  await api.setAgent(cur.space.backend, cur.sessionId, agent).catch(fail("Could not switch"));
  patchSession(cur.sessionId, { agent });
}

/** The open chat's id, creating the chat on the server first if it is still a draft. */
export async function ensureSession(): Promise<string | null> {
  const cur = state.current;
  if (!cur) return null;
  if (cur.sessionId) return cur.sessionId;
  const backend = cur.space.backend;
  const model = state.draft.model || state.defaultModel[backend];
  const chat = !cur.space.projectId && state.draft.chat && (await chatAgentReady(backend));
  const ses = await api.createSession(backend, {
    location: { directory: cur.space.directory },
    ...(model ? { model } : {}),
    ...(chat ? { agent: CHAT_AGENT } : {}),
    ...(state.draft.allowAll ? { permissions: ALLOW_ALL } : chat && state.draft.web ? { permissions: WEB_RULES } : {}),
    ...(state.draft.auto || state.draft.persona
      ? { metadata: { ...(state.draft.auto ? { hqAuto: true } : {}), ...(state.draft.persona ? { hqPersona: state.draft.persona } : {}) } }
      : {}),
  });
  const key = listKey(backend, cur.space.directory);
  set((s) => ({
    sessions: { ...s.sessions, [key]: [ses, ...(s.sessions[key] || []).filter((x) => x.id !== ses.id)] },
    chat: { ...s.chat, [ses.id]: { ...emptyChat(), loaded: true } },
    current: { space: cur.space, sessionId: ses.id },
  }));
  save("current", { space: cur.space, sessionId: ses.id });
  return ses.id;
}

export async function sendPrompt(text: string, attachments: Attachment[] = []) {
  const cur = state.current;
  if (!cur || (!text.trim() && !attachments.length)) return;
  const auto = isAuto(); // decided before a new chat is created
  if (state.editing) set({ editing: null });
  const files = attachments.map((a) => ({ uri: a.dataUrl, name: a.name }));
  const backend = cur.space.backend;
  let sid = cur.sessionId;
  try {
    if (!sid && draftCanCopy(state) && state.draft.copy) sid = await startCopy();
    if (!sid) sid = await ensureSession();
    if (!sid) return;
    const busy = !!state.active[sid];
    if (!busy) {
      // Show the message at once; the delivered event swaps in the stored copy.
      const pending: UserMsg = {
        type: "user", id: "pending_" + Date.now(), time: { created: Date.now() }, text, pending: true,
        files: attachments.map((a) => ({ name: a.name, mime: a.mime, data: a.dataUrl.slice(a.dataUrl.indexOf(",") + 1) })),
      };
      setChat(sid, (c) => ({ ...c, messages: [...c.messages, pending] }));
      set({ active: { ...state.active, [sid]: true } });
    }
    await syncInstructions(backend, sid); // custom instructions, memory and persona, as this chat's context
    if (auto && !busy) {
      // Auto: the HQ server picks the main or fallback model, then sends (and reviews when it's done).
      set((s) => ({ autoNote: { ...s.autoNote, [sid!]: "Choosing a model… (if the main model has to start, this can take a few minutes)" } }));
      const r = await hq.autoSend(backend, sid, text, files);
      set((s) => ({ autoNote: { ...s.autoNote, [sid!]: `${r.label} · ${r.why}` } }));
    } else await api.prompt(backend, sid, text, busy ? "queue" : undefined, files);
  } catch (e) {
    if (sid) set((s) => ({ autoNote: { ...s.autoNote, [sid!]: "" } }));
    if (sid) {
      setChat(sid, (c) => ({ ...c, messages: c.messages.filter((m) => !(m.type === "user" && m.pending)) }));
      set({ active: { ...state.active, [sid]: false } });
    }
    fail("Could not send")(e);
    throw e;
  }
}

export function stop() {
  const c = state.current;
  if (c?.sessionId) api.interrupt(c.space.backend, c.sessionId).catch(fail("Could not stop"));
}

/** Running: deliver after the current step instead of after the whole turn. Idle: send it now. */
export async function steerNow(item: InboxItem) {
  const c = state.current;
  if (!c) return;
  const b = c.space.backend;
  try {
    if (item.delivery !== "steer") await api.setDelivery(b, item.sessionID, item.id, "steer");
    if (!state.active[item.sessionID]) await api.resume(b, item.sessionID);
  } catch (e) {
    fail("Could not send")(e);
  }
}
export function cancelQueued(item: InboxItem) {
  const c = state.current;
  if (!c) return;
  setChat(item.sessionID, (x) => ({ ...x, inbox: x.inbox.filter((i) => i.id !== item.id) }));
  api.cancelInbox(c.space.backend, item.sessionID, item.id).catch(fail("Could not remove"));
}

export function answerForm(form: Form, answer: Record<string, unknown> | null) {
  const c = state.current;
  if (!c) return;
  setChat(form.sessionID, (x) => ({ ...x, forms: x.forms.filter((f) => f.id !== form.id) }));
  (answer ? api.replyForm(c.space.backend, form.sessionID, form.id, answer) : api.cancelForm(c.space.backend, form.sessionID, form.id)).catch(
    fail("Could not send the answer"),
  );
}

export function replyPermission(req: PermissionRequest, decision: "once" | "always" | "reject") {
  const c = state.current;
  if (!c) return;
  setChat(req.sessionID, (x) => ({ ...x, permissions: x.permissions.filter((p) => p.id !== req.id) }));
  api.replyPermission(c.space.backend, req.sessionID, req.id, decision).catch(fail("Could not answer"));
}

/** New chat in a project with "Work on a copy" on: HQ makes the copy and a chat inside it. */
async function startCopy(): Promise<string | null> {
  const cur = state.current;
  if (!cur) return null;
  const backend = cur.space.backend;
  const model = state.draft.model || state.defaultModel[backend];
  try {
    const ses = await hq.copyStart(backend, cur.space.directory, {
      auto: state.draft.auto, ...(model ? { model } : {}), ...(state.draft.allowAll ? { permissions: ALLOW_ALL } : {}),
    });
    const key = listKey(backend, cur.space.directory);
    set((s) => ({
      sessions: { ...s.sessions, [key]: [ses, ...(s.sessions[key] || []).filter((x) => x.id !== ses.id)] },
      chat: { ...s.chat, [ses.id]: { ...emptyChat(), loaded: true } },
      current: { space: cur.space, sessionId: ses.id },
    }));
    save("current", { space: cur.space, sessionId: ses.id });
    // The copy is made on the HQ server, which knows nothing of personas: add the one picked for this draft here.
    if (state.draft.persona) await setSessionMeta(backend, ses.id, { hqPersona: state.draft.persona }).catch(() => {});
    return ses.id;
  } catch (e) {
    toast(`Working directly, not on a copy: ${e instanceof Error ? e.message : e}`);
    return null;
  }
}

export const setDraftCopy = (copy: boolean) => set({ draft: { ...state.draft, copy } });

export async function testCopy() {
  const c = state.current;
  if (!c?.sessionId) return;
  const sid = c.sessionId;
  set((s) => ({ copyTests: { ...s.copyTests, [sid]: "running" } }));
  try {
    const r = await hq.copyTest(c.space.backend, sid);
    set((s) => ({ copyTests: { ...s.copyTests, [sid]: r } }));
    patchSession(sid, { metadata: { ...(currentSession()?.metadata || {}), hqTest: { ok: r.ok, at: r.at, summary: r.summary } } });
  } catch (e) {
    set((s) => { const { [sid]: _x, ...rest } = s.copyTests; return { copyTests: rest }; });
    fail("Could not run the tests")(e);
  }
}

export async function applyCopy() {
  const c = state.current;
  if (!c?.sessionId) return;
  try {
    const r = await hq.copyApply(c.space.backend, c.sessionId);
    const meta = currentSession()?.metadata || {};
    patchSession(c.sessionId, { metadata: { ...meta, hqAuto: false, hqCopy: { ...(meta.hqCopy as object), applied: r.commit, ...(r.restart?.length ? { restart: r.restart } : {}) } } });
    toast(`Applied to live: commit ${r.commit} (${r.files.length} file${r.files.length === 1 ? "" : "s"}).${r.restart?.length ? " Restart the services below to load it." : ""}`, "ok");
  } catch (e) {
    fail("Not applied")(e);
  }
}

/** Restart the services an applied copy touched (the server runs the project's safety check first). */
export async function restartCopy() {
  const c = state.current;
  if (!c?.sessionId) return;
  const sid = c.sessionId;
  try {
    const r = await hq.copyRestart(c.space.backend, sid);
    const meta = currentSession()?.metadata || {};
    patchSession(sid, { metadata: { ...meta, hqCopy: { ...(meta.hqCopy as object), restarted: { at: Date.now(), ok: r.ok, summary: r.summary } } } });
    toast(r.summary, r.ok ? "ok" : "error");
  } catch (e) {
    fail("Not restarted")(e);
  }
}

export async function discardCopy() {
  const c = state.current;
  if (!c?.sessionId) return;
  try {
    await hq.copyDiscard(c.space.backend, c.sessionId);
    const meta = currentSession()?.metadata || {};
    patchSession(c.sessionId, { metadata: { ...meta, hqAuto: false, hqCopy: { ...(meta.hqCopy as object), discarded: true } } });
  } catch (e) {
    fail("Could not discard")(e);
  }
}

export function setProjectTest(id: string, test: string) {
  const projects = state.projects.map((p) => (p.id === id ? { ...p, test: test.trim() || undefined } : p));
  set({ projects });
  hq.saveProjects(projects).catch(fail("Could not save"));
}

/** Auto mode for the open chat: HQ picks the model and reviews the work (auto.mjs on the server). */
export function isAuto(s: State = state): boolean {
  const c = s.current;
  if (!c) return false;
  if (!c.sessionId) return s.draft.auto;
  return currentSession(s)?.metadata?.hqAuto === true;
}
export function setAuto(on: boolean) {
  const c = state.current;
  if (!c) return;
  save("autoDefault", on);
  if (!c.sessionId) return set({ draft: { ...state.draft, auto: on } });
  const sid = c.sessionId;
  patchSession(sid, { metadata: { ...(currentSession()?.metadata || {}), hqAuto: on } });
  // Merge into the server's current metadata, not this tab's copy: OpenCode replaces metadata as a whole, and a
  // stale copy without hqCopy wiped it, so the copy chat vanished from its project after a reload.
  api
    .session(c.space.backend, sid)
    .then((fresh) => {
      const meta = { ...(fresh.metadata || {}), hqAuto: on };
      patchSession(sid, { metadata: meta });
      return api.updateSession(c.space.backend, sid, { metadata: meta });
    })
    .catch(fail("Could not change Auto"));
}

export function chooseModel(model: ModelRef) {
  const c = state.current;
  if (!c) return;
  if (isAuto()) setAuto(false); // picking a model by hand turns Auto off for this chat
  // Remember it: new chats on this server start with the last model chosen.
  savePref("model." + c.space.backend, model);
  set({ defaultModel: { ...state.defaultModel, [c.space.backend]: model } });
  if (!c.sessionId) {
    set({ draft: { ...state.draft, model } });
    return;
  }
  patchSession(c.sessionId, { model });
  api.setModel(c.space.backend, c.sessionId, model).catch(fail("Could not switch model"));
}

export function setAllowAll(on: boolean) {
  const c = state.current;
  if (!c) return;
  if (!c.sessionId) {
    set({ draft: { ...state.draft, allowAll: on } });
    return;
  }
  // A copy chat keeps its guard rules (deny the live project) in every mode; they go last so they win.
  const guard = (currentSession()?.metadata?.hqCopy as { guard?: PermissionRule[] } | undefined)?.guard || [];
  const permissions = on ? [...ALLOW_ALL, ...guard] : guard.length ? guard : null;
  patchSession(c.sessionId, { permissions });
  api.updateSession(c.space.backend, c.sessionId, { permissions }).catch(fail("Could not change permissions"));
}
// ---- web search in Chat mode ---------------------------------------------------------------------------
// The Chat agent denies every tool; these chat-level rules open just OpenCode's own web search (Exa's free public
// search, no key) and page reading. Tested 2026-11-16: the model then gets websearch + webfetch and nothing else.
const WEB_RULES: PermissionRule[] = [
  { action: "websearch", resource: "*", effect: "allow" },
  { action: "webfetch", resource: "*", effect: "allow" },
];
const isWebRule = (r: PermissionRule) => (r.action === "websearch" || r.action === "webfetch") && r.effect === "allow";
export function webSearchOn(s: State = state): boolean {
  if (!s.current?.sessionId) return !!s.draft.web;
  return !!currentSession(s)?.permissions?.some((r) => r.action === "websearch" && r.effect === "allow");
}
export function setWebSearch(on: boolean) {
  const c = state.current;
  if (!c) return;
  if (!c.sessionId) return set({ draft: { ...state.draft, web: on } });
  const rest = (currentSession()?.permissions || []).filter((r) => !isWebRule(r));
  const permissions = on ? [...WEB_RULES, ...rest] : rest.length ? rest : null; // copy guards stay last, so they still win
  patchSession(c.sessionId, { permissions });
  api.updateSession(c.space.backend, c.sessionId, { permissions }).catch(fail("Could not change web search"));
}
const WEB_NOTE =
  "You can search the web (websearch) and read pages (webfetch). Use them for current events, prices, versions or anything you'd " +
  "otherwise guess; not for things you know well. When you used them, end your answer with a short \"Sources\" list of the URLs you relied on.";

export function allowAllOn(s: State = state): boolean {
  if (!s.current?.sessionId) return s.draft.allowAll;
  return !!currentSession(s)?.permissions?.some((r) => r.action === "*" && r.resource === "*" && r.effect === "allow");
}

/** Undo the edits of the turn that starts with `userMessageId` (and of every later turn). */
export async function undoTurn(userMessageId: string) {
  const c = state.current;
  if (!c?.sessionId) return;
  const sid = c.sessionId;
  if (state.active[sid]) return toast("Stop the current work before undoing.", "info");
  try {
    const r = await api.revertStage(c.space.backend, sid, userMessageId);
    patchSession(sid, { revert: r });
    // Like OpenCode's own app: the undone request goes back into the message box to edit or resend.
    const text = (state.chat[sid]?.messages.find((m) => m.id === userMessageId) as UserMsg | undefined)?.text;
    if (text) set({ restoreDraft: { sessionId: sid, text } });
  } catch (e) {
    fail("Could not undo")(e);
  }
}

export async function redoTurns() {
  const c = state.current;
  if (!c?.sessionId) return;
  const sid = c.sessionId;
  try {
    await api.revertClear(c.space.backend, sid);
    patchSession(sid, { revert: null });
    set({ restoreDraft: null, editing: null });
  } catch (e) {
    fail("Could not redo")(e);
  }
}

/** Put a chat in a project (or back under Chats): same machine only, it carries on working in the new folder. */
export async function moveSession(backend: string, id: string, to: Space) {
  if (state.active[id]) return toast("Wait until it has finished, then move it.", "info");
  try {
    await api.move(backend, id, to.directory);
    const ses = await api.session(backend, id);
    upsertSession(ses, backend);
    if (state.current?.sessionId === id) {
      set({ current: { space: to, sessionId: id } });
      save("current", { space: to, sessionId: id });
    }
  } catch (e) {
    fail("Could not move the chat")(e);
  }
}

export function renameSession(backend: string, id: string, title: string) {
  patchSession(id, { title });
  api.updateSession(backend, id, { title }).catch(fail("Could not rename"));
}
export async function deleteSession(backend: string, id: string) {
  // A chat working on a copy: remove the copy too, or it's left behind as a stale duplicate of the project
  // (2026-11-15: nine orphaned copies found, which models searching the machine could mistake for real code).
  const ses = Object.values(state.sessions).flat().find((s) => s.id === id);
  const copy = ses?.metadata?.hqCopy as { applied?: string; discarded?: boolean } | undefined;
  if (copy && !copy.applied && !copy.discarded) {
    if (!window.confirm("This chat works on a copy that hasn't been applied to live. Deleting the chat also deletes the copy and any changes in it. Delete?")) return;
    await hq.copyDiscard(backend, id).catch(() => {});
  }
  dropSession(id);
  try {
    await api.deleteSession(backend, id);
  } catch (e) {
    return fail("Could not delete")(e);
  }
  // Its images and videos go too, unless another chat (a branch of it) still shows them.
  hq.mediaForget(backend, id).catch(() => {});
}
export async function forkSession(before?: string) {
  const c = state.current;
  if (!c?.sessionId) return;
  try {
    const ses = await api.fork(c.space.backend, c.sessionId, before);
    hq.mediaShare(c.space.backend, c.sessionId, ses.id).catch(() => {}); // the branch shows the same pictures
    upsertSession(ses, c.space.backend);
    openSession(c.space, ses.id);
  } catch (e) {
    fail("Could not branch")(e);
  }
}

// ---- projects -----------------------------------------------------------------------------------

export async function createProject(name: string, backend: string, directory: string) {
  const trimmed = /^[A-Za-z]:\\$/.test(directory) ? directory : directory.replace(/[\\/]+$/, "");
  const project: Project = { id: crypto.randomUUID(), name, backend, directory: trimmed || "/" };
  const projects = [...state.projects, project];
  set({ projects });
  await hq.saveProjects(projects).catch(fail("Could not save the project"));
  await loadSpace(projectSpace(project));
  newChat(projectSpace(project));
}
export function renameProject(id: string, name: string) {
  const projects = state.projects.map((p) => (p.id === id ? { ...p, name } : p));
  set({ projects });
  hq.saveProjects(projects).catch(fail("Could not save"));
}
/** Removes the project from HQ's list only; the folder and its chats are left alone. */
export function removeProject(id: string) {
  const projects = state.projects.filter((p) => p.id !== id);
  set({ projects });
  hq.saveProjects(projects).catch(fail("Could not save"));
  if (state.current?.space.projectId === id) newChat(chatsSpace(state.backends[0]));
}

// ---- small UI state -----------------------------------------------------------------------------

export function toggleSidebar() {
  set((s) => ({ ui: { ...s.ui, sidebar: !s.ui.sidebar } }));
  if (!isPhone()) save("sidebar", state.ui.sidebar);
}
export const setPanel = (panel: State["ui"]["panel"]) => set((s) => ({ ui: { ...s.ui, panel } }));
export const togglePanel = () => set((s) => ({ ui: { ...s.ui, panel: s.ui.panel ? false : s.hasBrowser ? "browser" : "changes" } }));
export const setVoiceOpen = (voiceOpen: boolean) => set({ voiceOpen });
export function setVoiceName(voiceName: string) {
  savePref("voice", voiceName);
  set({ voiceName });
}
export const openModal = (modal: State["ui"]["modal"]) => set((s) => ({ ui: { ...s.ui, modal } }));
/** Settings › Models for one machine (the first one when not given). */
export const openModels = (backend?: string) => set((s) => ({ ui: { ...s.ui, modal: "models", modalBackend: backend } }));
/** Reload a machine's model list after models were added or removed. */
export async function reloadModels(backendId: string) {
  const b = state.backends.find((x) => x.id === backendId);
  if (b) await loadBackend(b, 3);
}

// ---- "Try it" results ---------------------------------------------------------------------------

export const checkKey = (backend: string, providerID: string, modelID: string) => `${backend}/${providerID}/${modelID}`;
export async function loadChecks(backend: string) {
  const c = await hq.modelChecks(backend).catch(() => null);
  if (!c) return;
  set((s) => ({ checks: { ...s.checks, [backend]: c } }));
  // Which Byte API key on this machine may make images or videos (its permissions, read from the API).
  const makers: MediaMakers = {};
  for (const pid of c.byte) {
    const k = await hq.byteKey(backend, pid).catch(() => null);
    if (k?.scopes.includes("image")) makers.image ??= pid;
    if (k?.scopes.includes("video")) makers.video ??= pid;
  }
  set((s) => ({ makers: { ...s.makers, [backend]: makers } }));
}
const checking = new Set<string>();
/** Ask a model once to call a test tool (models.mjs check). Saved on the server, so every device sees the result. */
export async function runCheck(backend: string, providerID: string, modelID: string): Promise<ModelCheck | null> {
  const k = checkKey(backend, providerID, modelID);
  if (checking.has(k)) return null;
  checking.add(k);
  try {
    const r = await hq.modelCheck(backend, { providerID, modelID });
    set((s) => {
      const cur = s.checks[backend] || { results: {}, hq: [], byte: [] };
      return { checks: { ...s.checks, [backend]: { ...cur, results: { ...cur.results, [k]: { ...r, at: Date.now() } } } } };
    });
    return r;
  } finally {
    checking.delete(k);
  }
}
/** A model HQ added that has never been tried: try it quietly in the background (once per page load). */
const triedQuietly = new Set<string>();
export function checkQuietly(backend: string, model?: ModelRef) {
  const c = state.checks[backend];
  if (!model || !c || !c.hq.includes(model.providerID)) return;
  const k = checkKey(backend, model.providerID, model.id);
  const r = c.results[k];
  // A Byte API key without tool access may have been given it since: look again (cheap: the key is asked, not the model).
  const byteWaiting = r?.code === "tools" && c.byte.includes(model.providerID) && Date.now() - (r.at || 0) > 10 * 60_000;
  if ((r && !byteWaiting) || triedQuietly.has(k)) return;
  triedQuietly.add(k);
  runCheck(backend, model.providerID, model.id).catch(() => {});
}

// ---- saved prompts ------------------------------------------------------------------------------

export const EXAMPLE_PROMPTS: SavedPrompt[] = [
  { id: "explain", name: "Explain this project", text: "Read this project and explain it to me: what it does, how it's laid out, how to run it, and where to start when changing something. Don't change any files." },
  { id: "tests", name: "Fix the failing tests", text: "Run the project's tests. For each failing one, find out why it fails and fix the code (change a test only if the test itself is wrong). Run the tests again to confirm, and tell me what was wrong." },
  { id: "bugs", name: "Look for bugs", text: "Look through this project for real bugs (not style): say what breaks and when, with the file and line. Fix only the clear ones and list the rest for me." },
  { id: "review", name: "Review my changes", text: "Review the uncommitted changes (git diff): bugs, missed cases, anything unclear. Don't change files; list the problems, most important first." },
  { id: "commit", name: "Write a commit message", text: "Write a commit message for the uncommitted changes: a short summary line, a blank line, then why the change was made. Don't commit; just show it." },
];
export function savePrompts(list: SavedPrompt[]) {
  set({ prompts: list });
  savePref("prompts", list);
}
/** Put text into the message box of the open chat (the / menu and the prompts dialog use it). */
export const putInComposer = (text: string) => set({ insertText: { text, at: Date.now() } });

export const openMachine = (id?: string) => set((s) => ({ ui: { ...s.ui, modal: "machine", modalBackend: id } }));
export const openByteHelp = (backend?: string) => set((s) => ({ ui: { ...s.ui, modal: "byteHelp", modalBackend: backend } }));

// ---- images and videos (Byte API) -------------------------------------------------------------------

const setJobs = (sid: string, fn: (jobs: MediaJob[]) => MediaJob[]) => set((s) => ({ mediaJobs: { ...s.mediaJobs, [sid]: fn(s.mediaJobs[sid] || []) } }));

/** Make an image or video with this machine's Byte API key and put it into the open chat. `image`: a picture to start from. */
export async function makeMedia(kind: "image" | "video", prompt: string, image?: string): Promise<boolean> {
  const cur = state.current;
  const providerID = cur && state.makers[cur.space.backend]?.[kind];
  if (!cur || !providerID) {
    toast(`No Byte API key here can make ${kind}s`);
    return false;
  }
  const backend = cur.space.backend;
  const fresh = !cur.sessionId;
  const sid = await ensureSession().catch(fail("Could not start the chat"));
  if (!sid) return false;
  if (fresh) {
    const title = `${kind === "image" ? "Image" : "Video"}: ${prompt.replace(/\s+/g, " ").trim().slice(0, 50)}`;
    api.updateSession(backend, sid, { title }).then(() => patchSession(sid, { title })).catch(() => {});
  }
  const job: MediaJob = { id: crypto.randomUUID(), kind, prompt, started: Date.now() };
  setJobs(sid, (j) => [...j, job]);
  try {
    const m = await hq.makeMedia({ backend, providerID, kind, prompt, sid, ...(image ? { image } : {}) });
    // Into the chat's history: the model sees the line (with the next message), HQ shows the file.
    const item = await api.synthetic(backend, sid, `[${kind === "image" ? "Image" : "Video"} made from: ${m.prompt}]`, { hqMedia: m });
    setChat(sid, (c) => (c.inbox.some((i) => i.id === item.id) ? c : { ...c, inbox: [...c.inbox, item] }));
    setJobs(sid, (j) => j.filter((x) => x.id !== job.id));
    return true;
  } catch (e) {
    setJobs(sid, (j) => j.map((x) => (x.id === job.id ? { ...x, error: e instanceof Error ? e.message : String(e) } : x)));
    return false;
  }
}
export const dismissMediaJob = (sid: string, id: string) => setJobs(sid, (j) => j.filter((x) => x.id !== id));

// ---- chat metadata (pins, folders, persona) ---------------------------------------------------------

/** Change some of a chat's metadata. Merged into the server's current copy: OpenCode replaces metadata as a whole. null removes a key. */
export async function setSessionMeta(backend: string, sid: string, patch: Record<string, unknown>) {
  const apply = (base: Record<string, unknown> | null | undefined) => {
    const m: Record<string, unknown> = { ...(base || {}) };
    for (const [k, v] of Object.entries(patch)) if (v === null) delete m[k]; else m[k] = v;
    return m;
  };
  // On screen at once (a message sent right after picking a persona must already use it), then saved.
  patchSession(sid, { metadata: apply(findSession(sid)?.session.metadata) });
  const fresh = await api.session(backend, sid);
  const meta = apply(fresh.metadata);
  await api.updateSession(backend, sid, { metadata: meta });
  patchSession(sid, { metadata: meta });
}
export const pinSession = (backend: string, sid: string, on: boolean) => setSessionMeta(backend, sid, { hqPinned: on ? true : null }).catch(fail("Could not pin"));
export const setChatFolder = (backend: string, sid: string, folder: string | null) =>
  setSessionMeta(backend, sid, { hqFolder: folder?.trim() || null }).catch(fail("Could not move"));

// ---- edit and resend, ask another model --------------------------------------------------------------

/** Edit a sent message: its reply and everything after are undone (Redo brings them back), and the text goes into the box. */
export async function editMessage(userMessageId: string) {
  const c = state.current;
  if (!c?.sessionId) return;
  if (state.active[c.sessionId]) return toast("Stop the reply first, then edit.", "info");
  await undoTurn(userMessageId);
  const text = (state.chat[c.sessionId]?.messages.find((m) => m.id === userMessageId) as UserMsg | undefined)?.text;
  if (text) set({ editing: c.sessionId, insertText: { text, at: Date.now() }, restoreDraft: null });
}

/** The same message to another model, in a new chat branched from just before it, so the answers can be compared. */
export async function askAnotherModel(userMessageId: string, text: string, model: ModelRef) {
  const c = state.current;
  if (!c?.sessionId) return;
  const backend = c.space.backend;
  const name = (state.models[backend] || []).find((m) => m.id === model.id && m.providerID === model.providerID)?.name || model.id;
  const before = currentSession()?.title;
  try {
    const ses = await api.fork(backend, c.sessionId, userMessageId);
    hq.mediaShare(backend, c.sessionId, ses.id).catch(() => {});
    upsertSession(ses, backend);
    openSession(c.space, ses.id);
    if (isAuto()) setAuto(false); // this branch is for one particular model
    await api.setModel(backend, ses.id, model);
    patchSession(ses.id, { model });
    const title = `${(before || "Chat").replace(/ · [^·]+$/, "")} · ${name}`.slice(0, 120);
    api.updateSession(backend, ses.id, { title }).then(() => patchSession(ses.id, { title })).catch(() => {});
    await sendPrompt(text);
  } catch (e) {
    fail("Could not ask the other model")(e);
  }
}

// ---- custom instructions, memory, personas -----------------------------------------------------------

export const EXAMPLE_PERSONAS: Persona[] = [
  { id: "short", name: "Short answers", instructions: "Answer in as few words as possible. No preamble, no summary at the end." },
  { id: "teacher", name: "Patient teacher", instructions: "Explain step by step, with a small example for each step. Check the user follows before going further." },
  { id: "editor", name: "Writing editor", instructions: "Improve the user's writing: clearer and shorter, same meaning and voice. Show the new version, then list the main changes." },
];
export function saveAbout(text: string) {
  set({ about: text });
  savePref("about", text);
}
export function saveMemory(list: MemoryFact[]) {
  set({ memory: list });
  savePref("memory", list);
}
export function remember(text: string) {
  const t = text.trim().slice(0, 500);
  if (!t) return;
  saveMemory([...state.memory, { id: crypto.randomUUID(), text: t, at: Date.now() }]);
  toast(`Remembered: ${t}`, "info");
}
export function savePersonas(list: Persona[]) {
  set({ personas: list });
  savePref("personas", list);
}
/** The persona for the open chat (or the new one about to start). */
export function currentPersona(s: State = state): Persona | undefined {
  const id = s.current?.sessionId ? (currentSession(s)?.metadata?.hqPersona as string | undefined) : s.draft.persona;
  return id ? s.personas.find((p) => p.id === id) : undefined;
}
export async function setPersona(id: string | null) {
  const c = state.current;
  if (!c) return;
  if (!c.sessionId) return set({ draft: { ...state.draft, persona: id || undefined } });
  await setSessionMeta(c.space.backend, c.sessionId, { hqPersona: id }).catch(fail("Could not change the persona"));
}

/** What a chat's model is told about the user: the custom instructions and remembered facts. */
function aboutText(): string {
  const parts = [];
  if (state.about.trim()) parts.push(`About the user and how they want answers:\n${state.about.trim()}`);
  if (state.memory.length) parts.push(`Things the user asked you to remember:\n${state.memory.map((m) => `- ${m.text}`).join("\n")}`);
  return parts.join("\n\n");
}
// The values each chat was last given, so unchanged ones aren't sent again (read from the server once per chat).
const synced = new Map<string, Record<string, string>>();
let instructionsMissing = false;
/** Give the chat its context entries (OpenCode adds them to the system prompt): custom instructions + memory, and the persona. */
async function syncInstructions(backend: string, sid: string) {
  if (instructionsMissing) return;
  const ses = findSession(sid)?.session;
  const persona = state.personas.find((p) => p.id === ses?.metadata?.hqPersona);
  const web = !!ses?.permissions?.some((r) => r.action === "websearch" && r.effect === "allow") && ses?.agent === CHAT_AGENT;
  const want: Record<string, string> = {
    "hq-about": aboutText(),
    "hq-persona": persona ? `Act as "${persona.name}":\n${persona.instructions}` : "",
    "hq-web": web ? WEB_NOTE : "",
  };
  try {
    let have = synced.get(sid);
    if (!have) {
      const list = await api.instructions(backend, sid);
      have = Object.fromEntries(list.filter((e) => e.key.startsWith("hq-")).map((e) => [e.key, String(e.value ?? "")]));
    }
    for (const [key, value] of Object.entries(want)) {
      if ((have[key] || "") === value) continue;
      if (value) await api.setInstruction(backend, sid, key, value);
      else await api.removeInstruction(backend, sid, key);
    }
    synced.set(sid, want);
  } catch (e) {
    // An OpenCode without this (it's marked experimental): chats still work, just without these.
    if ((e as { status?: number }).status === 404) instructionsMissing = true;
  }
}

// ---- export and print --------------------------------------------------------------------------------

/** The chat as Markdown: what was asked, each answer, and what was made. Tool steps are left out. */
export async function chatMarkdown(backend: string, sid: string): Promise<{ title: string; markdown: string }> {
  const ses = findSession(sid)?.session;
  const messages = state.chat[sid]?.loaded ? state.chat[sid].messages : await api.messages(backend, sid);
  const title = ses?.title || "Chat";
  const nameOf = (r?: ModelRef) => (r ? (state.models[backend] || []).find((m) => m.id === r.id && m.providerID === r.providerID)?.name || r.id : "");
  const out = [`# ${title}`, "", `_Exported from ${state.appName} on ${new Date().toLocaleString()}_`, ""];
  for (const t of buildTurns(messages.filter((m) => !(m.type === "user" && m.pending)))) {
    if (t.media) {
      out.push(`*[${t.media.kind === "image" ? "Image" : "Video"} made from: ${t.media.prompt}]*`, "");
      continue;
    }
    const asked = t.users.map((u) => u.text).filter(Boolean).join("\n\n");
    if (asked) out.push("**You:**", "", asked, "");
    const v = viewTurn(t, false);
    if (v.answer) out.push(`**${nameOf(v.lastAssistant?.model) || "Assistant"}:**`, "", v.answer, "");
    if (v.error) out.push(`> Error: ${v.error}`, "");
  }
  return { title, markdown: out.join("\n") };
}
export async function exportChat(backend: string, sid: string) {
  try {
    const { title, markdown } = await chatMarkdown(backend, sid);
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([markdown], { type: "text/markdown;charset=utf-8" }));
    a.download = `${title.replace(/[\\/:*?"<>|]+/g, " ").trim().slice(0, 80) || "chat"}.md`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  } catch (e) {
    fail("Could not export")(e);
  }
}
export async function printChat(backend: string, sid: string) {
  try {
    set({ printing: await chatMarkdown(backend, sid) });
  } catch (e) {
    fail("Could not print")(e);
  }
}
export const donePrinting = () => set({ printing: null });

// ---- gallery -----------------------------------------------------------------------------------------

/** Open a chat known only by its id (the gallery): it's found in whichever list shows it. Returns false if none does. */
export function openChatById(backend: string, sid: string): boolean {
  const f = findSession(sid);
  if (!f) return false;
  const [b, ...rest] = f.key.split("|");
  if (b !== backend) return false;
  const directory = rest.join("|");
  const p = state.projects.find((x) => x.backend === b && x.directory === directory);
  openSession(p ? projectSpace(p) : { backend: b, directory }, sid);
  return true;
}
