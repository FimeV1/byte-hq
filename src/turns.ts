import type { AssistantMsg, FileDiff, IdleMsg, Media, Msg, Part, UserMsg } from "./types";

/**
 * A turn is what the user sees as one exchange: their prompt, the agent's work, the answer.
 * It starts at the first prompt after the chat was idle and ends at the next idle marker, so a
 * prompt steered in while the agent is working belongs to the same turn (this matches how the
 * backend's per-turn diff groups changes).
 */
export type Turn = {
  key: string;
  /** First user message id: the key for this turn's file diff. */
  userId?: string;
  users: UserMsg[];
  items: Msg[];
  idle?: IdleMsg;
  touchedFiles: boolean;
  /** The backend's file snapshots saw changes in this turn, so its diff can be trusted even when empty. */
  snapshotMoved: boolean;
  /** An image or video HQ made: shown on its own, not as an exchange with the model. */
  media?: Media;
};

export function buildTurns(messages: Msg[]): Turn[] {
  const turns: Turn[] = [];
  let cur: Turn | undefined;
  const start = (key: string): Turn => {
    const t: Turn = { key, users: [], items: [], touchedFiles: false, snapshotMoved: false };
    turns.push(t);
    return t;
  };
  // A compaction between turns (Auto compacts before sending the next prompt) belongs to the NEXT turn. Starting
  // a turn with it made the following prompt look like a mid-turn message, so that turn had no request of its own
  // and lost its Edited files and review cards (2026-11-15).
  let carry: Msg[] = [];
  for (const m of messages) {
    const media = m.type === "synthetic" ? m.metadata?.hqMedia : undefined;
    if (media && (!cur || cur.idle)) {
      turns.push({ key: m.id, users: [], items: [m], touchedFiles: false, snapshotMoved: false, media });
      cur = undefined; // the next prompt starts a turn of its own
      continue;
    }
    if (m.type === "compaction" && (!cur || cur.idle)) {
      carry.push(m);
      continue;
    }
    // "system": OpenCode's note that a chat's context entries changed (custom instructions, memory, persona). Between
    // turns it must not start one, or the next prompt became a mid-turn message and its bubble vanished (2026-11-16).
    if ((m.type === "location-switched" || m.type === "model-switched" || m.type === "agent-switched" || m.type === "system") && (!cur || cur.idle)) {
      // Bookkeeping between turns (a move, Auto picking a model): it must not start a turn of its own,
      // or the next prompt would look like a message sent mid-turn. Keep moves with the previous turn.
      if (cur && m.type === "location-switched") cur.items.push(m);
      continue;
    }
    if (m.type === "user") {
      if (!cur || cur.idle) cur = start(m.id);
      if (cur.items.length === 0) {
        cur.users.push(m);
        if (!cur.userId && !m.pending) cur.userId = m.id;
      } else cur.items.push(m);
      if (carry.length) (cur.items.push(...carry), (carry = []));
      continue;
    }
    if (m.type === "idle") {
      if (cur && !cur.idle) cur.idle = m;
      continue;
    }
    if (!cur || cur.idle) cur = start(m.id);
    if (carry.length) (cur.items.push(...carry), (carry = []));
    cur.items.push(m);
    if (m.type === "assistant") {
      const s = m.snapshot;
      if (s?.start && s?.end && s.start !== s.end) cur.snapshotMoved = true;
      if (s?.files?.length || cur.snapshotMoved || m.content.some(isFileEdit)) cur.touchedFiles = true;
    }
  }
  // A compaction still waiting for its prompt (Auto is about to send it): show it on its own for now.
  if (carry.length) start(carry[0].id).items.push(...carry);
  return turns;
}

const isFileEdit = (p: Part) => p.type === "tool" && (p.name === "write" || p.name === "edit") && p.state.status === "completed";

/**
 * Changed files worked out from the turn's own write/edit calls. Used when the backend's
 * snapshot diff has nothing to say: folders that are not a git repository, and ignored files.
 * Counts are per call, so a line edited twice is counted twice.
 */
