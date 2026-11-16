import { memo, useEffect, useRef, useState } from "react";
import { ChevronDown, Ellipsis, FileDown, FlaskConical, Folder, FolderInput, FolderOpen, FolderOutput, KeyRound, Monitor, Pin, PinOff, Printer, Search, PanelLeft, Pencil, Plus, Settings, SquarePen, Trash2, X } from "lucide-react";
import {
  chatsSpace, deleteSession, exportChat, moveSession, newChat, openLinked, pinSession, printChat, setChatFolder, setProjectTest, openModal, openSession, projectSpace, removeProject, renameProject, renameSession, toggleSidebar, useStore,
} from "./store";
import type { Backend, Project, Session, Space } from "./types";
import { spaceKey } from "./types";
import { Brand, Popover, RenameInput } from "./ui";

type Hit = { backend: string; sid: string; dir?: string; title: string; snippet: string };

/** Search every chat on every machine (titles and what was said). */
function SearchResults({ q, close }: { q: string; close: () => void }) {
  const [hits, setHits] = useState<Hit[] | null>(null);
  const backends = useStore((s) => s.backends);
  useEffect(() => {
    if (q.trim().length < 2) return setHits(null);
    let live = true;
    setHits(null);
    const t = setTimeout(() => {
      fetch("/hq/search?q=" + encodeURIComponent(q)).then((r) => r.json()).then((h) => live && setHits(h)).catch(() => live && setHits([]));
    }, 300);
    return () => ((live = false), clearTimeout(t));
  }, [q]);
  if (q.trim().length < 2) return <div className="sb-empty">Type at least two letters.</div>;
  if (!hits) return <div className="sb-empty">Searching…</div>;
  if (!hits.length) return <div className="sb-empty">No chats match.</div>;
  const words = q.toLowerCase().split(/\s+/).filter((w) => w.length > 1);
  const mark = (t: string) => {
    const parts = t.split(new RegExp(`(${words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})`, "ig"));
    return parts.map((p, i) => (words.includes(p.toLowerCase()) ? <mark key={i}>{p}</mark> : p));
  };
  return (
    <>
      {hits.map((h) => (
        <button key={h.backend + h.sid} type="button" className="sr" onClick={() => (close(), openLinked({ backend: h.backend, sid: h.sid, dir: h.dir }))}>
          <span className="sr-title">{mark(h.title)}</span>
          <span className="sr-snip">{mark(h.snippet)}</span>
          {backends.length > 1 && <span className="sr-where">{backends.find((b) => b.id === h.backend)?.label || h.backend}</span>}
        </button>
      ))}
    </>
  );
}

const EMPTY: Session[] = [];

/** "Add to project" choices: projects on the same machine, or back to Chats. */
function MoveItems({ session, space, close }: { session: Session; space: Space; close: () => void }) {
  const projects = useStore((s) => s.projects);
  const backends = useStore((s) => s.backends);
  const here = projects.filter((p) => p.backend === space.backend && p.id !== space.projectId);
  const backend = backends.find((b) => b.id === space.backend);
  if (!here.length && !space.projectId) return null;
  return (
    <>
      <div className="pop-sep" />
      {here.length > 0 && <div className="pop-head">Add to project</div>}
      {here.map((p) => (
        <button key={p.id} type="button" className="pop-item" onClick={() => (close(), moveSession(space.backend, session.id, projectSpace(p)))}>
          <FolderInput size={15} />
          <span className="grow">{p.name}</span>
        </button>
      ))}
      {space.projectId && backend && (
        <button type="button" className="pop-item" onClick={() => (close(), moveSession(space.backend, session.id, chatsSpace(backend)))}>
          <FolderOutput size={15} />
          <span className="grow">Move out of project</span>
        </button>
      )}
    </>
  );
}

