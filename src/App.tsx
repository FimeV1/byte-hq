import { useEffect, useMemo, useState } from "react";
import { ArrowLeft, PanelLeft, PanelRight, RefreshCw, SquarePen } from "lucide-react";
import { boot, currentSession, newChat, openModal, openModels, setPanel, togglePanel, toggleSidebar, useStore } from "./store";
import { VoiceMode } from "./VoiceMode";
import { BrowserPane } from "./BrowserPane";
import { Sidebar } from "./Sidebar";
import { EmptyChat, Thread } from "./Chat";
import { Composer } from "./Composer";
import { FolderBrowser, MachineDialog, NewChatDialog, NewProjectDialog, SettingsDialog, VaultDialog } from "./Modals";
import { ModelsDialog } from "./ModelsDialog";
import { ByteHelpDialog } from "./Help";
import { PromptsDialog } from "./Prompts";
import { PersonalDialog } from "./Personal";
import { PrintView } from "./PrintView";
import { GalleryDialog } from "./Gallery";
import { Dialog } from "./ui";
import { EditedFiles } from "./EditedFiles";
import { buildTurns } from "./turns";

function SidePanel({ sessionId }: { sessionId?: string }) {
  const mode = useStore((s) => s.ui.panel);
  const hasBrowser = useStore((s) => s.hasBrowser);
  const activity = useStore((s) => s.browserActivity);
  return (
    <aside className="panel">
      <div className="panel-head">
        {/* Phones: the panel covers the chat, so give it an obvious way back. */}
        <button type="button" className="panel-back" onClick={() => setPanel(false)} aria-label="Back to chat"><ArrowLeft size={17} />Chat</button>
        {hasBrowser && <button type="button" className={"ptab" + (mode === "browser" ? " on" : "")} onClick={() => setPanel("browser")}>Browser</button>}
        <button type="button" className={"ptab" + (mode === "changes" ? " on" : "")} onClick={() => setPanel("changes")}>Changes</button>
        <span className="spacer" />
        <button type="button" className="icon-btn" onClick={() => setPanel(false)} aria-label="Close panel" title="Close panel"><PanelRight size={18} /></button>
      </div>
      {/* The browser stays mounted while hidden so its stream and tab choice survive switching tabs. */}
      {hasBrowser && <div style={{ display: mode === "browser" ? "contents" : "none" }}><BrowserPane followAgent={activity} /></div>}
      {mode === "changes" && <ChangesList sessionId={sessionId} />}
    </aside>
  );
}

function ChangesList({ sessionId }: { sessionId?: string }) {
  const chat = useStore((s) => (sessionId ? s.chat[sessionId] : undefined));
  const turns = useMemo(() => buildTurns(chat?.messages || []).filter((t) => t.userId && chat?.diffs[t.userId]?.length), [chat?.messages, chat?.diffs]);
  return (
    <>
      <div className="panel-body">
        {turns.length === 0 && <div className="sb-empty" style={{ padding: 4 }}>No files have been edited in this chat yet.</div>}
        {turns.map((t) => (
          <div key={t.key}>
            <div className="panel-turn">{t.users[0]?.text}</div>
            <EditedFiles files={chat!.diffs[t.userId!]} />
          </div>
        ))}
      </div>
    </>
  );
}

/**
 * HQ was updated on the server (npm run build) while this page was open: offer a reload. A home-screen app otherwise
 * keeps running the old version until it's force-closed. Checked when the app comes back to the front, and hourly.
 */
function useUpdateCheck() {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    let first: string | undefined;
    const check = () =>
      fetch("/hq/config", { cache: "no-store" })
        .then((r) => r.json())
        .then((c: { build?: string }) => {
          if (!c.build) return;
          if (first === undefined) first = c.build;
          else if (c.build !== first) setReady(true);
        })
        .catch(() => {});
    check();
    const vis = () => document.visibilityState === "visible" && check();
    document.addEventListener("visibilitychange", vis);
    const t = setInterval(check, 3600_000);
    return () => (document.removeEventListener("visibilitychange", vis), clearInterval(t));
  }, []);
  return ready;
}

