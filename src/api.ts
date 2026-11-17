import type { Backend, ByteKeyInfo, Media, MediaItem, FileDiff, Form, GitCheckLogin, GitStatus, InboxItem, Machine, ModelCheck, ModelChecks, TestResult, Model, ModelRef, Msg, PermissionRequest, PermissionRule, Project, Session } from "./types";

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: init?.body ? { "content-type": "application/json", ...(init.headers || {}) } : init?.headers,
  });
  const text = await res.text();
  let body: any = undefined;
  try {
    body = text ? JSON.parse(text) : undefined;
  } catch {
    body = undefined;
  }
  if (!res.ok) throw new ApiError(res.status, body?.message || text.slice(0, 200) || res.statusText);
  return body as T;
}

const oc = (backend: string, path: string) => `/oc/${backend}/api/${path}`;
const post = (body: unknown): RequestInit => ({ method: "POST", body: JSON.stringify(body) });
// OpenCode takes `location` as a nested query object: location[directory]=/abs/path
const loc = (directory: string) => `location[directory]=${encodeURIComponent(directory)}`;

export const hq = {
  config: () => call<{ name: string; backends: Backend[]; browser?: boolean; voice?: { voice: string }; login?: boolean }>("/hq/config"),
  projects: () => call<Project[]>("/hq/projects"),
  prefs: () => call<Record<string, unknown>>("/hq/prefs"),
  health: () => call<Record<string, boolean>>("/hq/health"),
  copyIsGit: (backend: string, directory: string) =>
    call<{ git: boolean }>("/hq/copy/isgit", { method: "POST", body: JSON.stringify({ backend, directory }) }),
  copyStart: (backend: string, directory: string, body: Record<string, unknown>) =>
    call<Session>("/hq/copy/start", { method: "POST", body: JSON.stringify({ backend, directory, ...body }) }),
  copyTest: (backend: string, sessionID: string) => call<TestResult>("/hq/copy/test", { method: "POST", body: JSON.stringify({ backend, sessionID }) }),
  copyApply: (backend: string, sessionID: string) =>
    call<{ commit: string; files: string[]; restart?: string[] }>("/hq/copy/apply", { method: "POST", body: JSON.stringify({ backend, sessionID }) }),
  copyDiscard: (backend: string, sessionID: string) => call("/hq/copy/discard", { method: "POST", body: JSON.stringify({ backend, sessionID }) }),
  copyRestart: (backend: string, sessionID: string) =>
    call<{ ok: boolean; summary: string }>("/hq/copy/restart", { method: "POST", body: JSON.stringify({ backend, sessionID }) }),
  autoSend: (backend: string, sessionID: string, text: string, files?: { uri: string; name: string }[]) =>
    call<{ label: string; why: string }>("/hq/auto/send", { method: "POST", body: JSON.stringify({ backend, sessionID, text, files }) }),
  autoReview: (backend: string, sessionID: string, turn: string) =>
    call("/hq/auto/review", { method: "POST", body: JSON.stringify({ backend, sessionID, turn }) }),
  modelChecks: (backend: string) => call<ModelChecks>(`/hq/models/checks?backend=${encodeURIComponent(backend)}`),
  modelCheck: (backend: string, spec: { providerID?: string; modelID: string; baseURL?: string; apiKey?: string }) =>
    call<ModelCheck>("/hq/models/check", { method: "POST", body: JSON.stringify({ backend, ...spec }) }),
  byteKey: (backend: string, provider: string) =>
    call<ByteKeyInfo>(`/hq/models/byte-key?backend=${encodeURIComponent(backend)}&provider=${encodeURIComponent(provider)}`),
  byteAskTools: (backend: string, providerID: string) =>
    call<{ status: "on" | "pending" }>("/hq/models/byte-ask-tools", { method: "POST", body: JSON.stringify({ backend, providerID }) }),
  chatAgent: (backend: string) => call<{ ok: boolean; reason?: string }>("/hq/models/chat-agent", { method: "POST", body: JSON.stringify({ backend }) }),
  makeMedia: (body: { backend: string; providerID: string; kind: "image" | "video"; prompt: string; image?: string; sid?: string }) =>
    call<Media>("/hq/media/make", { method: "POST", body: JSON.stringify(body) }),
  mediaList: () => call<{ items: MediaItem[]; bytes: number }>("/hq/media/list"),
  mediaShare: (backend: string, from: string, to: string) => call("/hq/media/share", { method: "POST", body: JSON.stringify({ backend, from, to }) }),
  mediaForget: (backend: string, sid: string) => call<{ deleted: number; freed: number }>("/hq/media/forget", { method: "POST", body: JSON.stringify({ backend, sid }) }),
  mediaDelete: (file: string) => call("/hq/media/delete", { method: "POST", body: JSON.stringify({ file }) }),
  gitStatus: (project: string) => call<GitStatus>(`/hq/git/status?project=${encodeURIComponent(project)}`, { cache: "no-store" } as RequestInit),
  gitRefresh: (project: string) => call<GitStatus>("/hq/git/refresh", { method: "POST", body: JSON.stringify({ project }) }),
  gitConnect: (project: string, url: string) => call<GitStatus>("/hq/git/connect", { method: "POST", body: JSON.stringify({ project, url }) }),
  gitCheckLogin: (project: string) => call<GitCheckLogin>("/hq/git/check-login", { method: "POST", body: JSON.stringify({ project }) }),
  machines: () => call<Machine[]>("/hq/machines"),
  machineTest: (m: Partial<Machine> & { password?: string }) =>
    call<{ hostname: string; version: string; suggestHome: string }>("/hq/machines/test", { method: "POST", body: JSON.stringify(m) }),
  machineSave: (m: Partial<Machine> & { password?: string }) => call<{ id: string }>("/hq/machines/save", { method: "POST", body: JSON.stringify(m) }),
  machineRemove: (id: string) => call("/hq/machines/remove", { method: "POST", body: JSON.stringify({ id }) }),
  savePrefs: (patch: Record<string, unknown>) => call("/hq/prefs", { method: "PATCH", body: JSON.stringify(patch) }),
  saveProjects: (list: Project[]) => call<Project[]>("/hq/projects", { method: "PUT", body: JSON.stringify(list) }),
};

