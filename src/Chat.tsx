import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  BookmarkPlus, Check, ChevronRight, Copy, Download, LifeBuoy, MessageCircleQuestion, Pencil, Shuffle, Square, Volume2, Undo2, FilePen, FilePlus, FileText, GitBranch, Globe, LoaderCircle, RotateCw, Search, Terminal, TriangleAlert, Users, Wrench,
} from "lucide-react";
import { askAnotherModel, currentSession, dismissMediaJob, editMessage, forkSession, isAuto, lastActivityAt, makeMedia, openByteHelp, sendPrompt, undoTurn, useStore, type MediaJob } from "./store";
import { readAloud } from "./speech";
import type { AssistantMsg, FileDiff, Media, Model, ModelRef, Msg, Part } from "./types";
import { buildTurns, formatDuration, formatTokens, turnUsage, viewTurn, type LogRow, type Turn } from "./turns";
import { Markdown } from "./Markdown";
import { Brand, Popover } from "./ui";
import { EditedFiles } from "./EditedFiles";
import { ReviewCard } from "./ReviewCard";
import { NotesCard } from "./NotesCard";
import { ErrorNotice, explainError } from "./Help";

type ToolPart = Extract<Part, { type: "tool" }>;

const str = (v: unknown) => (typeof v === "string" ? v : v == null ? "" : JSON.stringify(v));

/** One-line description of a tool call, e.g. "Edited src/app.ts". */
/** What a running turn is doing right now, in a few words, for the "Working for …" header (otherwise you have to
 *  open the transcript to see that a test was running). Reads only the newest step. */
function currentActivity(turn: Turn, last: AssistantMsg | undefined): string {
  const tail = turn.items[turn.items.length - 1];
  if (tail?.type === "compaction" && tail.status === "running") return "compacting the conversation";
  if (tail?.type === "shell" && !tail.time.completed) return `running ${shorten(tail.command, 48)}`;
  if (!last || last.time.completed) return "waiting for the model";
  const part = last.content[last.content.length - 1];
  if (!part) return "reading the conversation";
  if (part.type === "tool" && (part.state.status === "streaming" || part.state.status === "running")) {
    const d = describeTool(part);
    const detail = /[\\/]/.test(d.detail) && !/\s/.test(d.detail) ? d.detail.split(/[\\/]/).pop() || d.detail : d.detail;
    return `${d.verb.toLowerCase()}${detail ? " " + shorten(detail, 48) : ""}`;
  }
  if (part.type === "reasoning") return "thinking";
  if (part.type === "text") return "writing";
  return "working";
}
/** A command or tool is running right now: silence from the model is expected, not a sign it's stuck. */
function toolRunning(turn: Turn, last: AssistantMsg | undefined): boolean {
  const tail = turn.items[turn.items.length - 1];
  if (tail?.type === "shell" && !tail.time.completed) return true;
  if (tail?.type === "compaction" && tail.status === "running") return true;
  const part = last && !last.time.completed ? last.content[last.content.length - 1] : undefined;
  return part?.type === "tool" && (part.state.status === "running" || part.state.status === "streaming");
}
const shorten = (t: string, n: number) => {
  const one = t.replace(/\s+/g, " ").trim();
  return one.length > n ? one.slice(0, n - 1) + "…" : one;
};