export function App() {
  const ready = useStore((s) => s.ready);
  const fatal = useStore((s) => s.fatal);
  const appName = useStore((s) => s.appName);
  const ui = useStore((s) => s.ui);
  const voiceOpen = useStore((s) => s.voiceOpen);
  const cur = useStore((s) => s.current);
  const session = useStore((s) => currentSession(s));
  const project = useStore((s) => s.projects.find((p) => p.id === s.current?.space.projectId));
  useEffect(() => void boot(), []);
  const [picking, setPicking] = useState(false);
  const pickBackend = useStore((s) => s.backends.find((b) => b.id === s.current?.space.backend));
  const noModels = useStore((s) => (s.current ? s.models[s.current.space.backend]?.length === 0 && s.conn[s.current.space.backend] === "open" : false));
  const updated = useUpdateCheck();

  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.shiftKey && e.key.toLowerCase() === "o") (e.preventDefault(), openModal("newChat"));
      if (mod && e.key.toLowerCase() === "b") (e.preventDefault(), toggleSidebar());
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, []);

  if (fatal) {
    return (
      <div className="fatal">
        <div>{appName} could not start.</div>
        <code>{fatal}</code>
        <button type="button" className="btn big" onClick={() => location.reload()}>Try again</button>
      </div>
    );
  }
  if (!ready || !cur) return <div className="fatal" />;

  const title = cur.sessionId ? session?.title || "New Chat" : "New Chat";
  return (
    <div className="app">
      <Sidebar />
      {ui.sidebar && <div className="scrim" onClick={toggleSidebar} aria-hidden />}
      <main className="main">
        <header className={"header" + (ui.sidebar ? "" : " nosb")}>
          {!ui.sidebar && (
            <>
              <button type="button" className="icon-btn" onClick={toggleSidebar} aria-label="Show sidebar" title="Show sidebar"><PanelLeft size={19} /></button>
              <button type="button" className="icon-btn" onClick={() => openModal("newChat")} aria-label="New chat" title="New chat"><SquarePen size={18} /></button>
            </>
          )}
          <div className="title"><span>{title}</span></div>
          {project && <div className="sub">{project.name}</div>}
          <span className="spacer" />
          <button type="button" className="icon-btn" onClick={togglePanel} aria-label="Side panel" title="Browser and changes" aria-pressed={!!ui.panel}><PanelRight size={19} /></button>
        </header>
        <div className="body">
          <div className="chatcol">
            {updated && (
              <div className="banner">
                <span className="grow">A new version of {appName} is ready.</span>
                <button type="button" className="btn primary" onClick={() => location.reload()}><RefreshCw size={13} /> Reload</button>
              </div>
            )}
            {noModels && (
              <div className="banner">
                <span className="grow">{pickBackend?.label} has no models yet.</span>
                <button type="button" className="btn primary" onClick={() => openModels(cur.space.backend)}>Add models</button>
              </div>
            )}
            {cur.sessionId ? (
              <Thread key={cur.sessionId} sessionId={cur.sessionId} />
            ) : (
              <EmptyChat title={project?.name} path={cur.space.directory} appName={appName} onChangeFolder={project ? undefined : () => setPicking(true)} />
            )}
            <Composer />
          </div>
          {ui.panel && <SidePanel sessionId={cur.sessionId || undefined} />}
        </div>
        {/* A new chat that isn't in a project can work in any folder on its machine. */}
        {picking && pickBackend && (
          <Dialog title={`Choose a folder on ${pickBackend.label}`} onClose={() => setPicking(false)}>
            <FolderBrowser backend={pickBackend} start={cur.space.directory} onPick={(d) => (setPicking(false), newChat({ backend: pickBackend.id, directory: d }))} />
          </Dialog>
        )}
      </main>
      {ui.modal === "newProject" && <NewProjectDialog />}
      {ui.modal === "settings" && <SettingsDialog />}
      {ui.modal === "newChat" && <NewChatDialog />}
      {ui.modal === "vault" && <VaultDialog />}
      {ui.modal === "models" && <ModelsDialog />}
      {ui.modal === "machine" && <MachineDialog />}
      {ui.modal === "byteHelp" && <ByteHelpDialog />}
      {ui.modal === "prompts" && <PromptsDialog />}
      {ui.modal === "personal" && <PersonalDialog />}
      {ui.modal === "gallery" && <GalleryDialog />}
      <PrintView />
      {voiceOpen && <VoiceMode />}
      {ui.toast && <div className={"toast " + (ui.toastKind || "error")} role={ui.toastKind === "error" || !ui.toastKind ? "alert" : "status"}>{ui.toast}</div>}
    </div>
  );
}
