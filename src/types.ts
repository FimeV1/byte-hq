// Shapes of the OpenCode 2.x HTTP API that HQ uses (see <backend>/openapi.json for the full set).

export type ModelRef = { id: string; providerID: string; variant?: string };

export type Model = {
  id: string;
  providerID: string;
  name: string;
  type?: string;
  enabled: boolean;
  variants: { id: string }[];
  limit: { context: number; output: number };
  capabilities: { tools: boolean; input: string[]; output: string[] };
};

export type Tokens = { input: number; output: number; reasoning: number; cache: { read: number; write: number } };

export type Session = {
  id: string;
  parentID?: string;
  title?: string;
  model?: ModelRef;
  agent?: string;
  tokens: Tokens;
  outcome?: "succeeded" | "failed" | "interrupted";
  time: { created: number; updated: number; busy?: number; idle?: number; archived?: number };
  subpath?: string;
  permissions?: PermissionRule[] | null;
  /** Set while a turn's edits are undone (files restored, later turns hidden until Redo or a new message). */
  revert?: { messageID: string; files?: FileDiff[] } | null;
  metadata?: Record<string, unknown> | null;
  location: { directory: string };
};

export type PermissionRule = { action: string; resource: string; effect: string };

export type FileDiff = {
  file: string;
  patch: string;
  additions: number;
  deletions: number;
  status: "added" | "deleted" | "modified";
};

export type StructuredError = { type: string; message: string };

export type ToolState =
  | { status: "streaming"; input: string }
  | { status: "running"; input: Record<string, unknown>; metadata?: Record<string, unknown> }
  | { status: "completed"; input: Record<string, unknown>; content?: { type: string; text?: string }[]; metadata?: Record<string, unknown> }
  | { status: "error"; input: Record<string, unknown>; error: StructuredError; metadata?: Record<string, unknown> };

export type Part =
  | { type: "text"; text: string }
  | { type: "reasoning"; text: string; time?: { created: number; completed?: number } }
  | { type: "tool"; id: string; name: string; state: ToolState; time: { created: number; ran?: number; completed?: number } };

export type AssistantMsg = {
  type: "assistant";
  id: string;
  time: { created: number; streamed?: number; completed?: number };
  agent: string;
  model: ModelRef;
  content: Part[];
  snapshot?: { start?: string; end?: string; files?: string[] };
  finish?: string;
  tokens?: Tokens;
  error?: StructuredError;
};

export type UserFile = { name?: string; mime?: string; data?: string };
export type UserMsg = { type: "user"; id: string; time: { created: number }; text: string; files?: UserFile[]; pending?: boolean };
/** A file picked in the composer, sent inline as a data: URI. */
export type Attachment = { id: string; name: string; mime: string; dataUrl: string; size: number };
export type IdleMsg = { type: "idle"; id: string; time: { created: number }; outcome: "succeeded" | "failed" | "interrupted"; error?: StructuredError };
export type ShellMsg = { type: "shell"; id: string; time: { created: number; completed?: number }; command: string; status: string; exit?: number; output?: { output: string } };
export type CompactionMsg = { type: "compaction"; id: string; time: { created: number }; status: "running" | "completed" | "failed"; summary?: string };
export type OtherMsg = {
  type: "synthetic" | "system" | "skill" | "agent-switched" | "model-switched" | "location-switched";
  id: string;
  time: { created: number };
  text?: string;
  model?: ModelRef;
  location?: { directory: string };
  metadata?: { hqMedia?: Media } | null;
};
/** An image or video HQ made with the Byte API and put into a chat (a synthetic message; the model sees its text). */
export type Media = { kind: "image" | "video"; file: string; prompt: string; providerID?: string };
/** A saved image or video as the gallery lists it, with the chats it belongs to (none: its chats were deleted, or unknown). */
export type MediaItem = { file: string; kind: "image" | "video"; prompt: string; at: number; size: number; owners: { backend: string; sid: string }[] };

export type Msg = AssistantMsg | UserMsg | IdleMsg | ShellMsg | CompactionMsg | OtherMsg;

export type InboxItem = {
  id: string;
  sessionID: string;
  type: string;
  delivery: "steer" | "queue";
  payload?: { text?: string; metadata?: { hqMedia?: Media } | null } | null;
  time: { created: number };
};

export type FormOption = { value: string; label: string; description?: string };
export type FormField = {
  key: string;
  type: "string" | "number" | "integer" | "boolean" | "multiselect" | "external";
  title?: string;
  description?: string;
  required?: boolean;
  hidden?: boolean;
  when?: { key: string; op: "eq" | "neq"; value: unknown }[];
  options?: FormOption[];
  custom?: boolean;
  placeholder?: string;
  default?: unknown;
  minimum?: number;
  maximum?: number;
  url?: string;
};
/** A question from the agent that waits for an answer (OpenCode "forms", e.g. the question tool). */
export type Form = { id: string; sessionID: string; title: string; fields: FormField[] };

export type PermissionRequest = {
  id: string;
  sessionID: string;
  action: string;
  resources: string[];
  save?: string[];
  message?: string;
};

// ---- HQ's own shapes --------------------------------------------------------------------------

export type Backend = { id: string; label: string; home?: string; chatsDir?: string };

/** A project is a machine (backend) plus a folder on it. Kept by the HQ server, not by OpenCode. */
/** `test`: command run inside a copy before its change can be applied (Work on a copy). */
export type Project = { id: string; name: string; backend: string; directory: string; test?: string };

export type CopyInfo = {
  base: string; worktree: string; projectID: string; applied?: string; discarded?: boolean;
  /** Services the applied files belong to (from the project's restart map), offered as a Restart button. */
  restart?: string[]; restarted?: { at: number; ok: boolean; summary: string };
};
export type TestStep = { name: string; exit: number; output: string };
export type TestResult = { ok: boolean; at: number; ran: number; changed: number; summary: string; steps: TestStep[] };

/** Where a chat lives: a project folder, or the backend's general "Chats" folder. */
export type Space = { backend: string; directory: string; projectId?: string };

export const spaceKey = (s: { backend: string; directory: string }) => `${s.backend}|${s.directory}`;

/** An OpenCode server as Settings › Servers shows it (never its password). */
export type Machine = { id: string; label: string; url: string; user: string; hasPassword: boolean; home: string; chatsDir: string };
/** One "Try it" result (models.mjs check): can the model chat, and can it call tools? */
export type ModelCheck = { ok: boolean; chat: boolean; tools: boolean; ms: number; code?: string; problem?: string; at?: number };
/** Saved results for a machine, keyed "<machine>/<provider>/<model>"; hq = providers HQ added; byte = which of them are the Byte API. */
export type ModelChecks = { results: Record<string, ModelCheck>; hq: string[]; byte: string[] };
/** A Byte API key as the Byte API reports it: read-only, changed only by the API's owner. tools null = not reported. */
/** Which Byte API provider on a machine can make images or videos (from the key's permissions). */
export type MediaMakers = { image?: string; video?: string };
export type ByteKeyInfo = {
  name: string; metered: boolean; balance: string; tools: boolean | null; toolsRequested: boolean; scopes: string[];
  tokensUsed: number | null; tokenBudget: number | null; tokenWindow: string | null; tokensRenew: string | null;
  requestsToday: number | null; dailyRequests: number | null;
};
/** A saved prompt, picked from the / menu in the message box. */
export type SavedPrompt = { id: string; name: string; text: string };
