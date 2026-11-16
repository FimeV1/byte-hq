import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ArrowUp, AudioLines, Check, Clapperboard, Pencil, UserRound, Cpu, FileText, GitBranch, ImagePlus, MessageSquare, Plus, Sparkles, Undo2, ShieldAlert, ShieldCheck, Square, TriangleAlert, Wrench, X, Mic, LoaderCircle, Globe } from "lucide-react";
import {
  allowAllOn, cancelQueued, checkGit, checkQuietly, chooseModel, currentModel, currentSession, draftCanCopy, currentPersona, isAuto, isPhone, setWebSearch, webSearchOn, isChatMode, makeMedia, openModal, remember, setChatMode, setPersona, openModels, redoTurns, setDraftCopy, replyPermission, setAuto, setState, sendPrompt, setAllowAll, setVoiceOpen, steerNow, stop, toast, useStore, type Chat,
} from "./store";
import type { Attachment, Form, InboxItem, Model, PermissionRequest } from "./types";
import { formatTokens, turnUsage } from "./turns";
import { FormCard } from "./FormCard";
import { CopyBar } from "./CopyBar";
import { primeVoiceAudio } from "./VoiceMode";
import { Popover } from "./ui";
import { canDictate, startDictation } from "./dictation";
import { pdfText } from "./pdf";

/** Dictation: press to talk, press again to put the words into the box (Esc or a long silence never sends anything). */
function MicButton({ hasVoice, onText }: { hasVoice: boolean; onText: (t: string) => void }) {
  const [phase, setPhase] = useState<"idle" | "rec" | "busy">("idle");
  const rec = useRef<Awaited<ReturnType<typeof startDictation>> | null>(null);
  useEffect(() => () => rec.current?.cancel(), []);
  if (!canDictate(hasVoice)) return null;
  const click = async () => {
    if (phase === "busy") return;
    if (phase === "idle") {
      try {
        rec.current = await startDictation(hasVoice);
        setPhase("rec");
      } catch (e) {
        toast(`Can't listen: ${e instanceof Error ? e.message : e}`);
      }
      return;
    }
    setPhase("busy");
    try {
      const t = await rec.current!.stop();
      if (t) onText(t);
      else toast("Didn't catch anything.", "info");
    } catch (e) {
      toast(`Dictation failed: ${e instanceof Error ? e.message : e}`);
    } finally {
      rec.current = null;
      setPhase("idle");
    }
  };
  const label = phase === "rec" ? "Stop and type what I said" : phase === "busy" ? "Writing it down…" : "Dictate (speak instead of typing)";
  return (
    <button type="button" className={"round mic" + (phase === "rec" ? " rec" : "")} onClick={click} title={label} aria-label={label} aria-pressed={phase === "rec"}>
      {phase === "busy" ? <LoaderCircle size={17} className="spin" /> : <Mic size={17} />}
    </button>
  );
}
import { ToolsBanner } from "./Help";
import { matchPrompts, SlashMenu } from "./Prompts";

const MAX_FILE = 20 * 1024 * 1024;

function readFile(f: File): Promise<Attachment> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve({ id: crypto.randomUUID(), name: f.name || "pasted-image.png", mime: f.type || "application/octet-stream", dataUrl: String(r.result), size: f.size });
    r.onerror = () => reject(r.error);
    r.readAsDataURL(f);
  });
}

const isPdf = (f: File) => f.type === "application/pdf" || /\.pdf$/i.test(f.name);
/** A PDF goes to the model as its text (most models can't read PDF files). A PDF with no text (a scan) goes as it is. */
async function readPdf(f: File): Promise<Attachment> {
  try {
    const { text, pages, cut } = await pdfText(f);
    if (!text.trim()) {
      toast(`${f.name} has no text in it (a scan?), so it's sent as a file: only models that read PDFs will see it.`, "info");
      return readFile(f);
    }
    const head = `[Text of ${f.name}, ${pages} page${pages === 1 ? "" : "s"}${cut ? ", cut short: the rest was too long" : ""}]\n\n`;
    const body = new TextEncoder().encode(head + text);
    let bin = "";
    for (let i = 0; i < body.length; i += 0x8000) bin += String.fromCharCode(...body.subarray(i, i + 0x8000));
    return { id: crypto.randomUUID(), name: f.name.replace(/\.pdf$/i, "") + ".pdf.txt", mime: "text/plain", dataUrl: "data:text/plain;base64," + btoa(bin), size: body.length };
  } catch (e) {
    toast(`Couldn't read ${f.name} (${e instanceof Error ? e.message : e}), so it's sent as a file.`, "info");
    return readFile(f);
  }
}

