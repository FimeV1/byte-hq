import { useEffect, useMemo, useState } from "react";
import { ChevronLeft, Cloud, Copy, FlaskConical, Globe, KeyRound, LifeBuoy, LoaderCircle, Server, Trash2 } from "lucide-react";
import { hq } from "./api";
import { checkKey, loadChecks, openByteHelp, openModal, reloadModels, runCheck, toast, useStore } from "./store";
import type { ModelCheck } from "./types";
import { CheckLine, NoToolsAdvice } from "./Help";
import { Dialog } from "./ui";

/** What /hq/models/status returns (see models.mjs). */
type Status = {
  file: string | null;
  fileState: "absent" | "ours" | "theirs" | null;
  fileError: string | null;
  providers: { id: string; name: string; models: number; baseURL: string; source: "hq" | "key" | "config"; credentialID: string | null }[];
  integrations: { id: string; name: string; connected: boolean }[];
};
type Found = { id: string; name: string; context: number; images: boolean; on: boolean };

/** OpenAI-compatible servers people use most. "localhost" means the machine that runs OpenCode. */
const SERVERS = [
  {
    key: "byte", name: "Byte API", id: "byte-api", url: "https://api.bytedev.co.uk/v1", needsKey: true, hosted: true,
    note: "Hosted models: no GPU of your own needed. Get a key at api.bytedev.co.uk, and ask for tool access when you do: coding needs it (reading and editing files, running commands). After adding, HQ tests whether your key has it.",
    keep: (id: string) => /^byte-(chat|coder)/.test(id),
  },
  { key: "ollama", name: "Ollama", id: "ollama", url: "http://localhost:11434/v1", needsKey: false, note: "Ollama answers with its own context size (num_ctx, often 4096 unless you raised it): enter that same number below." },
  { key: "lmstudio", name: "LM Studio", id: "lm-studio", url: "http://localhost:1234/v1", needsKey: false, note: "Start the server in LM Studio's Developer tab first." },
  { key: "llamacpp", name: "llama.cpp server", id: "llama-cpp", url: "http://localhost:8080/v1", needsKey: false, note: "Start llama-server with --jinja so tool calls work." },
  { key: "vllm", name: "vLLM", id: "vllm", url: "http://localhost:8000/v1", needsKey: false, note: "Start vLLM with tool calling on (--enable-auto-tool-choice and a --tool-call-parser for your model)." },
  { key: "other", name: "Other API", id: "", url: "", needsKey: false, note: "Any server with /v1/chat/completions and /v1/models." },
] as const;
type Preset = (typeof SERVERS)[number];