export const api = {
  info: (b: string) => call<{ version: string; hostname: string }>(oc(b, "info")),
  models: async (b: string, directory: string) => (await call<{ data: Model[] }>(oc(b, `model?${loc(directory)}`))).data,
  defaultModel: async (b: string, directory: string) =>
    (await call<{ data: Model | null }>(oc(b, `model/default?${loc(directory)}`))).data,

  /** Every chat on that machine, any folder (used to find copy chats). */
  allSessions: async (b: string) => (await call<{ data: Session[] }>(oc(b, "session?limit=300"))).data,
  sessions: async (b: string, directory: string) =>
    (await call<{ data: Session[] }>(oc(b, `session?directory=${encodeURIComponent(directory)}&limit=50`))).data,
  children: async (b: string, parentID: string) =>
    (await call<{ data: Session[] }>(oc(b, `session?parentID=${encodeURIComponent(parentID)}&limit=100`))).data,
  session: async (b: string, id: string) => (await call<{ data: Session }>(oc(b, `session/${id}`))).data,
  active: async (b: string) => (await call<{ data: Record<string, { type: string }> }>(oc(b, "session/active"))).data,
  createSession: async (
    b: string,
    body: { location: { directory: string }; model?: ModelRef; agent?: string; permissions?: PermissionRule[]; parentID?: string; title?: string; metadata?: Record<string, unknown> },
  ) =>
    (await call<{ data: Session }>(oc(b, "session"), post(body))).data,
  updateSession: (b: string, id: string, body: { title?: string; permissions?: PermissionRule[] | null; metadata?: Record<string, unknown> }) =>
    call(oc(b, `session/${id}`), { method: "PATCH", body: JSON.stringify(body) }),
  deleteSession: (b: string, id: string) => call(oc(b, `session/${id}`), { method: "DELETE" }),
  fork: async (b: string, id: string, before?: string) =>
    (await call<{ data: Session }>(oc(b, `session/${id}/fork`), post(before ? { before } : {}))).data,
  /** Move a chat to another folder on the same machine (it carries on working there). */
  move: (b: string, id: string, directory: string) => call(oc(b, `session/${id}/move`), post({ directory })),
  setModel: (b: string, id: string, model: ModelRef) => call(oc(b, `session/${id}/model`), post({ model })),

  /** Newest first from the server; returned oldest first. Follows the cursor so long chats load fully. */
  messages: async (b: string, id: string) => {
    const all: Msg[] = [];
    let cursor: string | null | undefined;
    for (let page = 0; page < 40; page++) {
      const q: string = cursor ? `&cursor=${encodeURIComponent(cursor)}` : "";
      const r = await call<{ data: Msg[]; cursor: { next?: string | null } }>(oc(b, `session/${id}/message?limit=100${q}`));
      all.push(...r.data);
      cursor = r.cursor?.next;
      if (!cursor || r.data.length < 100) break;
    }
    return all.reverse();
  },
  message: async (b: string, id: string, messageID: string) =>
    (await call<{ data: Msg }>(oc(b, `session/${id}/message/${messageID}`))).data,

  prompt: async (b: string, id: string, text: string, delivery?: "steer" | "queue", files?: { uri: string; name: string }[]) =>
    (await call<{ data: InboxItem }>(oc(b, `session/${id}/prompt`), post({ text, ...(delivery ? { delivery } : {}), ...(files?.length ? { files } : {}) }))).data,
  /** Add a message to the chat without asking the model (it's sent along with the next prompt). */
  synthetic: async (b: string, id: string, text: string, metadata: Record<string, unknown>) =>
    (await call<{ data: InboxItem }>(oc(b, `session/${id}/synthetic`), post({ text, metadata, resume: false }))).data,
  setAgent: (b: string, id: string, agent: string) => call(oc(b, `session/${id}/agent`), post({ agent })),
  /** A chat's context entries (OpenCode adds them to the system prompt). */
  instructions: async (b: string, id: string) =>
    (await call<{ data: { key: string; value: unknown }[] }>(oc(b, `experimental/session/${id}/instructions/entries`))).data,

  interrupt: (b: string, id: string) => call(oc(b, `session/${id}/interrupt`), { method: "POST" }),
  /** Start delivering parked steering messages in an idle session (Stop leaves them parked). */
  resume: (b: string, id: string) => call(oc(b, `session/${id}/interrupt?resume=true`), { method: "POST" }),
  inbox: async (b: string, id: string) => (await call<{ data: InboxItem[] }>(oc(b, `session/${id}/inbox`))).data,
  setDelivery: (b: string, id: string, inboxID: string, delivery: "steer" | "queue") =>
    call(oc(b, `session/${id}/inbox/${inboxID}`), { method: "PATCH", body: JSON.stringify({ delivery }) }),
  cancelInbox: (b: string, id: string, inboxID: string) => call(oc(b, `session/${id}/inbox/${inboxID}`), { method: "DELETE" }),

  permissions: async (b: string, id: string) =>
    (await call<{ data: PermissionRequest[] }>(oc(b, `session/${id}/permission`))).data,
  replyPermission: (b: string, id: string, requestID: string, decision: "once" | "always" | "reject") =>
    call(oc(b, `session/${id}/permission/${requestID}/reply`), post({ decision })),

  /** Undo: restore files to before `messageID` (a user message) and set the chat's undo point there. */
  revertStage: async (b: string, id: string, messageID: string) =>
    (await call<{ data: { messageID: string; files?: FileDiff[] } }>(oc(b, `session/${id}/revert/stage`), post({ messageID, files: true }))).data,
  /** Redo: put the undone edits back. */
  revertClear: (b: string, id: string) => call(oc(b, `session/${id}/revert`), { method: "DELETE" }),

  /** Durable per-chat instructions (OpenCode announces changes to the model at the next step). */
  setInstruction: (b: string, id: string, key: string, value: unknown) =>
    call(oc(b, `experimental/session/${id}/instructions/entries/${key}`), { method: "PUT", body: JSON.stringify({ value }) }),
  removeInstruction: (b: string, id: string, key: string) =>
    call(oc(b, `experimental/session/${id}/instructions/entries/${key}`), { method: "DELETE" }),

  forms: async (b: string, id: string) => (await call<{ data: Form[] }>(oc(b, `session/${id}/form`))).data,
  replyForm: (b: string, id: string, formID: string, answer: Record<string, unknown>) =>
    call(oc(b, `session/${id}/form/${formID}/reply`), post({ answer })),
  cancelForm: (b: string, id: string, formID: string) => call(oc(b, `session/${id}/form/${formID}`), { method: "DELETE" }),

  /** Files changed by one turn (the turn that starts at `from`, a user message id). */
  turnDiff: async (b: string, id: string, from: string) =>
    (await call<{ data: FileDiff[] }>(oc(b, `session/${id}/diff?from=${from}&context=3`))).data,

  listDir: async (b: string, directory: string) =>
    (await call<{ data: { path: string; type: "file" | "directory" }[] }>(oc(b, `fs/list?${loc(directory)}`))).data,
};

export const eventsUrl = (backend: string) => `/oc/${backend}/api/event`;