function AttachmentChip({ a, onRemove }: { a: Attachment; onRemove: () => void }) {
  return (
    <div className="att">
      {a.mime.startsWith("image/") ? <img src={a.dataUrl} alt="" /> : <FileText size={16} />}
      <span>{a.name}</span>
      <button type="button" className="att-x" onClick={onRemove} aria-label={`Remove ${a.name}`}><X size={12} /></button>
    </div>
  );
}

const NO_MODELS: Model[] = [];
const NO_INBOX: InboxItem[] = [];
const NO_PERMS: PermissionRequest[] = [];
const NO_FORMS: Form[] = [];

/** Tokens in the model's context after the latest step (prompt + reply). */
function contextTokens(chat?: Chat): number {
  const msgs = chat?.messages || [];
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i];
    if (m.type === "assistant" && m.tokens && m.tokens.input + m.tokens.output > 0) return m.tokens.input + m.tokens.cache.read + m.tokens.output;
  }
  return 0;
}

function ModelPicker() {
  const backend = useStore((s) => s.current?.space.backend);
  const models = useStore((s) => (backend ? s.models[backend] : undefined) || NO_MODELS);
  const ref = useStore((s) => currentModel(s));
  const auto = useStore((s) => isAuto(s));
  const model = models.find((m) => m.id === ref?.id && m.providerID === ref?.providerID);
  const variant = ref?.variant && ref.variant !== "default" ? ref.variant : undefined; // the server reports "default" for none
  const short = (n?: string) => (n || "").replace(/\s*\(.*\)$/, "");
  const [q, setQ] = useState("");
  // A cloud key can bring hundreds of models: search them, and show the chosen one first.
  const { shown, matching } = useMemo(() => {
    const t = q.trim().toLowerCase();
    const hits = t ? models.filter((m) => `${m.name} ${m.id} ${m.providerID}`.toLowerCase().includes(t)) : models;
    const cur = hits.filter((m) => m.id === ref?.id && m.providerID === ref?.providerID);
    return { shown: [...cur, ...hits.filter((m) => !cur.includes(m))].slice(0, 60), matching: hits.length };
  }, [models, q, ref?.id, ref?.providerID]);
  return (
    <Popover
      trigger={(_, toggle) => (
        <button type="button" className="chip" onClick={toggle} title="Choose a model">
          {auto ? <Sparkles size={16} /> : <Cpu size={16} />}
          {/* Auto shows no model name: the chat's stored model is only what it last used (a new chat shows the default), and
              the line under the box says what Auto actually picked. */}
          <span>{auto ? "Auto" : `${model?.name || ref?.id || "No model"}${variant ? ` · ${variant}` : ""}`}</span>
        </button>
      )}
    >
      {(close) => (
        <>
          <button type="button" className="pop-item" onClick={() => (close(), setAuto(true))}>
            <Sparkles size={16} />
            <span className="grow">Auto<small>Your main model when it's free, otherwise the fallback. Reviews and fixes its own changes.</small></span>
            {auto && <Check size={15} />}
          </button>
          <div className="pop-sep" />
          <div className="pop-head">Or always use</div>
          {models.length === 0 && <div className="pop-head">No models on this server yet</div>}
          {models.length > 12 && (
            <input className="input pop-search" autoFocus placeholder={`Search ${models.length} models`} value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.stopPropagation()} />
          )}
          {shown.map((m) => {
            const on = !auto && m.id === ref?.id && m.providerID === ref?.providerID;
            return (
              <button key={m.providerID + "/" + m.id} type="button" className="pop-item" onClick={() => (close(), chooseModel({ id: m.id, providerID: m.providerID }))}>
                <span className="grow">{m.name}<small>{models.length > 12 ? `${m.providerID} · ` : ""}{formatTokens(m.limit.context)} context</small></span>
                {on && <Check size={15} />}
              </button>
            );
          })}
          {models.length > 12 && shown.length < matching && <div className="pop-head">{matching - shown.length} more: type to narrow down</div>}
          <div className="pop-sep" />
          <button type="button" className="pop-item" onClick={() => (close(), openModels(backend))}>
            <Plus size={16} /><span className="grow">Add models…</span>
          </button>
          {!auto && model && model.variants.length > 0 && (
            <>
              <div className="pop-sep" />
              <div className="pop-head">Thinking</div>
              {[undefined, ...model.variants.map((v) => v.id)].map((v) => (
                <button key={v || "default"} type="button" className="pop-item" onClick={() => (close(), chooseModel({ id: model.id, providerID: model.providerID, ...(v ? { variant: v } : {}) }))}>
                  <span className="grow">{v ? v[0].toUpperCase() + v.slice(1) : "Default"}</span>
                  {variant === v && <Check size={15} />}
                </button>
              ))}
            </>
          )}
        </>
      )}
    </Popover>
  );
}