const SessionRow = memo(function SessionRow({ session, space, selected, running, child, deep, folders }: { session: Session; space: Space; selected: boolean; running: boolean; child?: boolean; deep?: boolean; folders: string[] }) {
  const [renaming, setRenaming] = useState(false);
  const pinned = !!session.metadata?.hqPinned;
  const folder = (session.metadata?.hqFolder as string | undefined) || "";
  const pickFolder = () => {
    const known = folders.filter((f) => f !== folder);
    const t = prompt(`Folder for this chat${known.length ? ` (existing: ${known.join(", ")})` : ""}. Leave empty to take it out of its folder.`, folder);
    if (t !== null) setChatFolder(space.backend, session.id, t || null);
  };
  return (
    <div
      className={"sb-item chat" + (selected ? " sel" : "") + (deep ? " deep" : child ? " child" : "")}
      role="button"
      tabIndex={0}
      onClick={() => openSession(space, session.id)}
      onKeyDown={(e) => e.key === "Enter" && openSession(space, session.id)}
      onDoubleClick={() => setRenaming(true)}
      title={session.title}
    >
      {renaming ? (
        <RenameInput
          value={session.title || ""}
          onDone={(t) => {
            setRenaming(false);
            if (t) renameSession(space.backend, session.id, t);
          }}
        />
      ) : (
        <span className="grow">
          {pinned && <Pin size={11} className="sb-pin" aria-label="Pinned" />}
          {session.title || "New Chat"}
          {/* Listed under its machine but working in another folder: say which. */}
          {(() => {
            // The folder it works in: a copy chat's real folder, not the copy's internal name.
            const dir = ((session.metadata?.hqCopy as { base?: string } | undefined)?.base) || session.location.directory;
            if (space.projectId || dir === space.directory) return null;
            const isCopy = !!session.metadata?.hqCopy;
            return <small className="sb-sub">{dir.replace(/[\\/]+$/, "").split(/[\\/]/).pop()}{isCopy ? " · copy" : ""}</small>;
          })()}
        </span>
      )}
      {running && !renaming && <span className="dot-run" aria-label="Working" />}
      {!renaming && (
        <Popover
          side="down"
          align="left"
          trigger={(open, toggle) => (
            <button type="button" className={"sb-more" + (open ? " open" : "")} aria-label="Chat options" onClick={(e) => (e.stopPropagation(), toggle())}>
              <Ellipsis size={15} />
            </button>
          )}
        >
          {(close) => (
            <div onClick={(e) => e.stopPropagation()}>
              <button type="button" className="pop-item" onClick={() => (close(), setRenaming(true))}><Pencil size={15} />Rename</button>
              <button type="button" className="pop-item" onClick={() => (close(), pinSession(space.backend, session.id, !pinned))}>
                {pinned ? <PinOff size={15} /> : <Pin size={15} />}{pinned ? "Unpin" : "Pin to the top"}
              </button>
              <button type="button" className="pop-item" onClick={() => (close(), pickFolder())}>
                <Folder size={15} /><span className="grow">{folder ? "Change folder" : "Put in a folder"}{folder && <small>In “{folder}”</small>}</span>
              </button>
              <MoveItems session={session} space={space} close={close} />
              <div className="pop-sep" />
              <button type="button" className="pop-item" onClick={() => (close(), exportChat(space.backend, session.id))}><FileDown size={15} />Export as Markdown</button>
              <button type="button" className="pop-item" onClick={() => (close(), printChat(space.backend, session.id))}><Printer size={15} />Print or save as PDF</button>
              <div className="pop-sep" />
              <button type="button" className="pop-item danger" onClick={() => (close(), deleteSession(space.backend, session.id))}><Trash2 size={15} />Delete chat</button>
            </div>
          )}
        </Popover>
      )}
    </div>
  );
});

/** A space's chats: pinned ones first, then folders, then the rest (each in the server's order, newest first). */
function SessionList({ space, child, deep }: { space: Space; child?: boolean; deep?: boolean }) {
  const sessions = useStore((s) => s.sessions[spaceKey(space)] || EMPTY);
  const currentId = useStore((s) => s.current?.sessionId);
  const active = useStore((s) => s.active);
  const folderOf = (x: Session) => (x.metadata?.hqPinned ? "" : (x.metadata?.hqFolder as string | undefined) || "");
  const folders = [...new Set(sessions.map(folderOf).filter(Boolean))].sort((a, b) => a.localeCompare(b));
  const row = (x: Session, inFolder = false) => (
    <SessionRow key={x.id} session={x} space={space} selected={x.id === currentId} running={!!active[x.id]} child={child && !inFolder} deep={deep || inFolder} folders={folders} />
  );
  return (
    <>
      {sessions.filter((x) => x.metadata?.hqPinned).map((x) => row(x))}
      {folders.map((f) => (
        <ChatFolder key={f} name={f} space={space} child={child || deep} count={sessions.filter((x) => folderOf(x) === f).length} hasCurrent={sessions.some((x) => folderOf(x) === f && x.id === currentId)}>
          {sessions.filter((x) => folderOf(x) === f).map((x) => row(x, true))}
        </ChatFolder>
      ))}
      {sessions.filter((x) => !x.metadata?.hqPinned && !folderOf(x)).map((x) => row(x))}
    </>
  );
}

