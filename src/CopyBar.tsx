import { useState } from "react";
import { CheckCircle2, ChevronRight, CircleX, GitBranch, LoaderCircle } from "lucide-react";
import { applyCopy, currentSession, discardCopy, restartCopy, testCopy, useStore } from "./store";
import type { CopyInfo } from "./types";

const baseName = (p: string) => p.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || p;

/** Above the message box in a chat that works on a copy: test it, apply it to live, or throw it away. */
export function CopyBar() {
  const ses = useStore((s) => currentSession(s));
  const sid = ses?.id;
  const running = useStore((s) => (sid ? !!s.active[sid] : false));
  const result = useStore((s) => (sid ? s.copyTests[sid] : undefined));
  const projectName = useStore((s) => s.projects.find((p) => p.id === s.current?.space.projectId)?.name);
  // Has any turn changed a file on the copy? (Per-turn diffs, as in the Edited files cards.)
  const changed = useStore((s) => (sid ? Object.values(s.chat[sid]?.diffs || {}).some((f) => f.length > 0) : false));
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<"" | "apply" | "discard" | "restart">("");
  const copy = ses?.metadata?.hqCopy as CopyInfo | undefined;
  if (!copy) return null;
  const name = projectName || baseName(copy.base);
  if (copy.applied) {
    // After Apply: offer to restart the services that run the applied files, so the change actually loads.
    const pending = copy.restart?.length && !copy.restarted;
    return (
      <div className="queued cb done">
        <div className="cb-row">
          <GitBranch size={15} />
          <span className="q-text">
            Applied to live {name} as commit {copy.applied}.
            {pending ? " It loads when these restart:" : copy.restarted ? ` ${copy.restarted.summary.split("\n")[0]}` : ""}
          </span>
          {pending ? (
            <button
              type="button"
              className="btn primary"
              disabled={!!busy}
              title="Checks it's safe first (the project's own safety check), restarts, then checks everything came back"
              onClick={() => (setBusy("restart"), restartCopy().finally(() => setBusy("")))}
            >
              {busy === "restart" ? <LoaderCircle size={13} className="spin" /> : `Restart ${copy.restart!.join(", ")}`}
            </button>
          ) : null}
        </div>
      </div>
    );
  }
  if (copy.discarded) return <div className="queued cb done"><GitBranch size={15} /><span className="q-text">The copy was discarded; {name} was not changed.</span></div>;

  // Nothing to test or apply yet: say so, and only offer to throw the copy away.
  if (!changed)
    return (
      <div className="queued cb">
        <div className="cb-row">
          <GitBranch size={15} />
          <span className="q-text">Working on a copy of {name} · no changes yet</span>
          <button type="button" className="btn" disabled={running || !!busy} onClick={() => confirm("Throw this copy away? The live project is not touched.") && (setBusy("discard"), discardCopy().finally(() => setBusy("")))}>
            Discard
          </button>
        </div>
      </div>
    );

  const last = ses?.metadata?.hqTest as { ok: boolean; summary: string } | undefined;
  const testing = result === "running";
  const shown = result && result !== "running" ? result : null;
  const ok = shown ? shown.ok : last?.ok;
  return (
    <div className="queued cb">
      <div className="cb-row">
        <GitBranch size={15} />
        <span className="q-text">
          Working on a copy of {name}
          {testing ? " · testing…" : ok === true ? " · tests passed" : ok === false ? " · tests failed" : " · not tested yet"}
        </span>
        <button type="button" className="btn" disabled={testing || running} onClick={() => (setOpen(true), testCopy())}>
          {testing ? <LoaderCircle size={13} className="spin" /> : "Test"}
        </button>
        <button
          type="button"
          className="btn primary"
          disabled={running || testing || !!busy}
          title={ok ? "Put this change into the live project as one commit" : "Not tested yet, or the tests failed"}
          onClick={() => {
            if (!ok && !confirm(`The change hasn't passed its tests. Apply it to live ${name} anyway?`)) return;
            if (ok && !confirm(`Apply this change to live ${name}? It becomes one commit there.`)) return;
            setBusy("apply");
            applyCopy().finally(() => setBusy(""));
          }}
        >
          {busy === "apply" ? "Applying…" : "Apply to live"}
        </button>
        <button type="button" className="btn" disabled={running || !!busy} onClick={() => confirm("Throw this copy away? The live project is not touched.") && (setBusy("discard"), discardCopy().finally(() => setBusy("")))}>
          Discard
        </button>
      </div>
      {(shown || last) && (
        <button type="button" className="cb-sum" onClick={() => setOpen(!open)}>
          <ChevronRight size={13} className={open ? "rot" : ""} />
          {shown ? shown.summary : last?.summary}
        </button>
      )}
      {open && shown && (
        <div className="cb-steps">
          {shown.steps.map((s, i) => (
            <div key={i} className="cb-step">
              <div className="cb-step-head">{s.exit === 0 ? <CheckCircle2 size={14} className="ok" /> : <CircleX size={14} className="bad" />}{s.name}</div>
              {s.output.trim() && <pre>{s.output.trim().slice(-2500)}</pre>}
            </div>
          ))}
          {!shown.steps.length && <div className="rv-note">Set a test command in the project's menu (⋯ › Test command) so changes are checked properly.</div>}
        </div>
      )}
    </div>
  );
}