function PermissionMode() {
  const on = useStore((s) => allowAllOn(s));
  return (
    <Popover
      align="left"
      trigger={(_, toggle) => (
        <button type="button" className={"round" + (on ? " on" : "")} onClick={toggle} title="Permissions for this chat" aria-label="Permissions for this chat">
          {on ? <ShieldAlert size={17} /> : <ShieldCheck size={17} />}
        </button>
      )}
    >
      {(close) => (
        <>
          <div className="pop-head">Permissions for this chat</div>
          <button type="button" className="pop-item" onClick={() => (close(), setAllowAll(false))}>
            <ShieldCheck size={16} />
            <span className="grow">Ask before risky actions<small>Uses the rules in the server's config</small></span>
            {!on && <Check size={15} />}
          </button>
          <button type="button" className="pop-item" onClick={() => (close(), setAllowAll(true))}>
            <ShieldAlert size={16} />
            <span className="grow">Allow everything<small>Runs any command and edit without asking</small></span>
            {on && <Check size={15} />}
          </button>
        </>
      )}
    </Popover>
  );
}

/** Plain chats: Chat (no tools, any model) or Agent (reads and edits files, runs commands). */
function ModeChip({ chat }: { chat: boolean }) {
  const personas = useStore((s) => s.personas);
  const persona = useStore((s) => currentPersona(s));
  const web = useStore((s) => chat && webSearchOn(s));
  return (
    <Popover
      align="left"
      trigger={(_, toggle) => (
        <button type="button" className="chip modechip" onClick={toggle} title={chat ? "Chat: just talks, no files or commands" : "Agent: can read and edit files and run commands"}>
          {chat ? <MessageSquare size={15} /> : <Wrench size={15} />}
          {web && <Globe size={14} aria-label="searches the web" />}
          {persona && <UserRound size={14} className="persona-ic" aria-label={`persona: ${persona.name}`} />}
          <span>{chat ? "Chat" : "Agent"}{persona ? ` · ${persona.name}` : ""}</span>
        </button>
      )}
    >
      {(close) => (
        <>
          <div className="pop-head">This chat</div>
          <button type="button" className="pop-item" onClick={() => (close(), setChatMode(true))}>
            <MessageSquare size={16} />
            <span className="grow">Chat<small>Just talks. No files or commands, so any model works, and replies start faster.</small></span>
            {chat && <Check size={15} />}
          </button>
          <button type="button" className="pop-item" onClick={() => (close(), setChatMode(false))}>
            <Wrench size={16} />
            <span className="grow">Agent<small>Can read and edit files and run commands in this chat's folder. Needs a model with tool calls.</small></span>
            {!chat && <Check size={15} />}
          </button>
          {chat && (
            <button type="button" className="pop-item" onClick={() => (close(), setWebSearch(!web))}>
              <Globe size={16} />
              <span className="grow">Search the web<small>Lets the model look things up and read pages (a free public search), and list its sources. Needs a model with tool calls.</small></span>
              {web && <Check size={15} />}
            </button>
          )}
          <div className="pop-sep" />
          <div className="pop-head">Persona</div>
          <button type="button" className="pop-item" onClick={() => (close(), setPersona(null))}>
            <UserRound size={16} /><span className="grow">None<small>Just your custom instructions</small></span>
            {!persona && <Check size={15} />}
          </button>
          {personas.map((p) => (
            <button key={p.id} type="button" className="pop-item" onClick={() => (close(), setPersona(p.id))}>
              <UserRound size={16} /><span className="grow">{p.name}<small className="clamp2">{p.instructions}</small></span>
              {persona?.id === p.id && <Check size={15} />}
            </button>
          ))}
          <button type="button" className="pop-item" onClick={() => (close(), openModal("personal"))}>
            <Pencil size={15} /><span className="grow">Edit personas, instructions and memory…</span>
          </button>
        </>
      )}
    </Popover>
  );
}