function ChatFolder({ name, space, child, count, hasCurrent, children }: { name: string; space: Space; child?: boolean; count: number; hasCurrent: boolean; children: React.ReactNode }) {
  const [open, toggle] = useFolderOpen(`chats.${spaceKey(space)}.${name}`);
  return (
    <>
      <button type="button" className={"sb-item sb-folder chats-folder" + (child ? " child" : "") + (open ? "" : " shut")} onClick={toggle} aria-expanded={open}>
        <ChevronDown size={14} className="sb-chev" />
        <Folder size={15} />
        <span className="grow">{name}</span>
        {(!open || hasCurrent) && <span className="sb-count">{count}</span>}
      </button>
      {open && children}
    </>
  );
}

/** Open/closed state of a sidebar folder, remembered on this device. */
function useFolderOpen(key: string): [boolean, () => void] {
  const read = () => {
    try { return localStorage.getItem("hq.folder." + key) !== "0"; } catch { return true; }
  };
  const [open, setOpen] = useState(read);
  const toggle = () => setOpen((o) => {
    try { localStorage.setItem("hq.folder." + key, o ? "0" : "1"); } catch { /* private mode */ }
    return !o;
  });
  return [open, toggle];
}

/** One machine as a folder: its projects (each with its chats), its New Chat, then its other chats. */
function DeviceFolder({ backend, label, selected, projects }: { backend: Backend; label: string; selected: boolean; projects: Project[] }) {
  const space = chatsSpace(backend);
  const [open, toggle] = useFolderOpen("device." + backend.id);
  const count = useStore((s) => [space, ...projects.map(projectSpace)].reduce((n, sp) => n + (s.sessions[spaceKey(sp)] || EMPTY).length, 0));
  return (
    <div>
      <button type="button" className={"sb-item sb-folder" + (open ? "" : " shut")} onClick={toggle} aria-expanded={open}>
        <ChevronDown size={14} className="sb-chev" />
        <Monitor size={16} />
        <span className="grow">{label}</span>
        {count > 0 && <span className="sb-count">{count}</span>}
      </button>
      {open && (
        <>
          {projects.map((p) => <ProjectBlock key={p.id} project={p} nested />)}
          <button type="button" className={"sb-item child" + (selected ? " sel" : "")} onClick={() => openModal("newChat")}>
            <SquarePen size={16} /><span className="grow">New Chat</span>
          </button>
          {/* A project in the home folder already lists those chats (the two lists share one key). */}
          {!projects.some((p) => p.directory === space.directory) && <SessionList space={space} child />}
        </>
      )}
    </div>
  );
}

function ProjectBlock({ project, backendLabel, nested }: { project: Project; backendLabel?: string; nested?: boolean }) {
  const [renaming, setRenaming] = useState(false);
  const space = projectSpace(project);
  const draftHere = useStore((s) => !!s.current && !s.current.sessionId && s.current.space.projectId === project.id);
  const [open, toggleOpen] = useFolderOpen("project." + project.id);
  const count = useStore((s) => (s.sessions[spaceKey(space)] || EMPTY).length);
  return (
    <>
      <div
        className={"sb-item proj" + (nested ? " child" : "") + (draftHere ? " sel" : "") + (open ? "" : " shut")}
        role="button"
        tabIndex={0}
        onClick={() => newChat(space)}
        onKeyDown={(e) => e.key === "Enter" && newChat(space)}
        title={`${project.directory}${backendLabel ? ` on ${backendLabel}` : ""}\nClick to start a chat in this project`}
      >
        {/* The arrow shows or hides this project's chats; the rest of the row starts a new chat in it. */}
        <button type="button" className="sb-chev-btn" onClick={(e) => (e.stopPropagation(), toggleOpen())} aria-expanded={open} aria-label={open ? "Hide chats" : "Show chats"}>
          <ChevronDown size={14} className="sb-chev" />
        </button>
        <FolderOpen size={16} />
        {renaming ? (
          <RenameInput value={project.name} onDone={(t) => (setRenaming(false), t && renameProject(project.id, t))} />
        ) : (
          <span className="grow">{project.name}</span>
        )}
        {!open && count > 0 && !renaming && <span className="sb-count">{count}</span>}
        {!renaming && (
          <Popover
            side="down"
            align="left"
            trigger={(open, toggle) => (
              <button type="button" className={"sb-more" + (open ? " open" : "")} aria-label="Project options" onClick={(e) => (e.stopPropagation(), toggle())}>
                <Ellipsis size={15} />
              </button>
            )}
          >
            {(close) => (
              <div onClick={(e) => e.stopPropagation()}>
                <button type="button" className="pop-item" onClick={() => (close(), newChat(space))}><SquarePen size={15} />New chat here</button>
                <button type="button" className="pop-item" onClick={() => (close(), setRenaming(true))}><Pencil size={15} />Rename</button>
                <button
                  type="button"
                  className="pop-item"
                  onClick={() => {
                    close();
                    const t = prompt(`Test command for ${project.name} (runs inside each copy before it can be applied). Leave empty for none.`, project.test || "");
                    if (t !== null) setProjectTest(project.id, t);
                  }}
                >
                  <FlaskConical size={15} />
                  <span className="grow">Test command<small>{project.test ? project.test.slice(0, 60) : "Not set"}</small></span>
                </button>
                <button type="button" className="pop-item danger" onClick={() => (close(), removeProject(project.id))}>
                  <X size={15} />
                  <span>Remove from list<small>The folder and its chats are kept</small></span>
                </button>
              </div>
            )}
          </Popover>
        )}
      </div>
      {open ? <SessionList space={space} child={!nested} deep={nested} /> : null}
    </>
  );
}

