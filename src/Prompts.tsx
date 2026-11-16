import { useState } from "react";
import { Pencil, Plus, Trash2 } from "lucide-react";
import { EXAMPLE_PROMPTS, openModal, putInComposer, savePrompts, useStore } from "./store";
import type { SavedPrompt } from "./types";
import { Dialog } from "./ui";

/** Saved prompts whose name matches what follows the "/" (or all of them for a bare "/"). */
export function matchPrompts(list: SavedPrompt[], text: string): SavedPrompt[] | null {
  if (!text.startsWith("/") || text.includes("\n")) return null;
  const q = text.slice(1).trim().toLowerCase();
  return list.filter((p) => !q || p.name.toLowerCase().includes(q)).slice(0, 8);
}

/** The menu over the message box while it starts with "/". */
export function SlashMenu({ items, index, onPick, onHover }: { items: SavedPrompt[]; index: number; onPick: (p: SavedPrompt | "manage") => void; onHover: (i: number) => void }) {
  return (
    <div className="slash" role="listbox" aria-label="Saved prompts">
      <div className="pop-head">Saved prompts <span className="slash-keys">↑↓ to choose · Enter to use · Esc to close</span></div>
      {items.length === 0 && <div className="pop-head">No saved prompt matches</div>}
      {items.map((p, i) => (
        <button
          key={p.id}
          type="button"
          role="option"
          aria-selected={i === index}
          className={"pop-item" + (i === index ? " sel" : "")}
          onMouseDown={(e) => e.preventDefault()} // keep the box focused
          onMouseEnter={() => onHover(i)}
          onClick={() => onPick(p)}
        >
          <span className="grow">{p.name}<small>{p.text}</small></span>
        </button>
      ))}
      <div className="pop-sep" />
      <button type="button" className={"pop-item" + (index === items.length ? " sel" : "")} onMouseDown={(e) => e.preventDefault()} onMouseEnter={() => onHover(items.length)} onClick={() => onPick("manage")}>
        <Pencil size={15} /><span className="grow">Edit saved prompts…</span>
      </button>
    </div>
  );
}

/** Settings for saved prompts: add, edit, delete, use. */
export function PromptsDialog() {
  const prompts = useStore((s) => s.prompts);
  const [editing, setEditing] = useState<SavedPrompt | null>(null);
  const close = () => openModal(null);

  if (editing) {
    const isNew = !prompts.some((p) => p.id === editing.id);
    const ok = editing.name.trim() && editing.text.trim();
    const save = () => {
      if (!ok) return;
      const p = { ...editing, name: editing.name.trim().slice(0, 60), text: editing.text.trim() };
      savePrompts(isNew ? [...prompts, p] : prompts.map((x) => (x.id === p.id ? p : x)));
      setEditing(null);
    };
    return (
      <Dialog
        title={isNew ? "New saved prompt" : "Edit saved prompt"}
        onClose={() => setEditing(null)}
        footer={
          <>
            <button type="button" className="btn big" onClick={() => setEditing(null)}>Cancel</button>
            <button type="button" className="btn big primary" disabled={!ok} onClick={save}>Save</button>
          </>
        }
      >
        <div className="field-label" style={{ marginTop: 0 }}>Name <em>· type / and part of it in the message box</em></div>
        <input className="input" autoFocus placeholder="e.g. Fix the failing tests" value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })} />
        <div className="field-label">What it sends</div>
        <textarea className="input prompt-text" rows={7} placeholder="The message, written as you'd write it to the model" value={editing.text} onChange={(e) => setEditing({ ...editing, text: e.target.value })} />
      </Dialog>
    );
  }

  const missing = EXAMPLE_PROMPTS.filter((e) => !prompts.some((p) => p.id === e.id));
  return (
    <Dialog title="Saved prompts" onClose={close}>
      <div className="vault-note" style={{ marginBottom: 10 }}>
        Type <b>/</b> in the message box to pick one: it fills the box, so you can change it before sending. They follow you to every device.
      </div>
      <div className="rows">
        {prompts.length === 0 && <div className="rowline"><div className="grow">None yet<small>Add your own below.</small></div></div>}
        {prompts.map((p) => (
          <PromptRow key={p.id} p={p} onEdit={() => setEditing(p)} onDelete={() => savePrompts(prompts.filter((x) => x.id !== p.id))} onUse={() => (putInComposer(p.text), close())} />
        ))}
      </div>
      <div style={{ display: "flex", gap: 8, marginTop: 12, flexWrap: "wrap" }}>
        <button type="button" className="btn big primary" onClick={() => setEditing({ id: crypto.randomUUID(), name: "", text: "" })}><Plus size={14} /> New prompt</button>
        {missing.length > 0 && (
          <button type="button" className="btn big" onClick={() => savePrompts([...prompts, ...missing])}>Add the {missing.length} example{missing.length === 1 ? "" : "s"} back</button>
        )}
      </div>
    </Dialog>
  );
}

function PromptRow({ p, onEdit, onDelete, onUse }: { p: SavedPrompt; onEdit: () => void; onDelete: () => void; onUse: () => void }) {
  const [sure, setSure] = useState(false);
  return (
    <div className="rowline">
      <div className="grow">{p.name}<small className="clamp2">{p.text}</small></div>
      <button type="button" className="btn" onClick={onUse} title="Put it in the message box">Use</button>
      <button type="button" className="btn" onClick={onEdit} title="Edit" aria-label={`Edit ${p.name}`}><Pencil size={14} /></button>
      <button type="button" className={"btn" + (sure ? " danger" : "")} onClick={() => (sure ? onDelete() : setSure(true))} onBlur={() => setSure(false)} title="Delete" aria-label={`Delete ${p.name}`}>
        {sure ? "Delete?" : <Trash2 size={14} />}
      </button>
    </div>
  );
}
