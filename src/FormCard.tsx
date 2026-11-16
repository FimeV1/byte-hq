import { useMemo, useState } from "react";
import { Check, ExternalLink, MessageCircleQuestion } from "lucide-react";
import { answerForm } from "./store";
import type { Form, FormField } from "./types";

type Values = Record<string, unknown>;

function visible(f: FormField, v: Values) {
  if (f.hidden) return false;
  return (f.when || []).every((w) => (w.op === "eq" ? v[w.key] === w.value : v[w.key] !== w.value));
}

function initial(form: Form): Values {
  const v: Values = {};
  for (const f of form.fields) {
    if (f.default !== undefined) v[f.key] = f.default;
    else if (f.type === "multiselect") v[f.key] = [];
    else if (f.type === "boolean") v[f.key] = false;
  }
  return v;
}

function Choice({ label, description, on, multi, onClick }: { label: string; description?: string; on: boolean; multi?: boolean; onClick: () => void }) {
  return (
    <button type="button" className={"fc-opt" + (on ? " on" : "")} onClick={onClick} aria-pressed={on}>
      <span className={"fc-mark" + (multi ? " sq" : "")}>{on && <Check size={11} strokeWidth={3} />}</span>
      <span className="fc-opt-text">
        {label}
        {description && <small>{description}</small>}
      </span>
    </button>
  );
}

function Field({ f, v, set }: { f: FormField; v: Values; set: (k: string, x: unknown) => void }) {
  const val = v[f.key];
  const head = (
    <div className="fc-q">
      {f.title || f.key}
      {f.description && <small>{f.description}</small>}
    </div>
  );
  if (f.type === "external") {
    return (
      <div className="fc-field">
        {head}
        <a className="btn" href={f.url} target="_blank" rel="noopener noreferrer"><ExternalLink size={13} /> Open</a>
      </div>
    );
  }
  if (f.type === "boolean") {
    return (
      <div className="fc-field">
        {head}
        <div className="fc-opts">
          <Choice label="Yes" on={val === true} onClick={() => set(f.key, true)} />
          <Choice label="No" on={val === false} onClick={() => set(f.key, false)} />
        </div>
      </div>
    );
  }
  if (f.type === "multiselect" || (f.type === "string" && f.options?.length)) {
    const multi = f.type === "multiselect";
    const list = multi ? ((val as string[]) || []) : [];
    const known = new Set((f.options || []).map((o) => o.value));
    const customText = multi ? list.find((x) => !known.has(x)) || "" : typeof val === "string" && !known.has(val) ? val : "";
    return (
      <div className="fc-field">
        {head}
        <div className="fc-opts">
          {(f.options || []).map((o) => {
            const on = multi ? list.includes(o.value) : val === o.value;
            return (
              <Choice
                key={o.value}
                label={o.label}
                description={o.description}
                multi={multi}
                on={on}
                onClick={() => set(f.key, multi ? (on ? list.filter((x) => x !== o.value) : [...list, o.value]) : o.value)}
              />
            );
          })}
        </div>
        {f.custom !== false && (
          <input
            className="input fc-custom"
            placeholder="Type your own answer"
            value={customText}
            onChange={(e) => {
              const t = e.target.value;
              if (multi) set(f.key, [...list.filter((x) => known.has(x)), ...(t ? [t] : [])]);
              else set(f.key, t || undefined);
            }}
          />
        )}
      </div>
    );
  }
  const numeric = f.type === "number" || f.type === "integer";
  return (
    <div className="fc-field">
      {head}
      <input
        className="input"
        type={numeric ? "number" : "text"}
        min={f.minimum}
        max={f.maximum}
        step={f.type === "integer" ? 1 : undefined}
        placeholder={f.placeholder}
        value={val === undefined ? "" : String(val)}
        onChange={(e) => set(f.key, numeric ? (e.target.value === "" ? undefined : Number(e.target.value)) : e.target.value)}
      />
    </div>
  );
}

export function FormCard({ form }: { form: Form }) {
  const [v, setV] = useState<Values>(() => initial(form));
  const set = (k: string, x: unknown) => setV((o) => ({ ...o, [k]: x }));
  const shown = form.fields.filter((f) => visible(f, v));
  const missing = useMemo(
    () => shown.some((f) => f.required && (v[f.key] === undefined || v[f.key] === "" || (Array.isArray(v[f.key]) && !(v[f.key] as unknown[]).length))),
    [shown, v],
  );
  const submit = () => {
    const answer: Values = {};
    for (const f of shown) if (v[f.key] !== undefined && f.type !== "external") answer[f.key] = v[f.key];
    answerForm(form, answer);
  };
  return (
    <div className="perm fc">
      <div className="perm-title"><MessageCircleQuestion size={16} /><span>{form.title || "The agent has a question"}</span></div>
      {shown.map((f) => <Field key={f.key} f={f} v={v} set={set} />)}
      <div className="perm-btns">
        <button type="button" className="btn" onClick={() => answerForm(form, null)}>Skip</button>
        <button type="button" className="btn primary" disabled={missing} onClick={submit}>Send answer</button>
      </div>
    </div>
  );
}