export function filesFromTools(turn: Turn): FileDiff[] {
  const byFile = new Map<string, FileDiff>();
  const add = (f: FileDiff) => {
    const old = byFile.get(f.file);
    if (!old) byFile.set(f.file, f);
    else byFile.set(f.file, { ...old, additions: old.additions + f.additions, deletions: old.deletions + f.deletions, patch: old.patch + "\n" + f.patch });
  };
  for (const m of turn.items) {
    if (m.type !== "assistant") continue;
    for (const p of m.content) {
      if (p.type !== "tool" || p.state.status !== "completed") continue;
      const meta = (p.state.metadata || {}) as { files?: FileDiff[] };
      if (p.name === "edit" && Array.isArray(meta.files)) meta.files.forEach(add);
      else if (p.name === "write") {
        const file = String(p.state.input.path || p.state.input.filePath || "");
        const lines = String(p.state.input.content ?? "").replace(/\n$/, "").split("\n");
        if (file) add({ file, status: "added", additions: lines.length, deletions: 0, patch: `@@ -0,0 +1,${lines.length} @@\n` + lines.map((l) => "+" + l).join("\n") });
      }
    }
  }
  return [...byFile.values()];
}

export type TurnView = {
  /** Steps shown under "Worked for …": reasoning, tool calls, narration, steered prompts. */
  log: LogRow[];
  /** The answer: the text of the last assistant message. */
  answer: string;
  error?: string;
  startedAt?: number;
  endedAt?: number;
  lastAssistant?: AssistantMsg;
};

export type LogRow =
  | { kind: "reasoning"; key: string; text: string; live: boolean }
  | { kind: "text"; key: string; text: string }
  | { kind: "tool"; key: string; part: Extract<Part, { type: "tool" }> }
  | { kind: "user"; key: string; text: string }
  | { kind: "shell"; key: string; command: string; output?: string; status: string }
  | { kind: "note"; key: string; text: string };

export function viewTurn(turn: Turn, running: boolean): TurnView {
  const log: LogRow[] = [];
  let lastAssistant: AssistantMsg | undefined;
  for (let i = turn.items.length - 1; i >= 0; i--) {
    const m = turn.items[i];
    if (m.type === "assistant") {
      lastAssistant = m;
      break;
    }
    if (m.type === "user") break; // a steered prompt after the last answer: nothing is "final" yet
  }
  let answer = "";
  let error: string | undefined;
  for (const m of turn.items) {
    if (m.type === "assistant") {
      const isLast = m === lastAssistant;
      m.content.forEach((p, i) => {
        const key = `${m.id}:${i}`;
        if (p.type === "reasoning") {
          if (p.text.trim()) log.push({ kind: "reasoning", key, text: p.text, live: running && isLast && !p.time?.completed && !m.time.completed });
        } else if (p.type === "tool") log.push({ kind: "tool", key, part: p });
        else if (isLast) answer += (answer ? "\n\n" : "") + p.text;
        else if (p.text.trim()) log.push({ kind: "text", key, text: p.text });
      });
      if (m.error && m.error.type !== "aborted") error = m.error.message;
    } else if (m.type === "user") log.push({ kind: "user", key: m.id, text: m.text });
    else if (m.type === "shell") log.push({ kind: "shell", key: m.id, command: m.command, output: m.output?.output, status: m.status });
    else if (m.type === "location-switched") log.push({ kind: "note", key: m.id, text: `Moved to ${m.location?.directory || "another folder"}` });
    else if (m.type === "compaction") log.push({ kind: "note", key: m.id, text: m.status === "running" ? "Compacting the conversation…" : "Conversation compacted" });
  }
  if (turn.idle?.error && !error) error = turn.idle.error.message;
  const first = turn.users[0] || turn.items[0];
  const last = turn.items[turn.items.length - 1];
  return {
    log,
    answer,
    error,
    startedAt: first?.time.created,
    endedAt: turn.idle?.time.created ?? (running ? undefined : last?.time.created),
    lastAssistant,
  };
}

/** Tokens a turn used, over all its model calls: read (of which from the cache) and written (with thinking). */
export function turnUsage(items: Msg[]): { read: number; cached: number; wrote: number } {
  const u = { read: 0, cached: 0, wrote: 0 };
  for (const m of items) {
    if (m.type !== "assistant" || !m.tokens) continue;
    u.read += m.tokens.input + m.tokens.cache.read + m.tokens.cache.write;
    u.cached += m.tokens.cache.read;
    u.wrote += m.tokens.output + m.tokens.reasoning;
  }
  return u;
}

export function formatDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

export function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 100_000) return (n / 1000).toFixed(1).replace(/\.0$/, "") + "K";
  if (n < 1_000_000) return Math.round(n / 1000) + "K";
  return (n / 1_000_000).toFixed(1) + "M";
}
