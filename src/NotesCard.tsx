import { useEffect, useState } from "react";
import { BookmarkPlus, LoaderCircle, X } from "lucide-react";
import { toast } from "./store";
import type { TurnView } from "./turns";

type Suggestion = { topic: string; note: string; keep: boolean; saved?: boolean };

/** Summary of a turn's work for the note picker: the steps, without bulky tool output. */
function workText(v: TurnView): string {
  return v.log
    .map((r) => {
      if (r.kind === "tool") {
        const inp = typeof r.part.state.input === "string" ? r.part.state.input : JSON.stringify(r.part.state.input);
        const err = r.part.state.status === "error" ? ` -> ERROR: ${r.part.state.error.message}` : "";
        return `- ${r.part.name} ${inp.slice(0, 300)}${err}`;
      }
      if (r.kind === "text" || r.kind === "reasoning") return r.text.slice(0, 600);
      if (r.kind === "shell") return `- shell ${r.command} -> ${(r.output || "").slice(0, 300)}`;
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

/** "Save to guide": a fast model suggests lasting facts from this turn; you pick what to keep. */
export function NotesCard({ request, view, files, onClose }: { request: string; view: TurnView; files: string[]; onClose: () => void }) {
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [topics, setTopics] = useState<string[]>([]);
  const [items, setItems] = useState<Suggestion[]>([]);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let live = true;
    fetch("/hq/notes/suggest", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ request, work: workText(view), answer: view.answer, files }),
    })
      .then(async (r) => {
        const b = await r.json();
        if (!r.ok) throw new Error(b.message || "failed");
        if (!live) return;
        setTopics(b.topics);
        setItems(b.notes.map((n: { topic: string; note: string }) => ({ ...n, keep: true })));
        setState("ready");
      })
      .catch((e) => {
        if (!live) return;
        toast(`Could not get suggestions: ${e.message}`);
        setState("error");
      });
    return () => void (live = false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const save = async () => {
    setSaving(true);
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      if (!it.keep || it.saved || !it.note.trim()) continue;
      const r = await fetch("/hq/notes/save", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ topic: it.topic, note: it.note }) });
      const b = await r.json().catch(() => ({}));
      if (!r.ok) toast(`Not saved: ${b.message || r.status}`);
      else setItems((xs) => xs.map((x, j) => (j === i ? { ...x, saved: true } : x)));
    }
    setSaving(false);
  };
  const pending = items.filter((i) => i.keep && !i.saved).length;

  return (
    <div className="rv">
      <div className="rv-head">
        {state === "loading" ? <LoaderCircle size={15} className="spin" /> : <BookmarkPlus size={15} />}
        <span>{state === "loading" ? "Looking for things worth remembering…" : "Save to the shared guide"}</span>
        <span className="spacer" />
        <button type="button" className="act" onClick={onClose} aria-label="Close"><X size={15} /></button>
      </div>
      {state === "ready" && items.length === 0 && <div className="rv-note">Nothing lasting in this turn.</div>}
      {state === "ready" && items.length > 0 && <div className="rv-note">Every local model reads the guide before working on your setup. Tick what's true and worth keeping.</div>}
      {items.map((it, i) => (
        <div key={i} className={"nt" + (it.saved ? " saved" : "")}>
          <input type="checkbox" checked={it.keep} disabled={it.saved} onChange={(e) => setItems((xs) => xs.map((x, j) => (j === i ? { ...x, keep: e.target.checked } : x)))} aria-label="Keep this note" />
          <div className="nt-body">
            <textarea
              value={it.note}
              disabled={it.saved}
              rows={2}
              onChange={(e) => setItems((xs) => xs.map((x, j) => (j === i ? { ...x, note: e.target.value } : x)))}
            />
            <div className="nt-meta">
              <select value={it.topic} disabled={it.saved} onChange={(e) => setItems((xs) => xs.map((x, j) => (j === i ? { ...x, topic: e.target.value } : x)))}>
                {topics.map((t) => <option key={t} value={t}>{t}</option>)}
              </select>
              {it.saved && <span className="nt-ok">Saved</span>}
            </div>
          </div>
        </div>
      ))}
      {state === "ready" && items.length > 0 && (
        <div className="rv-btns">
          <button type="button" className="btn" onClick={onClose}>{pending ? "Cancel" : "Done"}</button>
          {pending > 0 && <button type="button" className="btn primary" disabled={saving} onClick={save}>{saving ? "Saving…" : `Save ${pending}`}</button>}
        </div>
      )}
    </div>
  );
}