const post = async <T,>(path: string, body: unknown): Promise<T> => {
  const r = await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.message || `HQ answered ${r.status}`);
  return d as T;
};
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function ModelsDialog() {
  const backends = useStore((s) => s.backends);
  const start = useStore((s) => s.ui.modalBackend);
  const [backendId, setBackendId] = useState(start && backends.some((b) => b.id === start) ? start : backends[0]?.id || "");
  const backend = backends.find((b) => b.id === backendId);
  const [status, setStatus] = useState<Status | null>(null);
  const [error, setError] = useState("");
  const [view, setView] = useState<{ kind: "list" } | { kind: "server"; preset: Preset } | { kind: "cloud" }>({ kind: "list" });

  const load = () => {
    if (!backendId) return;
    setError("");
    fetch(`/hq/models/status?backend=${encodeURIComponent(backendId)}`)
      .then(async (r) => (r.ok ? r.json() : Promise.reject(new Error((await r.json().catch(() => ({}))).message || `HQ answered ${r.status}`))))
      .then(setStatus)
      .catch((e) => setError(msg(e)));
  };
  useEffect(() => (setStatus(null), load()), [backendId]); // eslint-disable-line react-hooks/exhaustive-deps
  const done = async (text: string, tryModels?: { providerID: string; ids: string[] }) => {
    toast(text, "ok");
    setView({ kind: "list" });
    load();
    await Promise.all([reloadModels(backendId), loadChecks(backendId)]);
    // Try what was just added (a few at most), so a model that can't use tools says so now, not mid-task.
    if (tryModels) for (const id of tryModels.ids.slice(0, 4)) await runCheck(backendId, tryModels.providerID, id).catch(() => null);
  };
  const close = () => openModal(null);

  if (view.kind === "server" && backend) {
    return (
      <Dialog title={`Add ${view.preset.name}`} onClose={close}>
        <ServerForm backendId={backendId} machine={backend.label} preset={view.preset} status={status} onBack={() => setView({ kind: "list" })} onDone={done} />
      </Dialog>
    );
  }
  if (view.kind === "cloud" && backend) {
    return (
      <Dialog title="Add a cloud provider" onClose={close}>
        <CloudForm backendId={backendId} status={status} onBack={() => setView({ kind: "list" })} onDone={done} />
      </Dialog>
    );
  }

  return (
    <Dialog title="Models" onClose={close}>
      {backends.length > 1 && (
        <div className="seg" style={{ marginBottom: 14 }}>
          {backends.map((b) => (
            <button key={b.id} type="button" className={b.id === backendId ? "on" : ""} onClick={() => setBackendId(b.id)}>{b.label}</button>
          ))}
        </div>
      )}
      <div className="vault-note">
        Models are set up on the OpenCode server{backends.length > 1 ? " of the machine picked above" : ""}: it's the one that calls them.
      </div>
      {error && <div className="notice err">{error}</div>}
      {!status && !error && <div className="sb-empty"><LoaderCircle size={15} className="spin" /> Loading…</div>}
      {status && (
        <>
          <div className="field-label">On {backend?.label}</div>
          <div className="rows">
            {status.providers.length === 0 && <div className="rowline"><div className="grow">No models yet<small>Add one below.</small></div></div>}
            {status.providers.map((p) => <ProviderRow key={p.id} p={p} backendId={backendId} onChanged={done} />)}
          </div>
          <div className="field-label">Add models</div>
          <div className="md-grid">
            {SERVERS.map((s) => (
              <button key={s.key} type="button" className={"md-card" + ("hosted" in s ? " hosted" : "")} onClick={() => setView({ kind: "server", preset: s })}>
                {"hosted" in s ? <Globe size={17} /> : <Server size={17} />}
                <span>{s.name}<small>{"hosted" in s ? "Hosted, with a key" : s.key === "other" ? "Any OpenAI-compatible address" : "Runs on your machine"}</small></span>
              </button>
            ))}
            <button type="button" className="md-card" onClick={() => setView({ kind: "cloud" })}>
              <Cloud size={17} />
              <span>Cloud provider<small>OpenAI, Anthropic, OpenRouter… with a key</small></span>
            </button>
          </div>
          {status.fileState === "theirs" && (
            <div className="vault-note" style={{ marginTop: 12 }}>
              This server already has its own {status.file}, so HQ won't edit it: when you add a server, HQ shows the lines to paste into it.
            </div>
          )}
        </>
      )}
    </Dialog>
  );
}

function ProviderRow({ p, backendId, onChanged }: { p: Status["providers"][number]; backendId: string; onChanged: (t: string) => void }) {
  const [busy, setBusy] = useState(false);
  const [sure, setSure] = useState(false);
  const [testing, setTesting] = useState(false);
  const all = useStore((s) => s.models[backendId]);
  const results = useStore((s) => s.checks[backendId]?.results);
  const byte = useStore((s) => !!s.checks[backendId]?.byte.includes(p.id));
  const models = (all || []).filter((m) => m.providerID === p.id);
  const testable = p.source === "hq";
  const res = (id: string) => results?.[checkKey(backendId, p.id, id)];
  const noTools = testable && models.some((m) => res(m.id)?.code === "tools");
  const testAll = async () => {
    setTesting(true);
    try {
      for (const m of models.slice(0, 8)) await runCheck(backendId, p.id, m.id);
    } finally {
      setTesting(false);
    }
  };
  const removable = p.source === "hq" || (p.source === "key" && p.credentialID);
  const remove = async () => {
    if (!sure) return setSure(true);
    setBusy(true);
    try {
      if (p.source === "hq") await post("/hq/models/remove", { backend: backendId, id: p.id });
      else await post("/hq/models/disconnect", { backend: backendId, credentialID: p.credentialID });
      onChanged(`Removed ${p.name}`);
    } catch (e) {
      toast(msg(e));
      setBusy(false);
      setSure(false);
    }
  };
  const where = p.source === "hq" ? "added in HQ" : p.source === "key" ? "key added in HQ or OpenCode" : "from the server's own config";
  return (
    <div className="rowline">
      <div className="grow">
        {p.name}
        <small>{p.models} model{p.models === 1 ? "" : "s"} · {where}{p.baseURL ? ` · ${p.baseURL}` : ""}</small>
      </div>
      {byte && <button type="button" className="btn" onClick={() => openByteHelp(backendId)} title="Byte API help"><LifeBuoy size={14} /> Help</button>}
      {testable && models.length > 0 && (
        <button type="button" className="btn" disabled={testing} onClick={testAll} title="Ask each model to call a test tool: shows whether it can edit files">
          {testing ? <LoaderCircle size={14} className="spin" /> : <FlaskConical size={14} />} Test
        </button>
      )}
      {removable && (
        <button type="button" className={"btn" + (sure ? " danger" : "")} disabled={busy} onClick={remove} onBlur={() => setSure(false)} title="Remove">
          {sure ? "Remove?" : <Trash2 size={14} />}
        </button>
      )}
      {testable && models.length > 0 && (
        <div className="md-checks">
          {models.slice(0, 8).map((m) => (
            <div key={m.id}><bdi>{m.name}</bdi><CheckLine r={res(m.id)} byte={byte} /></div>
          ))}
          {noTools && <NoToolsAdvice byte={byte} backend={backendId} />}
        </div>
      )}
    </div>
  );
}

