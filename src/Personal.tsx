import { useState } from "react";
import { Pencil, Plus, Trash2 } from "lucide-react";
import { EXAMPLE_PERSONAS, openModal, saveAbout, saveMemory, savePersonas, useStore, type Persona } from "./store";
import { Dialog } from "./ui";

/**
 * Settings › Personal: what every chat is told about you (custom instructions + memory), and personas a chat can use.
 * All of it follows you to every device; each chat gets it as context with its next message.
 */
export function PersonalDialog() {
  const about = useStore((s) => s.about);
  const memory = useStore((s) => s.memory);
  const personas = useStore((s) => s.personas);
  const [draft, setDraft] = useState(about);
  const [fact, setFact] = useState("");
  const [editing, setEditing] = useState<Persona | null>(null);
  const close = () => {
    if (draft !== about) saveAbout(draft);
    openModal(null);
  };

  if (editing) {
    const isNew = !personas.some((p) => p.id === editing.id);
    const ok = editing.name.trim() && editing.instructions.trim();
    const save = () => {
      if (!ok) return;
      const p = { ...editing, name: editing.name.trim().slice(0, 40), instructions: editing.instructions.trim().slice(0, 4000) };
      savePersonas(isNew ? [...personas, p] : personas.map((x) => (x.id === p.id ? p : x)));
      setEditing(null);
    };
    return (
      <Dialog
        title={isNew ? "New persona" : "Edit persona"}
        onClose={() => setEditing(null)}
        footer={
          <>
            <button type="button" className="btn big" onClick={() => setEditing(null)}>Cancel</button>
            <button type="button" className="btn big primary" disabled={!ok} onClick={save}>Save</button>
          </>
        }
      >
        <div className="field-label" style={{ marginTop: 0 }}>Name</div>
        <input className="input" autoFocus placeholder="e.g. Spanish tutor" value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })} />
        <div className="field-label">How it should act</div>
        <textarea
          className="input prompt-text"
          rows={7}
          placeholder="e.g. Speak simple Spanish. Correct my mistakes gently, then answer."
          value={editing.instructions}
          onChange={(e) => setEditing({ ...editing, instructions: e.target.value })}
        />
      </Dialog>
    );
  }

  const addFact = () => {
    const t = fact.trim().slice(0, 500);
    if (!t) return;
    saveMemory([...memory, { id: crypto.randomUUID(), text: t, at: Date.now() }]);
    setFact("");
  };
  const missing = EXAMPLE_PERSONAS.filter((e) => !personas.some((p) => p.id === e.id));
  return (
    <Dialog title="Personal" onClose={close}>
      <div className="vault-note" style={{ marginBottom: 4 }}>
        Every chat is told this, on every device: changes reach a chat with its next message. It goes to whichever model the
        chat uses, so keep secrets out of it.
      </div>

      <div className="field-label">About you and how to answer</div>
      <textarea
        className="input prompt-text"
        rows={5}
        placeholder={"e.g. I'm a game design student in London. Keep answers short, use British spelling, and show code without long explanations."}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => draft !== about && saveAbout(draft)}
      />

      <div className="field-label">Memory <em>· or type /remember and the fact in the message box</em></div>
      <div className="rows">
        {memory.length === 0 && <div className="rowline"><div className="grow">Nothing remembered yet<small>Short facts every chat should know, e.g. “I'm vegetarian”.</small></div></div>}
        {memory.map((m) => (
          <div className="rowline" key={m.id}>
            <div className="grow">{m.text}<small>{new Date(m.at).toLocaleDateString()}</small></div>
            <button type="button" className="btn" onClick={() => saveMemory(memory.filter((x) => x.id !== m.id))} title="Forget this" aria-label={`Forget: ${m.text}`}><Trash2 size={14} /></button>
          </div>
        ))}
      </div>
      <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
        <input className="input" placeholder="Something to remember" value={fact} onChange={(e) => setFact(e.target.value)} onKeyDown={(e) => e.key === "Enter" && addFact()} />
        <button type="button" className="btn" disabled={!fact.trim()} onClick={addFact}><Plus size={14} /> Add</button>
      </div>

      <div className="field-label">Personas <em>· pick one for a chat in the Chat / Agent menu</em></div>
      <div className="rows">
        {personas.length === 0 && <div className="rowline"><div className="grow">None yet</div></div>}
        {personas.map((p) => (
          <PersonaRow key={p.id} p={p} onEdit={() => setEditing(p)} onDelete={() => savePersonas(personas.filter((x) => x.id !== p.id))} />
        ))}
      </div>
      <div style={{ display: "flex", gap: 8, marginTop: 12, flexWrap: "wrap" }}>
        <button type="button" className="btn big primary" onClick={() => setEditing({ id: crypto.randomUUID(), name: "", instructions: "" })}><Plus size={14} /> New persona</button>
        {missing.length > 0 && (
          <button type="button" className="btn big" onClick={() => savePersonas([...personas, ...missing])}>Add the {missing.length} example{missing.length === 1 ? "" : "s"} back</button>
        )}
      </div>
    </Dialog>
  );
}

function PersonaRow({ p, onEdit, onDelete }: { p: Persona; onEdit: () => void; onDelete: () => void }) {
  const [sure, setSure] = useState(false);
  return (
    <div className="rowline">
      <div className="grow">{p.name}<small className="clamp2">{p.instructions}</small></div>
      <button type="button" className="btn" onClick={onEdit} title="Edit" aria-label={`Edit ${p.name}`}><Pencil size={14} /></button>
      <button type="button" className={"btn" + (sure ? " danger" : "")} onClick={() => (sure ? onDelete() : setSure(true))} onBlur={() => setSure(false)} title="Delete" aria-label={`Delete ${p.name}`}>
        {sure ? "Delete?" : <Trash2 size={14} />}
      </button>
    </div>
  );
}