function describeTool(p: ToolPart): { icon: JSX.Element; verb: string; detail: string } {
  const input: Record<string, unknown> = typeof p.state.input === "string" ? {} : p.state.input;
  const done = p.state.status === "completed";
  const path = str(input.path || input.filePath || input.file);
  // OpenCode runs MCP tools inside its code-mode `execute` tool: describe the first tool the script calls.
  let call: Record<string, unknown> = input;
  let name = p.name;
  if (p.name === "execute") {
    const code = str(input.code);
    const m = /tools\.([\w$]+)(?:\.([\w$]+)|\[["']([^"']+)["']\])\s*\(([^)]*)/.exec(code);
    if (m) {
      name = m[2] || m[3];
      // Read simple `key: "value"` arguments as text. Never evaluate the model's code here.
      call = {};
      for (const a of m[4].matchAll(/([\w$]+)\s*:\s*(["'`])((?:\\.|(?!\2).)*)\2/g)) call[a[1]] = a[3];
      if (!/^browser_/.test(name)) return { icon: <Wrench size={14} />, verb: done ? "Used" : "Using", detail: `${m[1]}.${name}` };
    } else return { icon: <Terminal size={14} />, verb: done ? "Ran a script" : "Running a script", detail: "" };
  }
  const b = /^browser_(.+)$/.exec(name)?.[1]; // Playwright MCP tools, e.g. browser_navigate
  if (b) {
    const what = str(call.element || call.text || call.url || call.key || "").slice(0, 120);
    const verbs: Record<string, [string, string]> = {
      navigate: ["Opened", "Opening"], navigate_back: ["Went back", "Going back"], click: ["Clicked", "Clicking"],
      type: ["Typed into", "Typing into"], fill_form: ["Filled a form", "Filling a form"], press_key: ["Pressed", "Pressing"],
      snapshot: ["Read the page", "Reading the page"], take_screenshot: ["Looked at the page", "Looking at the page"],
      select_option: ["Selected", "Selecting"], hover: ["Hovered", "Hovering"], wait_for: ["Waited", "Waiting"],
      tabs: ["Switched tabs", "Switching tabs"], evaluate: ["Ran a script on the page", "Running a script on the page"],
    };
    const [past, now] = verbs[b] || [b.replace(/_/g, " "), b.replace(/_/g, " ")];
    return { icon: <Globe size={14} />, verb: done ? past : now, detail: b === "type" ? str(call.element) : what };
  }
  switch (p.name) {
    case "question": return { icon: <MessageCircleQuestion size={14} />, verb: done ? "Asked you" : "Asking you", detail: str((input.questions as { header?: string }[] | undefined)?.map((q) => q.header).join(", ")) };
    case "read": return { icon: <FileText size={14} />, verb: done ? "Read" : "Reading", detail: path };
    case "write": return { icon: <FilePlus size={14} />, verb: done ? "Wrote" : "Writing", detail: path };
    case "edit": return { icon: <FilePen size={14} />, verb: done ? "Edited" : "Editing", detail: path };
    case "shell": case "bash": case "execute": return { icon: <Terminal size={14} />, verb: done ? "Ran" : "Running", detail: str(input.command || input.code) };
    case "glob": case "grep": return { icon: <Search size={14} />, verb: done ? "Searched" : "Searching", detail: str(input.pattern || input.query) };
    case "webfetch": return { icon: <Globe size={14} />, verb: done ? "Fetched" : "Fetching", detail: str(input.url) };
    case "websearch": return { icon: <Globe size={14} />, verb: done ? "Searched the web" : "Searching the web", detail: str(input.query) };
    case "subagent": case "task": return { icon: <Users size={14} />, verb: done ? "Delegated" : "Delegating", detail: str(input.description || input.prompt).slice(0, 120) };
    default: {
      const first = Object.values(input).find((v) => typeof v === "string") as string | undefined;
      return { icon: <Wrench size={14} />, verb: p.name.replace(/_/g, " "), detail: (first || "").slice(0, 120) };
    }
  }
}

const ToolRow = memo(function ToolRow({ part }: { part: ToolPart }) {
  const [open, setOpen] = useState(false);
  const d = describeTool(part);
  const st = part.state;
  const busy = st.status === "streaming" || st.status === "running";
  const output = st.status === "completed" ? (st.content || []).map((c) => c.text || "").join("\n") : st.status === "error" ? st.error.message : "";
  return (
    <div className={"tool" + (st.status === "error" ? " err" : "")}>
      <button type="button" className="tool-head" onClick={() => setOpen(!open)} aria-expanded={open}>
        {busy ? <LoaderCircle size={14} style={{ animation: "spin 0.9s linear infinite" }} /> : st.status === "error" ? <TriangleAlert size={14} /> : d.icon}
        <span className="label">{d.verb} {d.detail && <code>{d.detail}</code>}</span>
      </button>
      {open && (
        <div className="tool-body">
          <span className="k">Input</span>
          {typeof st.input === "string" ? st.input : JSON.stringify(st.input, null, 2)}
          {output && (<><span className="k">{st.status === "error" ? "Error" : "Result"}</span>{output.length > 6000 ? output.slice(0, 6000) + "\n… (cut)" : output}</>)}
        </div>
      )}
    </div>
  );
});

function LogView({ rows }: { rows: LogRow[] }) {
  return (
    <div className="log">
      {rows.map((r) => {
        switch (r.kind) {
          case "reasoning": return <div key={r.key} className={"log-reason" + (r.live ? " caret" : "")}>{r.text.trim()}</div>;
          case "text": return <Markdown key={r.key} className="log-text" text={r.text} />;
          case "tool": return <ToolRow key={r.key} part={r.part} />;
          case "user": return <div key={r.key} className="log-user">{r.text}</div>;
          case "shell": return (
            <div key={r.key} className="tool">
              <div className="tool-head"><Terminal size={14} /><span className="label">Ran <code>{r.command}</code></span></div>
              {r.output && <div className="tool-body">{r.output.slice(0, 6000)}</div>}
            </div>
          );
          case "note": return <div key={r.key} className="log-note">{r.text}</div>;
        }
      })}
    </div>
  );
}

/** Seconds counter that only ticks while a turn is running. */
function useNow(running: boolean) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [running]);
  return now;
}

function copy(text: string, done: () => void) {
  navigator.clipboard.writeText(text).then(done).catch(() => {});
}
export function CopyButton({ text, label }: { text: string; label: string }) {
  const [ok, setOk] = useState(false);
  return (
    <button type="button" className="act" title={label} aria-label={label} onClick={() => copy(text, () => (setOk(true), setTimeout(() => setOk(false), 1200)))}>
      {ok ? <Check size={16} /> : <Copy size={16} />}
    </button>
  );
}

const NO_MODELS: Model[] = [];
/** Send this message to another model, in a new chat branched from just before it. */
function AskAnother({ userId, text, used }: { userId: string; text: string; used?: ModelRef }) {
  const backend = useStore((s) => s.current?.space.backend);
  const models = useStore((s) => (backend ? s.models[backend] : undefined) || NO_MODELS);
  const [q, setQ] = useState("");
  const others = models.filter((m) => !(m.id === used?.id && m.providerID === used?.providerID));
  const t = q.trim().toLowerCase();
  const shown = (t ? others.filter((m) => `${m.name} ${m.id} ${m.providerID}`.toLowerCase().includes(t)) : others).slice(0, 40);
  if (!others.length) return null;
  return (
    <Popover
      align="right"
      trigger={(_, toggle) => (
        <button type="button" className="act" title="Ask another model (in a new chat, to compare)" aria-label="Ask another model" onClick={toggle}><Shuffle size={16} /></button>
      )}
    >
      {(close) => (
        <>
          <div className="pop-head">Ask another model<small style={{ display: "block" }}>Opens a new chat with the same history and sends this message there</small></div>
          {others.length > 12 && (
            <input className="input pop-search" autoFocus placeholder={`Search ${others.length} models`} value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.stopPropagation()} />
          )}
          {shown.map((m) => (
            <button key={m.providerID + "/" + m.id} type="button" className="pop-item" onClick={() => (close(), askAnotherModel(userId, text, { id: m.id, providerID: m.providerID }))}>
              <span className="grow">{m.name}{others.length > 12 && <small>{m.providerID}</small>}</span>
            </button>
          ))}
        </>
      )}
    </Popover>
  );
}

function ReadAloud({ id, text }: { id: string; text: string }) {
  const on = useStore((s) => s.speaking === id);
  return (
    <button type="button" className={"act" + (on ? " on" : "")} title={on ? "Stop reading" : "Read aloud"} aria-label={on ? "Stop reading" : "Read aloud"} onClick={() => readAloud(id, text)}>
      {on ? <Square size={14} fill="currentColor" /> : <Volume2 size={16} />}
    </button>
  );
}

type TurnProps = { turn: Turn; running: boolean; files?: FileDiff[]; nextUserId?: string; undone?: boolean; canUndo?: boolean; last?: boolean };

const TurnView = memo(
  function TurnView({ turn, running, files, nextUserId, undone, canUndo, last }: TurnProps) {
    const v = useMemo(() => viewTurn(turn, running), [turn, running]);
    // Closed unless the user opens it: the header already says what the model is doing right now.
    const [open, setOpen] = useState(false);
    // Opening the steps jumps to the newest one; a Hide button at the bottom and a sticky header close them from anywhere.
    const logEnd = useRef<HTMLDivElement>(null);
    const head = useRef<HTMLButtonElement>(null);
    const [notes, setNotes] = useState(false);
    const auto = useStore((s) => isAuto(s));
    const now = useNow(running);
    const showLog = open;
    const elapsed = v.startedAt ? (v.endedAt ?? now) - v.startedAt : 0;
    // Nothing at all from the model for 90 s: say so, so a stuck turn doesn't look like slow work.
    const openSid = useStore((s) => s.current?.sessionId);
    const quietMs = running ? now - (lastActivityAt(openSid) ?? v.startedAt ?? now) : 0;
    const userText = turn.users.map((u) => u.text).join("\n\n");
    const hasWork = v.log.length > 0 || running;
    const streaming = running && !!v.lastAssistant && !v.lastAssistant.time.completed;
    // Which model actually answered (each reply records it), so Auto or a manual pick is never a guess.
    const usedRef = v.lastAssistant?.model;
    const backendId = useStore((s) => s.current?.space.backend);
    const usedName = useStore((s) => {
      if (!usedRef) return "";
      const list = s.models[s.current?.space.backend || ""] || [];
      const m = list.find((x) => x.id === usedRef.id && x.providerID === usedRef.providerID);
      return (m?.name || usedRef.id).replace(/\s*\(.*\)$/, "");
    });

    return (
      <div className="turn">
        {turn.users.length > 0 && (
          <div className="user-row">
            {turn.users.map((u) => (
              <div key={u.id} className="user-msg">
                {!!u.files?.length && (
                  <div className="sent-files">
                    {u.files.map((f, i) =>
                      f.mime?.startsWith("image/") && f.data ? (
                        <img key={i} src={`data:${f.mime};base64,${f.data}`} alt={f.name || "image"} />
                      ) : (
                        <span key={i} className="att"><FileText size={16} /><span>{f.name || "file"}</span></span>
                      ),
                    )}
                  </div>
                )}
                {u.text && <div className={"bubble" + (u.pending ? " pending" : "")}>{u.text}</div>}
              </div>
            ))}
            <div className="actions right">
              {canUndo && !undone && !running && turn.userId && (
                <button type="button" className="act" title="Edit and send again (the reply and everything after it are undone; Redo brings them back)" aria-label="Edit message" onClick={() => editMessage(turn.userId!)}>
                  <Pencil size={15} />
                </button>
              )}
              {!running && turn.userId && userText && <AskAnother userId={turn.userId} text={userText} used={usedRef} />}
              <button type="button" className="act" title="Send again" aria-label="Send again" onClick={() => sendPrompt(userText).catch(() => {})}><RotateCw size={16} /></button>
              <CopyButton text={userText} label="Copy message" />
            </div>
          </div>
        )}
        {hasWork && (
          <button
            type="button"
            ref={head}
            className={"worked" + (showLog ? " open" : "") + (running ? " live" : "")}
            onClick={() => {
              const next = !showLog;
              setOpen(next);
              // Closing a long log shrinks the page under the reader: jump (not smooth-scroll) to this header, or the
              // view can sit past the new end and stay blank until the next scroll.
              requestAnimationFrame(() => next
                ? logEnd.current?.scrollIntoView({ block: "end", behavior: "smooth" })
                : head.current?.scrollIntoView({ block: "nearest" }));
            }}
            aria-expanded={showLog}
          >
            <span className={running ? "shimmer" : undefined}>{running ? `Working for ${formatDuration(elapsed)}` : `Worked for ${formatDuration(elapsed)}`}</span>
            {usedName && <span className="worked-model">· {usedName}</span>}
            {running && <span className="worked-now">· {currentActivity(turn, v.lastAssistant)}</span>}
            {quietMs > 90_000 && !toolRunning(turn, v.lastAssistant) && <span className="worked-quiet" title="No output from the model for a while: it may be stuck, still loading, or running a long command. Stop it if it doesn't recover.">· no output for {formatDuration(quietMs)}</span>}
            <ChevronRight size={14} />
          </button>
        )}
        {showLog && v.log.length > 0 && <LogView rows={v.log} />}
        {showLog && v.log.length > 0 && (
          <button
            type="button"
            className="log-hide"
            onClick={() => {
              setOpen(false);
              requestAnimationFrame(() => head.current?.scrollIntoView({ block: "nearest" }));
            }}
          >
            Hide steps
          </button>
        )}
        <div ref={logEnd} />
        {v.answer && <Markdown className={"answer" + (streaming ? " caret" : "")} text={v.answer} />}
        {v.error && <ErrorNotice error={v.error} model={usedRef} backend={backendId} onAgain={last && userText ? () => sendPrompt(userText).catch(() => {}) : undefined} />}
        {!running && turn.idle?.outcome === "interrupted" && <div className="notice">Stopped</div>}
        {files && files.length > 0 && <EditedFiles files={files} />}
        {!running && (v.answer || turn.idle) && (
          <div className="actions left">
            <CopyButton text={v.answer} label="Copy answer" />
            {v.answer && <ReadAloud id={turn.key} text={v.answer} />}
            {/* No steps header to name the model (a plain answer): say it here, so compared answers can be told apart. */}
            {!hasWork && usedName && <span className="answer-model" title="The model that wrote this answer">{usedName}</span>}
            {(() => {
              const u = turnUsage(turn.items);
              if (!u.read && !u.wrote) return null;
              const tip = `This answer: read ${u.read.toLocaleString()} tokens${u.cached ? ` (${u.cached.toLocaleString()} from the cache)` : ""}, wrote ${u.wrote.toLocaleString()}`;
              return <span className="answer-usage" title={tip}>{formatTokens(u.read + u.wrote)} tokens</span>;
            })()}
            <button type="button" className="act" title="Branch into a new chat from here" aria-label="Branch into a new chat from here" onClick={() => forkSession(nextUserId)}><GitBranch size={16} /></button>
            <button type="button" className="act" title="Save lasting facts from this turn to the shared guide" aria-label="Save to guide" onClick={() => setNotes(true)}>
              <BookmarkPlus size={16} />
            </button>
            {canUndo && !undone && files && files.length > 0 && turn.userId && (
              <button type="button" className="act" title="Undo this turn's edits (and any later ones)" aria-label="Undo this turn's edits" onClick={() => undoTurn(turn.userId!)}>
                <Undo2 size={16} />
              </button>
            )}
          </div>
        )}
        {/* Under the answer's own buttons, so its Copy can't be mistaken for copying the review (2026-11-15). */}
        {files && files.length > 0 && !running && !undone && turn.userId && <ReviewCard turnUserId={turn.userId} ask={!!last && !auto} />}
        {notes && <NotesCard request={userText} view={v} files={(files || []).map((f) => f.file)} onClose={() => setNotes(false)} />}
      </div>
    );
  },
  // buildTurns makes new Turn objects every time; re-render only when this turn's content changed.
  (a, b) =>
    a.running === b.running && a.files === b.files && a.nextUserId === b.nextUserId && a.turn.idle === b.turn.idle &&
    a.undone === b.undone && a.canUndo === b.canUndo && a.last === b.last &&
    a.turn.users.length === b.turn.users.length && a.turn.users.every((u, i) => u === b.turn.users[i]) &&
    a.turn.items.length === b.turn.items.length && a.turn.items.every((m, i) => m === b.turn.items[i]),
);

/** An image or video HQ made, with its prompt. */
const MediaCard = memo(function MediaCard({ media }: { media: Media }) {
  const src = `/hq/media/${media.file}`;
  const ext = media.file.split(".").pop();
  const name = `${media.kind}-${media.prompt.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "made"}.${ext}`;
  const [gone, setGone] = useState(false); // deleted in the gallery
  return (
    <div className="turn media-turn">
      {gone ? (
        <div className="media-gone">This {media.kind} was deleted.</div>
      ) : (
        <div className="media-box">
          {media.kind === "image" ? (
            <a href={src} target="_blank" rel="noopener" title="Open full size"><img src={src} alt={media.prompt} loading="lazy" onError={() => setGone(true)} /></a>
          ) : (
            <video src={src} controls playsInline preload="metadata" onError={() => setGone(true)} />
          )}
        </div>
      )}
      <div className="media-cap">{media.prompt}</div>
      <div className="actions left">
        <a className="act" href={src} download={name} title="Download" aria-label="Download"><Download size={16} /></a>
        <CopyButton text={media.prompt} label="Copy the description" />
        <button type="button" className="act" title={`Make another ${media.kind}`} aria-label={`Make another ${media.kind}`} onClick={() => makeMedia(media.kind, media.prompt)}>
          <RotateCw size={16} />
        </button>
      </div>
    </div>
  );
});

/** An image or video being made, or what went wrong. */
function MediaJobCard({ sid, job }: { sid: string; job: MediaJob }) {
  const now = useNow(!job.error);
  const e = job.error ? explainError(job.error, true) : null;
  return (
    <div className="turn media-turn">
      {job.error ? (
        <div className="notice err err-help">
          <div className="err-title">{e?.title || `Couldn't make the ${job.kind}.`}</div>
          <div className="err-hint">{e?.hint || job.error}</div>
          <div className="help-btns">
            {e?.action === "byte" && <button type="button" className="btn" onClick={() => openByteHelp()}><LifeBuoy size={14} /> Byte API help</button>}
            <button type="button" className="btn" onClick={() => (dismissMediaJob(sid, job.id), makeMedia(job.kind, job.prompt))}><RotateCw size={14} /> Try again</button>
            <button type="button" className="linkish" onClick={() => dismissMediaJob(sid, job.id)}>Dismiss</button>
          </div>
        </div>
      ) : (
        <div className="media-job">
          <LoaderCircle size={16} className="spin" />
          <span className="shimmer">Making {job.kind === "image" ? "an image" : "a video"} · {formatDuration(now - job.started)}</span>
          {job.kind === "video" && <small>Videos take a few minutes</small>}
        </div>
      )}
      <div className="media-cap">{job.prompt}</div>
    </div>
  );
}

const NO_FILES: Record<string, FileDiff[]> = {};
const NO_JOBS: MediaJob[] = [];

export function Thread({ sessionId }: { sessionId: string }) {
  const chat = useStore((s) => s.chat[sessionId]);
  const running = useStore((s) => !!s.active[sessionId]);
  // Images and videos still waiting in the inbox (they're sent along with the next prompt) are shown in place already.
  const messages = useMemo(() => {
    const list = chat?.messages || [];
    const waiting: Msg[] = (chat?.inbox || []).flatMap((i) =>
      i.type === "synthetic" && i.payload?.metadata?.hqMedia && !list.some((m) => m.id === i.id)
        ? [{ type: "synthetic" as const, id: i.id, time: i.time, text: i.payload.text, metadata: { hqMedia: i.payload.metadata.hqMedia } }]
        : [],
    );
    if (!waiting.length) return list;
    const at = list.findIndex((m) => m.type === "user" && m.pending);
    return at < 0 ? [...list, ...waiting] : [...list.slice(0, at), ...waiting, ...list.slice(at)];
  }, [chat?.messages, chat?.inbox]);
  const turns = useMemo(() => buildTurns(messages), [messages]);
  const jobs = useStore((s) => s.mediaJobs[sessionId] || NO_JOBS);
  const diffs = chat?.diffs || NO_FILES;
  const revertAt = useStore((s) => currentSession(s)?.revert?.messageID);
  const undoneFrom = revertAt ? turns.findIndex((t) => t.users.some((u) => u.id === revertAt) || t.items.some((m) => m.id === revertAt)) : -1;

  // Follow new output only while the reader is at the bottom; scrolling up to read stops it.
  const scroller = useRef<HTMLDivElement>(null);
  const inner = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  useLayoutEffect(() => {
    stick.current = true;
    const el = scroller.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [sessionId, chat?.loaded]);
  useEffect(() => {
    const el = scroller.current;
    const content = inner.current;
    if (!el || !content) return;
    const onScroll = () => (stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60);
    // When the content shrinks (a steps log or card closed), pull a view left past the new end back in, and work around
    // Safari leaving the uncovered area grey until the next scroll: move 1px and back, and repaint the scroll area for
    // one frame.
    let lastH = content.offsetHeight;
    const ro = new ResizeObserver(() => {
      const h = content.offsetHeight, shrank = h < lastH;
      lastH = h;
      const max = el.scrollHeight - el.clientHeight;
      if (stick.current) el.scrollTop = el.scrollHeight;
      else if (el.scrollTop > max) el.scrollTop = max;
      if (!shrank) return;
      const t = el.scrollTop;
      el.scrollTop = t > 0 ? t - 1 : t + 1;
      el.style.transform = "translateZ(0)";
      requestAnimationFrame(() => {
        el.scrollTop = stick.current ? el.scrollHeight : t;
        el.style.transform = "";
      });
    });
    el.addEventListener("scroll", onScroll, { passive: true });
    ro.observe(content);
    return () => (el.removeEventListener("scroll", onScroll), ro.disconnect());
  }, [sessionId]);
  // Sending a message (or asking for an image) always brings the view back to the bottom.
  const userCount = chat?.messages.reduce((n, m) => n + (m.type === "user" ? 1 : 0), 0) || 0;
  useEffect(() => {
    stick.current = true;
    const el = scroller.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [userCount, jobs.length]);

  return (
    <div className="scroll" ref={scroller}>
      <div className="thread" ref={inner}>
        {chat?.error && <div className="notice err">Could not load this chat: {chat.error}</div>}
        {turns.map((t, i) => (
          <div key={t.key} className={undoneFrom >= 0 && i >= undoneFrom ? "undone" : undefined}>
            {t.media ? <MediaCard media={t.media} /> : <TurnView
              turn={t}
              running={running && i === turns.length - 1 && !t.idle}
              files={t.userId ? diffs[t.userId] : undefined}
              nextUserId={turns[i + 1]?.userId}
              undone={undoneFrom >= 0 && i >= undoneFrom}
              canUndo={!running}
              last={i === turns.length - 1}
            />}
          </div>
        ))}
        {jobs.map((j) => <MediaJobCard key={j.id} sid={sessionId} job={j} />)}
      </div>
    </div>
  );
}

export function EmptyChat({ title, path, appName, onChangeFolder }: { title?: string; path: string; appName: string; onChangeFolder?: () => void }) {
  return (
    <div className="scroll">
      <div className="empty">
        <Brand size={40} />
        <h1>{title ? `New chat in ${title}` : `What should ${appName} do?`}</h1>
        <div className="path">{path}</div>
        {onChangeFolder && <button type="button" className="btn change-folder" onClick={onChangeFolder}>Change folder</button>}
      </div>
    </div>
  );
}