type MediaKind = "image" | "video";
/** Make an image (or a video, when the key allows it) instead of sending a message. */
function MediaButton({ kinds, on, setOn }: { kinds: MediaKind[]; on: MediaKind | null; setOn: (k: MediaKind | null) => void }) {
  const icon = on === "video" ? <Clapperboard size={17} /> : <ImagePlus size={17} />;
  if (kinds.length === 1) {
    const k = kinds[0];
    return (
      <button type="button" className={"round" + (on ? " media-on" : "")} onClick={() => setOn(on ? null : k)} title={on ? "Back to messages" : `Make ${k === "image" ? "an image" : "a video"}`} aria-label={`Make ${k === "image" ? "an image" : "a video"}`} aria-pressed={!!on}>
        {k === "video" ? <Clapperboard size={17} /> : <ImagePlus size={17} />}
      </button>
    );
  }
  return (
    <Popover
      align="left"
      trigger={(_, toggle) => (
        <button type="button" className={"round" + (on ? " media-on" : "")} onClick={on ? () => setOn(null) : toggle} title={on ? "Back to messages" : "Make an image or a video"} aria-label="Make an image or a video" aria-pressed={!!on}>
          {icon}
        </button>
      )}
    >
      {(close) => (
        <>
          <div className="pop-head">Make with the Byte API</div>
          <button type="button" className="pop-item" onClick={() => (close(), setOn("image"))}>
            <ImagePlus size={16} /><span className="grow">An image<small>Describe it; attach a picture to change that one instead</small></span>
          </button>
          <button type="button" className="pop-item" onClick={() => (close(), setOn("video"))}>
            <Clapperboard size={16} /><span className="grow">A video<small>A few seconds long; takes a few minutes</small></span>
          </button>
        </>
      )}
    </Popover>
  );
}

function PermissionCard({ req }: { req: PermissionRequest }) {
  return (
    <div className="perm">
      <div className="perm-title"><TriangleAlert size={16} /><span>{req.message || `Allow this ${req.action === "shell" ? "command" : req.action}?`}</span></div>
      <pre>{req.resources.join("\n")}</pre>
      <div className="perm-btns">
        <button type="button" className="btn" onClick={() => replyPermission(req, "reject")}>Deny</button>
        {!!req.save?.length && (
          <button type="button" className="btn" onClick={() => replyPermission(req, "always")} title={`Always allow: ${req.save.join(", ")}`}>Always allow</button>
        )}
        <button type="button" className="btn primary" onClick={() => replyPermission(req, "once")}>Allow once</button>
      </div>
    </div>
  );
}

function QueuedRow({ item, running }: { item: InboxItem; running: boolean }) {
  return (
    <div className="queued">
      <span className="q-tag">{!running ? "Waiting" : item.delivery === "steer" ? "Next" : "Queued"}</span>
      <span className="q-text">{item.payload?.text || item.type}</span>
      {!running ? (
        <button type="button" className="btn primary" onClick={() => steerNow(item)}>Send now</button>
      ) : item.delivery === "queue" && (
        <button type="button" className="btn" onClick={() => steerNow(item)} title="Send as soon as the current step finishes, instead of after the whole turn">Steer</button>
      )}
      <button type="button" className="act" onClick={() => cancelQueued(item)} aria-label="Remove queued message" title="Remove"><X size={15} /></button>
    </div>
  );
}