export function Sidebar() {
  const open = useStore((s) => s.ui.sidebar);
  const appName = useStore((s) => s.appName);
  const projects = useStore((s) => s.projects);
  const backends = useStore((s) => s.backends);
  const conn = useStore((s) => s.conn);
  // Which machine's "New Chat" is open as an unsent draft (highlight that one, not always the first).
  const draftChatsOn = useStore((s) => (s.current && !s.current.sessionId && !s.current.space.projectId ? s.current.space.backend : null));
  const [searching, setSearching] = useState(false);
  const [q, setQ] = useState("");
  const searchBox = useRef<HTMLInputElement>(null);
  useEffect(() => void (searching && searchBox.current?.focus()), [searching]);
  const anyDown = backends.some((b) => conn[b.id] !== "open");
  const many = backends.length > 1;

  return (
    <aside className={"sidebar" + (open ? "" : " closed")} aria-hidden={!open}>
      <div className="sb-top">
        <div className="sb-brand"><Brand size={22} /><span>{appName}</span></div>
        <span className="spacer" />
        <button type="button" className="icon-btn" onClick={() => setSearching(!searching)} aria-label="Search chats" title="Search all chats" aria-pressed={searching}><Search size={18} /></button>
        {/* New chat in the folder (project or machine) of the chat that's open, like the header's button. */}
        <button type="button" className="icon-btn" onClick={() => openModal("newChat")} aria-label="New chat" title="New chat"><SquarePen size={18} /></button>
        <button type="button" className="icon-btn" onClick={toggleSidebar} aria-label="Hide sidebar" title="Hide sidebar"><PanelLeft size={19} /></button>
      </div>
      {searching && (
        <div className="sb-search">
          <input ref={searchBox} value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search all chats" onKeyDown={(e) => e.key === "Escape" && (setSearching(false), setQ(""))} />
        </div>
      )}
      {searching ? (
        <div className="sb-scroll"><SearchResults q={q} close={() => (setSearching(false), setQ(""))} /></div>
      ) : (
      <div className="sb-scroll">
        <button type="button" className="sb-item" onClick={() => openModal("newProject")}><Plus size={16} /><span className="grow">New Project</span></button>
        {many ? (
          // Each machine is a folder holding its projects and its chats.
          backends.map((b) => (
            <DeviceFolder key={b.id} backend={b} label={b.label || b.id} selected={draftChatsOn === b.id} projects={projects.filter((p) => p.backend === b.id)} />
          ))
        ) : (
          <>
            {projects.map((p) => <ProjectBlock key={p.id} project={p} />)}
            {backends.map((b) => (
              <div key={b.id}>
                <button type="button" className={"sb-item" + (draftChatsOn === b.id ? " sel" : "")} onClick={() => openModal("newChat")}>
                  <SquarePen size={16} /><span className="grow">New Chat</span>
                </button>
                {!projects.some((p) => p.backend === b.id && p.directory === chatsSpace(b).directory) && <SessionList space={chatsSpace(b)} />}
              </div>
            ))}
          </>
        )}
      </div>
      )}
      <div className="sb-bottom">
        <button type="button" className="sb-item" style={{ color: "var(--text)" }} onClick={() => openModal("vault")}>
          <KeyRound size={16} /><span className="grow">Links &amp; logins</span>
        </button>
        <button type="button" className="sb-item" style={{ color: "var(--text)" }} onClick={() => openModal("settings")}>
          <Settings size={16} /><span className="grow">Settings</span>
          {anyDown && <span className="conn-dot" title="A server is not connected" />}
        </button>
      </div>
    </aside>
  );
}