function ServerForm({ backendId, machine, preset, status, onBack, onDone }: {
  backendId: string; machine: string; preset: Preset; status: Status | null; onBack: () => void; onDone: (t: string, tryModels?: { providerID: string; ids: string[] }) => void;
}) {
  const [tried, setTried] = useState<{ model: string; r: ModelCheck } | null>(null);
  const [trying, setTrying] = useState(false);
  const [name, setName] = useState<string>(preset.key === "other" ? "" : preset.name);
  const [id, setId] = useState<string>(preset.id);
  const [idTouched, setIdTouched] = useState(false);
  const [url, setUrl] = useState<string>(preset.url);
  const [key, setKey] = useState("");
  const [found, setFound] = useState<Found[] | null>(null);
  const [via, setVia] = useState("");
  const [busy, setBusy] = useState<"" | "probe" | "add">("");
  const [error, setError] = useState("");
  const [snippet, setSnippet] = useState<{ file: string; text: string } | null>(null);
  const taken = status?.providers.some((p) => p.id === id && p.source !== "hq");
  const local = /\/\/(localhost|127\.0\.0\.1|\[::1\])[:/]/.test(url);

  const probe = async () => {
    setBusy("probe");
    setError("");
    setFound(null);
    try {
      const r = await post<{ models: { id: string; context: number }[]; reachedAt: string; viaMachine: boolean }>("/hq/models/probe", { backend: backendId, baseURL: url, apiKey: key });
      const keep = "keep" in preset ? r.models.filter((m) => preset.keep(m.id)) : r.models;
      const list = keep.length ? keep : r.models;
      setFound(list.map((m) => ({ id: m.id, name: m.id, context: m.context || 32768, images: false, on: list.length <= 8 })));
      setVia(r.viaMachine ? r.reachedAt : "");
      if (!list.length) setError("The server answered, but lists no models. Load a model on it first.");
    } catch (e) {
      setError(msg(e));
      setFound([]); // still allow typing a model name by hand
    } finally {
      setBusy("");
    }
  };
  const add = async () => {
    const models = (found || []).filter((m) => m.on);
    setBusy("add");
    setError("");
    try {
      const r = await post<{ pasted: boolean; file: string; snippet?: string; models?: number; warning?: string }>("/hq/models/add", {
        backend: backendId,
        spec: { id, name: name || id, baseURL: url, apiKey: key, models: models.map((m) => ({ id: m.id, name: m.name, context: m.context, images: m.images })) },
      });
      if (!r.pasted) return setSnippet({ file: r.file, text: r.snippet || "" });
      if (r.warning) toast(r.warning, "info");
      onDone(`Added ${name || id}: ${models.length} model${models.length === 1 ? "" : "s"}`, { providerID: id, ids: models.map((m) => m.id) });
    } catch (e) {
      setError(msg(e));
    } finally {
      setBusy("");
    }
  };
  const set = (i: number, patch: Partial<Found>) => setFound((f) => (f ? f.map((m, j) => (j === i ? { ...m, ...patch } : m)) : f));

  if (snippet) {
    return (
      <>
        <BackLink onBack={onBack} />
        <div className="vault-note">
          {machine} already has its own <code>{snippet.file}</code>, and HQ never edits a config it didn't create. Merge this into it (keep your other providers; OpenCode reloads the file by itself):
        </div>
        <pre className="md-snippet">{snippet.text}</pre>
        <button type="button" className="btn" onClick={() => navigator.clipboard.writeText(snippet.text).then(() => toast("Copied", "info"))}><Copy size={13} /> Copy</button>
        <div className="vault-note" style={{ marginTop: 10 }}>It contains your key, so keep that file private.</div>
      </>
    );
  }

  const chosen = (found || []).filter((m) => m.on).length;
  const tryFirst = async () => {
    const m = (found || []).find((x) => x.on);
    if (!m) return;
    setTrying(true);
    setTried(null);
    try {
      setTried({ model: m.id, r: await hq.modelCheck(backendId, { baseURL: url, apiKey: key, modelID: m.id }) });
    } catch (e) {
      setError(msg(e));
    } finally {
      setTrying(false);
    }
  };
  return (
    <>
      <BackLink onBack={onBack} />
      <div className="vault-note">
        {preset.note}
        {preset.key === "byte" && <> <button type="button" className="linkish" onClick={() => openByteHelp(backendId)}>Byte API help</button></>}
      </div>
      {preset.key === "other" && (
        <>
          <div className="field-label">Name</div>
          <input className="input" placeholder="e.g. My GPU box" value={name} onChange={(e) => (setName(e.target.value), !idTouched && setId(slug(e.target.value)))} />
        </>
      )}
      <div className="field-label">Address <em>· ends in /v1</em></div>
      <input className="input" placeholder="http://localhost:8080/v1" value={url} onChange={(e) => setUrl(e.target.value)} spellCheck={false} autoCapitalize="off" />
      {local && <div className="notice">localhost here means {machine}, the machine running OpenCode.</div>}
      <div className="field-label">API key {preset.needsKey ? "" : <em>· leave empty if the server has none</em>}</div>
      <input className="input" type="password" autoComplete="off" placeholder={preset.needsKey ? "Paste your key" : "None"} value={key} onChange={(e) => setKey(e.target.value)} />
      <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
        <button type="button" className="btn big primary" disabled={!url || (preset.needsKey && !key) || !!busy} onClick={probe}>
          {busy === "probe" ? <LoaderCircle size={14} className="spin" /> : null} Find its models
        </button>
      </div>
      {error && <div className="notice err">{error}</div>}
      {via && <div className="notice">Reached it at {via}.</div>}
      {found && (
        <>
          <div className="field-label">Models <em>· context = how many tokens it was started with</em></div>
          {found.length === 0 && <ManualModel onAdd={(m) => setFound([{ ...m, context: 32768, images: false, on: true }])} />}
          <div className="md-models">
            {found.map((m, i) => (
              <div key={m.id} className={"md-model" + (m.on ? " on" : "")}>
                <label className="md-check"><input type="checkbox" checked={m.on} onChange={(e) => set(i, { on: e.target.checked })} /><bdi>{m.id}</bdi></label>
                {m.on && (
                  <div className="md-opts">
                    <label>Context <input className="input md-num" type="number" min={2048} step={1024} value={m.context} onChange={(e) => set(i, { context: Number(e.target.value) })} /></label>
                    <label><input type="checkbox" checked={m.images} onChange={(e) => set(i, { images: e.target.checked })} /> Sees images</label>
                  </div>
                )}
              </div>
            ))}
          </div>
          {preset.key !== "byte" && (
            <>
              <div className="field-label">Short name <em>· how OpenCode refers to it</em></div>
              <input className="input" value={id} onChange={(e) => (setId(slug(e.target.value)), setIdTouched(true))} />
              {taken && <div className="notice err">“{id}” is already used on {machine}: pick another.</div>}
            </>
          )}
          {tried && (
            <div className="md-checks" ref={(el) => el?.scrollIntoView({ block: "nearest", behavior: "smooth" })}>
              <div><bdi>{tried.model}</bdi><CheckLine r={tried.r} byte={preset.key === "byte"} /></div>
              {tried.r.code === "tools" && tried.r.chat && <NoToolsAdvice byte={preset.key === "byte"} backend={backendId} />}
            </div>
          )}
          <div className="dialog-foot" style={{ padding: "16px 0 0" }}>
            <button type="button" className="btn big" disabled={!chosen || trying || !!busy} onClick={tryFirst} title="Ask the first ticked model to call a test tool, before adding it">
              {trying ? <LoaderCircle size={14} className="spin" /> : <FlaskConical size={14} />} Test first
            </button>
            <button type="button" className="btn big primary" disabled={!chosen || !id || taken || !!busy} onClick={add}>
              {busy === "add" ? <LoaderCircle size={14} className="spin" /> : null} Add {chosen || ""} model{chosen === 1 ? "" : "s"}
            </button>
          </div>
        </>
      )}
    </>
  );
}