export function Composer() {
  const appName = useStore((s) => s.appName);
  const hasVoice = useStore((s) => !!s.voiceName);
  const cur = useStore((s) => s.current);
  const sid = cur?.sessionId || undefined;
  const running = useStore((s) => (sid ? !!s.active[sid] : false));
  const chat = useStore((s) => (sid ? s.chat[sid] : undefined));
  const inbox = chat?.inbox || NO_INBOX;
  const perms = chat?.permissions || NO_PERMS;
  const forms = chat?.forms || NO_FORMS;
  const revert = useStore((s) => currentSession(s)?.revert);
  const editing = useStore((s) => !!sid && s.editing === sid);
  const restore = useStore((s) => s.restoreDraft);
  const copyChat = useStore((s) => !!currentSession(s)?.metadata?.hqCopy);
  // A project, or a plain chat in a git repository: either can work on a copy.
  const inProject = useStore((s) => draftCanCopy(s));
  const draftSpace = useStore((s) => (s.current && !s.current.sessionId ? s.current.space : null));
  useEffect(() => void (draftSpace && checkGit(draftSpace)), [draftSpace]); // also covers a draft restored at startup
  const draftCopy = useStore((s) => s.draft.copy);
  const autoNote = useStore((s) => (sid ? s.autoNote[sid] : ""));
  const auto = useStore((s) => isAuto(s));
  const [text, setText] = useState("");
  const [files, setFiles] = useState<Attachment[]>([]);
  const backendId = cur?.space.backend;
  const plain = !!cur && !cur.space.projectId;
  const chatMode = useStore((s) => isChatMode(s));
  const makers = useStore((s) => (backendId ? s.makers[backendId] : undefined));
  const kinds = (["image", "video"] as const).filter((k) => !!makers?.[k]);
  const [mediaMode, setMediaMode] = useState<MediaKind | null>(null);
  useEffect(() => setMediaMode(null), [backendId]);
  const model = useStore((s) => currentModel(s));
  // A model HQ added that was never tried gets one quiet test, so a model that can't edit files says so up front.
  useEffect(() => void (backendId && !auto && !chatMode && checkQuietly(backendId, model)), [backendId, model?.providerID, model?.id, auto, chatMode]); // eslint-disable-line react-hooks/exhaustive-deps
  // Saved prompts: "/" at the start of the box opens the menu.
  const prompts = useStore((s) => s.prompts);
  const [slashOff, setSlashOff] = useState(false);
  const [slashAt, setSlashAt] = useState(0);
  const slash = slashOff || /^\/(image|video|remember)\b/i.test(text) ? null : matchPrompts(prompts, text);
  useEffect(() => void (!text.startsWith("/") && setSlashOff(false)), [text]);
  useEffect(() => setSlashAt(0), [slash?.length]);
  const insert = useStore((s) => s.insertText);
  useEffect(() => {
    if (!insert) return;
    setText(insert.text);
    setState({ insertText: null });
    requestAnimationFrame(() => ta.current?.focus());
  }, [insert]);
  const pickPrompt = (p: (typeof prompts)[number] | "manage") => {
    if (p === "manage") return setText(""), openModal("prompts");
    setText(p.text);
    requestAnimationFrame(() => ta.current?.focus());
  };
  const ta = useRef<HTMLTextAreaElement>(null);
  const picker = useRef<HTMLInputElement>(null);
  const addFiles = async (list: FileList | File[]) => {
    for (const f of Array.from(list)) {
      if (f.size > MAX_FILE) {
        toast(`${f.name} is over 20 MB`);
        continue;
      }
      const a = await (isPdf(f) ? readPdf(f) : readFile(f)).catch(() => null);
      if (a) setFiles((x) => [...x, a]);
    }
  };
  const draftKey = sid || (cur ? "new:" + cur.space.directory : "");

  // Each chat keeps its own unsent text.
  const drafts = useRef(new Map<string, string>());
  const lastKey = useRef(draftKey);
  useEffect(() => {
    drafts.current.set(lastKey.current, text);
    lastKey.current = draftKey;
    setText(drafts.current.get(draftKey) || "");
    setFiles([]);
    // Not on touch screens: focusing pops the keyboard up on every chat switch and squashes the page.
    if (!matchMedia("(pointer: coarse)").matches) ta.current?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draftKey]);

  // After an undo, the undone request comes back into the box (only if the box is empty).
  useEffect(() => {
    if (restore && restore.sessionId === sid) {
      setText((t) => t || restore.text);
      setState({ restoreDraft: null });
      ta.current?.focus();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [restore]);

  useLayoutEffect(() => {
    const el = ta.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 240) + "px";
  }, [text]);

  const send = () => {
    const t = text.trim();
    if (!t && !files.length) return;
    // "/remember …": a fact every chat is told from now on.
    const mem = /^\/remember\s+([\s\S]+)/i.exec(t);
    if (mem && !files.length) {
      remember(mem[1]);
      setText("");
      return;
    }
    // "/image a cat" or the image button: make one instead of sending a message.
    const typed = /^\/(image|video)\s+([\s\S]+)/i.exec(t);
    const kind = mediaMode || (typed && kinds.includes(typed[1].toLowerCase() as MediaKind) ? (typed[1].toLowerCase() as MediaKind) : null);
    if (kind) {
      const prompt = mediaMode ? t : typed![2].trim();
      if (!prompt) return toast(`Describe the ${kind} to make`, "info");
      if (running) return toast("Wait for the reply to finish first", "info");
      const start = files.find((f) => f.mime.startsWith("image/"));
      setText("");
      setFiles([]);
      setMediaMode(null);
      makeMedia(kind, prompt, start?.dataUrl);
      return;
    }
    const sent = files;
    setText("");
    setFiles([]);
    sendPrompt(t, sent).catch(() => {
      // failed: give everything back
      setText((now) => now || t);
      setFiles((now) => (now.length ? now : sent));
    });
  };
  const ctx = contextTokens(chat);
  const used = useMemo(() => { const u = turnUsage(chat?.messages || []); return u.read + u.wrote; }, [chat?.messages]);
  const empty = !text.trim() && !files.length;
  const showStop = running && empty;

  return (
    <div className="dock">
      <div className="dock-in">
        {(perms.length > 0 || inbox.length > 0 || forms.length > 0 || !!revert || !!copyChat) && (
          <div className="stack">
            <CopyBar />
            {revert && (
              <div className="queued undo-bar">
                <Undo2 size={15} />
                <span className="q-text">
                  {editing
                    ? "Editing your message: its reply and everything after it are hidden. Send to replace them, or Redo to keep them."
                    : `Undid ${revert.files?.length ? `changes to ${revert.files.length} file${revert.files.length === 1 ? "" : "s"}` : "the changes"}. Sending a message makes it final.`}
                </span>
                <button type="button" className="btn primary" onClick={redoTurns}>Redo</button>
              </div>
            )}
            {inbox.filter((i) => i.type === "user").map((i) => <QueuedRow key={i.id} item={i} running={running} />)}
            {perms.map((p) => <PermissionCard key={p.id} req={p} />)}
            {forms.map((f) => <FormCard key={f.id} form={f} />)}
          </div>
        )}
        {!auto && !chatMode && <ToolsBanner backend={backendId} model={model} />}
        {slash && <SlashMenu items={slash} index={slashAt} onPick={pickPrompt} onHover={setSlashAt} />}
        <div
          className="composer"
          onClick={(e) => e.target === e.currentTarget && ta.current?.focus()}
          onDragOver={(e) => e.dataTransfer.types.includes("Files") && e.preventDefault()}
          onDrop={(e) => {
            if (!e.dataTransfer.files.length) return;
            e.preventDefault();
            addFiles(e.dataTransfer.files);
          }}
        >
          {files.length > 0 && (
            <div className="atts">{files.map((a) => <AttachmentChip key={a.id} a={a} onRemove={() => setFiles((x) => x.filter((y) => y.id !== a.id))} />)}</div>
          )}
          <textarea
            ref={ta}
            rows={1}
            value={text}
            placeholder={
              // Shorter on a phone: a placeholder that wraps is cut off (the box is one line high until you type).
              mediaMode ? `Describe the ${mediaMode} to make${mediaMode === "image" && !isPhone() ? " (attach a picture to change it instead)" : ""}`
              : running ? (isPhone() ? "Queue or steer" : "Queue a message, or steer the work")
              : chatMode ? (isPhone() ? `Message ${appName}` : `Message ${appName} · / for saved prompts`)
              : isPhone() ? `Ask ${appName}` : `Ask ${appName} to do something · / for saved prompts`
            }
            onChange={(e) => setText(e.target.value)}
            onPaste={(e) => {
              const pasted = Array.from(e.clipboardData.files);
              if (pasted.length) {
                e.preventDefault();
                addFiles(pasted);
              }
            }}
            onKeyDown={(e) => {
              if (slash) {
                const last = slash.length; // the "Edit saved prompts…" row
                if (e.key === "ArrowDown") return e.preventDefault(), setSlashAt((i) => (i >= last ? 0 : i + 1));
                if (e.key === "ArrowUp") return e.preventDefault(), setSlashAt((i) => (i <= 0 ? last : i - 1));
                if (e.key === "Escape") return e.preventDefault(), setSlashOff(true);
                // Enter picks a prompt only when one matches, so a message that starts with "/" can still be sent.
                if ((e.key === "Enter" || e.key === "Tab") && !e.shiftKey && slash.length > 0 && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  return pickPrompt(slashAt === last ? "manage" : slash[slashAt]);
                }
              }
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                send();
              }
            }}
          />
          <div className="c-row">
            <button type="button" className="round" onClick={() => picker.current?.click()} title="Attach files" aria-label="Attach files"><Plus size={18} /></button>
            <input ref={picker} type="file" multiple hidden onChange={(e) => (e.target.files && addFiles(e.target.files), (e.target.value = ""))} />
            {/* Phone, Agent mode: the row is full (the model name was cut to two letters); /image still works there. */}
            {kinds.length > 0 && (chatMode || !isPhone() || !!mediaMode) && <MediaButton kinds={kinds} on={mediaMode} setOn={(k) => (setMediaMode(k), ta.current?.focus())} />}
            {plain && <ModeChip chat={chatMode} />}
            {!chatMode && <PermissionMode />}
            {inProject && (
              <button
                type="button"
                className={"chip copychip" + (draftCopy ? " on" : "")}
                onClick={() => setDraftCopy(!draftCopy)}
                title={draftCopy ? "Works on a copy: test it there, then apply to the live project" : "Works directly on the live project"}
              >
                <GitBranch size={15} />
                <span>{draftCopy ? "On a copy" : "Live"}</span>
              </button>
            )}
            <span className="spacer" />
            <ModelPicker />
            <MicButton hasVoice={hasVoice} onText={(t) => (setText((x) => (x.trim() ? x.replace(/\s*$/, " ") + t : t)), ta.current?.focus())} />
            {hasVoice && (
              <button
                type="button"
                className="round"
                onClick={() => (primeVoiceAudio(), setVoiceOpen(true))}
                title="Talk to it (voice conversation)"
                aria-label="Start voice conversation"
              >
                <AudioLines size={17} />
              </button>
            )}
            {showStop ? (
              <button type="button" className="send stop" onClick={stop} aria-label="Stop" title="Stop"><Square size={13} fill="currentColor" /></button>
            ) : (
              <button type="button" className="send" onClick={send} disabled={empty} aria-label={mediaMode ? `Make the ${mediaMode}` : "Send"} title={mediaMode ? `Make the ${mediaMode}` : running ? "Add to queue" : "Send"}>
                {mediaMode === "video" ? <Clapperboard size={17} /> : mediaMode ? <ImagePlus size={17} /> : <ArrowUp size={18} />}
              </button>
            )}
          </div>
        </div>
        <div className="under">
          {/* Only while Auto is on: after switching to a manual model it was stale and looked like Auto was still choosing. */}
          {auto && autoNote && <span title="What Auto chose for the last message">Auto: {autoNote}</span>}
          {ctx > 0 && <span>Context: {formatTokens(ctx)}</span>}
          {used > 0 && <span title="Tokens read and written by every answer in this chat (reading the same history again counts each time)">This chat: {formatTokens(used)}</span>}
        </div>
      </div>
    </div>
  );
}