function ManualModel({ onAdd }: { onAdd: (m: { id: string; name: string }) => void }) {
  const [v, setV] = useState("");
  return (
    <div style={{ display: "flex", gap: 8, marginBottom: 8 }}>
      <input className="input" placeholder="Model name, exactly as the server knows it" value={v} onChange={(e) => setV(e.target.value)} />
      <button type="button" className="btn big" disabled={!v.trim()} onClick={() => onAdd({ id: v.trim(), name: v.trim() })}>Use</button>
    </div>
  );
}

function CloudForm({ backendId, status, onBack, onDone }: { backendId: string; status: Status | null; onBack: () => void; onDone: (t: string) => void }) {
  const [q, setQ] = useState("");
  const [pick, setPick] = useState<{ id: string; name: string } | null>(null);
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const all = status?.integrations || [];
  const shown = useMemo(() => {
    const t = q.trim().toLowerCase();
    const popular = ["openrouter", "openai", "anthropic", "google", "deepseek", "mistral", "groq", "together", "fireworks", "xai"];
    const list = t ? all.filter((i) => i.name.toLowerCase().includes(t) || i.id.includes(t)) : popular.map((id) => all.find((i) => i.id === id)).filter(Boolean) as typeof all;
    return list.slice(0, 40);
  }, [q, all]);
  const connect = async () => {
    if (!pick) return;
    setBusy(true);
    setError("");
    try {
      const r = await post<{ models: number; warning?: string }>("/hq/models/connect", { backend: backendId, integrationID: pick.id, key });
      if (r.warning) toast(r.warning, "info");
      onDone(`Connected ${pick.name}${r.models ? `: ${r.models} models` : ""}`);
    } catch (e) {
      setError(msg(e));
      setBusy(false);
    }
  };
  if (pick) {
    return (
      <>
        <BackLink onBack={() => (setPick(null), setKey(""), setError(""))} />
        <div className="field-label" style={{ marginTop: 0 }}>{pick.name} API key</div>
        <input className="input" type="password" autoComplete="off" autoFocus placeholder="Paste your key" value={key} onChange={(e) => setKey(e.target.value)} onKeyDown={(e) => e.key === "Enter" && key && connect()} />
        <div className="vault-note" style={{ marginTop: 8 }}>OpenCode keeps the key on that server (not in HQ). Cloud providers charge for what you use.</div>
        {error && <div className="notice err">{error}</div>}
        <div className="dialog-foot" style={{ padding: "16px 0 0" }}>
          <button type="button" className="btn big primary" disabled={!key.trim() || busy} onClick={connect}>
            {busy ? <LoaderCircle size={14} className="spin" /> : <KeyRound size={14} />} Connect
          </button>
        </div>
      </>
    );
  }
  return (
    <>
      <BackLink onBack={onBack} />
      <input className="input" autoFocus placeholder={`Search ${all.length} providers`} value={q} onChange={(e) => setQ(e.target.value)} />
      <div className="md-list">
        {!q && <div className="field-label" style={{ margin: "12px 0 6px" }}>Popular</div>}
        {shown.map((i) => (
          <button key={i.id} type="button" className="md-item" onClick={() => setPick(i)}>
            <span className="grow">{i.name}</span>
            {i.connected && <small>connected</small>}
          </button>
        ))}
        {q && shown.length === 0 && <div className="sb-empty">No provider called that. For any other API, go back and use “Other API”.</div>}
      </div>
    </>
  );
}

const BackLink = ({ onBack }: { onBack: () => void }) => (
  <button type="button" className="md-back" onClick={onBack}><ChevronLeft size={15} /> Back</button>
);
