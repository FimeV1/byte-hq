import { useEffect, useState } from "react";
import { CircleCheck, ExternalLink, LifeBuoy, LoaderCircle, RotateCw, TriangleAlert, Wrench } from "lucide-react";
import { hq } from "./api";
import { checkKey, openByteHelp, openModal, openModels, runCheck, toast, useStore } from "./store";
import type { ByteKeyInfo, ModelCheck, ModelRef } from "./types";
import { Dialog } from "./ui";

export const BYTE_SITE = "https://api.bytedev.co.uk";

/** One "Try it" result in words. */
export function CheckLine({ r, byte }: { r: ModelCheck | undefined; byte?: boolean }) {
  if (!r) return <small>Not tried yet</small>;
  if (r.ok) return <small className="ck ok"><CircleCheck size={13} /> Chats and uses tools: it can edit files and run commands</small>;
  if (r.code === "tools" && r.chat) {
    return <small className="ck bad"><TriangleAlert size={13} /> Chats, but can't use tools{byte ? ": your key has no tool access yet" : ""}, so it can't edit files or run commands</small>;
  }
  return <small className="ck bad"><TriangleAlert size={13} /> {cap(r.problem || "didn't work")}</small>;
}
const cap = (s: string) => s[0].toUpperCase() + s.slice(1);

/** What to do when a model can't use tools. The Byte API can be fixed from our side; other servers only by their owner. */
export function NoToolsAdvice({ byte, backend }: { byte: boolean; backend?: string }) {
  if (byte) {
    return (
      <div className="help-box">
        <b>Your Byte API key doesn't have tool access yet.</b> Tool access is turned on per key. Ask for it and keep using the same key: nothing changes in HQ.
        <div className="help-btns">
          <button type="button" className="btn primary" onClick={() => openByteHelp(backend)}><LifeBuoy size={14} /> Get tool access</button>
        </div>
      </div>
    );
  }
  return (
    <div className="help-box">
      HQ can't turn tools on for this server: that's a setting of the model server or provider. Common fixes: llama.cpp needs
      <code>--jinja</code>; vLLM needs <code>--enable-auto-tool-choice</code> and a <code>--tool-call-parser</code>; on Ollama and LM Studio pick a
      model made for tool use. Otherwise pick another model for coding.
    </div>
  );
}

/** "Byte API help": getting a key, tool access, credit, a refused key. Only for the Byte API. */
export function ByteHelpDialog() {
  const backends = useStore((s) => s.backends);
  const start = useStore((s) => s.ui.modalBackend);
  const checks = useStore((s) => s.checks);
  const models = useStore((s) => s.models);
  const [busy, setBusy] = useState(false);
  const [round, setRound] = useState(0); // Test again also looks the keys up again
  // Byte API models on every machine, with their last result.
  const mine = backends.flatMap((b) =>
    (models[b.id] || [])
      .filter((m) => checks[b.id]?.byte.includes(m.providerID))
      .map((m) => ({ backend: b, model: m, r: checks[b.id]?.results[checkKey(b.id, m.providerID, m.id)] })),
  ).sort((a, b) => (a.backend.id === start ? -1 : b.backend.id === start ? 1 : 0));
  const testAll = async () => {
    setBusy(true);
    setRound((n) => n + 1);
    try {
      for (const x of mine) await runCheck(x.backend.id, x.model.providerID, x.model.id);
    } finally {
      setBusy(false);
    }
  };
  // One "Your key" panel per Byte API provider (a key), not per model.
  const keys = [...new Map(mine.map((x) => [x.backend.id + "/" + x.model.providerID, { backend: x.backend, providerID: x.model.providerID }])).values()];
  return (
    <Dialog title="Byte API help" onClose={() => openModal(null)}>
      {mine.length > 0 ? (
        <>
          <div className="field-label" style={{ marginTop: 0 }}>Your Byte API models</div>
          <div className="rows">
            {mine.map((x) => (
              <div className="rowline" key={x.backend.id + x.model.id}>
                <div className="grow">{x.model.name}{backends.length > 1 ? ` · ${x.backend.label}` : ""}<CheckLine r={x.r} byte /></div>
              </div>
            ))}
          </div>
          <button type="button" className="btn" style={{ marginTop: 8 }} disabled={busy} onClick={testAll}>
            {busy ? <LoaderCircle size={14} className="spin" /> : <RotateCw size={14} />} Test again
          </button>
        </>
      ) : (
        <div className="help-box" style={{ marginTop: 0 }}>
          The Byte API isn't added yet. <button type="button" className="linkish" onClick={() => openModels(start)}>Add it in Settings › Models</button> with your key.
        </div>
      )}

      {keys.map((x) => <ByteKeyPanel key={x.backend.id + x.providerID} backend={x.backend.id} providerID={x.providerID} label={keys.length > 1 ? x.backend.label : ""} round={round} />)}

      <div className="field-label">Getting a key</div>
      <p className="help-p">
        Request one on <a href={BYTE_SITE} target="_blank" rel="noopener">api.bytedev.co.uk</a>. In the form's reason box, say you'll use it with HQ
        for coding and need <b>tool access</b>: without it the models can chat but can't read or edit files or run commands.
      </p>

      <div className="field-label">It chats, but never edits files</div>
      <p className="help-p">
        Your key has no tool access yet. Press <b>Ask for tool access</b> under “Your key” above: it's turned on by hand, and you keep the same key.
        HQ looks again by itself, or press <b>Test again</b>. You can also ask, and check your key, on{" "}
        <a href={BYTE_SITE + "/#balance"} target="_blank" rel="noopener">api.bytedev.co.uk</a>.
      </p>

      <div className="field-label">“Out of credit” or “out of tokens”</div>
      <p className="help-p">
        Keys are prepaid: check your balance and top up on <a href={BYTE_SITE} target="_blank" rel="noopener">api.bytedev.co.uk</a>. A token limit
        resets by itself; the message says when.
      </p>

      <div className="field-label">“Invalid API key” or “revoked”</div>
      <p className="help-p">
        Check the whole key was pasted. To use a different key: Settings › Models, remove Byte API, then add it again with the new key.
      </p>

      <div className="vault-note" style={{ marginTop: 14 }}>
        This help is for the Byte API only. For any other provider or model server, their own docs or support are the place to ask: HQ's
        <b> Test</b> tells you what's wrong, but can't change their settings.
      </div>
      <a className="btn" style={{ marginTop: 10 }} href={BYTE_SITE} target="_blank" rel="noopener"><ExternalLink size={13} /> Open api.bytedev.co.uk</a>
    </Dialog>
  );
}

/** The key as the Byte API reports it: balance, tool access, limits. Read-only, plus the one button to ask for tools. */
function ByteKeyPanel({ backend, providerID, label, round }: { backend: string; providerID: string; label: string; round: number }) {
  const [info, setInfo] = useState<ByteKeyInfo | null>(null);
  const [err, setErr] = useState("");
  const [asking, setAsking] = useState(false);
  const load = () => hq.byteKey(backend, providerID).then((d) => (setInfo(d), setErr(""))).catch((e) => setErr(e.message || "couldn't look it up"));
  useEffect(() => {
    load();
  }, [backend, providerID, round]);
  const ask = async () => {
    setAsking(true);
    try {
      const r = await hq.byteAskTools(backend, providerID);
      if (r.status === "on") toast("Tool access is already on", "info");
      await load();
    } catch (e: any) {
      toast(e.message || "Couldn't ask");
    } finally {
      setAsking(false);
    }
  };
  const n = (v: number) => v.toLocaleString();
  return (
    <>
      <div className="field-label">Your key{label ? ` · ${label}` : ""}</div>
      {err && <div className="help-box" style={{ marginTop: 0 }}>Couldn't look it up: {err}</div>}
      {!info && !err && <small className="ck"><LoaderCircle size={13} className="spin" /> Looking it up…</small>}
      {info && (
        <div className="rows">
          {info.name && <div className="rowline"><div className="grow">Name</div><span>{info.name}</span></div>}
          <div className="rowline"><div className="grow">Balance</div><span>{info.metered ? info.balance : "Not billed"}</span></div>
          <div className="rowline">
            <div className="grow">Tool access<small>Reading and editing files, running commands</small></div>
            {info.tools ? <span className="ck ok"><CircleCheck size={13} /> On</span> : info.tools === false ? <span className="ck bad">Off</span> : <span>Not reported</span>}
          </div>
          {info.tokenBudget != null && (
            <div className="rowline">
              <div className="grow">Tokens {info.tokenWindow === "day" ? "today" : `this ${info.tokenWindow}`}{info.tokensRenew && <small>Resets {info.tokensRenew}</small>}</div>
              <span>{n(info.tokensUsed || 0)} of {n(info.tokenBudget)}</span>
            </div>
          )}
          {info.requestsToday != null && (
            <div className="rowline"><div className="grow">Requests today</div><span>{info.dailyRequests ? `${n(info.requestsToday)} of ${n(info.dailyRequests)}` : n(info.requestsToday)}</span></div>
          )}
        </div>
      )}
      {info?.tools === false && (
        <div className="help-box">
          {info.toolsRequested ? (
            <><b>Tool access asked for.</b> It's turned on by hand. HQ notices by itself once it's on, or press Test again.</>
          ) : (
            <>
              Without tool access, models chat but can't edit files or run commands.
              <div className="help-btns">
                <button type="button" className="btn primary" disabled={asking} onClick={ask}>
                  {asking ? <LoaderCircle size={14} className="spin" /> : <Wrench size={14} />} Ask for tool access
                </button>
              </div>
            </>
          )}
        </div>
      )}
    </>
  );
}

// ---- errors in plain words --------------------------------------------------------------------------

type Explained = { title: string; hint?: string; action?: "models" | "byte" | "again" };

/** Turn a provider's error into what happened and what to do. Unknown errors keep their own text. */
export function explainError(raw: string, byte: boolean): Explained | null {
  const t = raw.toLowerCase();
  const has = (re: RegExp) => re.test(t);
  if (has(/context (length|window|size)|maximum context|prompt is too long|too many tokens|exceeds? .*context|n_ctx|context_length_exceeded|input is too long|reduce the length/)) {
    return { title: "The chat is too long for this model's context.", hint: "Start a new chat (or branch from an earlier turn). If the model's server really runs a bigger context, raise it in Settings › Models.", action: "models" };
  }
  if (has(/out of credit|insufficient (funds|balance|credit|quota)|payment required|billing|\b402\b|credit balance/)) {
    return byte
      ? { title: "Your Byte API balance is empty.", hint: "Top up on api.bytedev.co.uk, then send the message again.", action: "byte" }
      : { title: "Out of credit with this provider.", hint: "Add credit on the provider's website, or pick another model." };
  }
  if (has(/out of tokens|daily limit|rate limit|too many requests|\b429\b|quota exceeded|resource_exhausted/)) {
    return byte
      ? { title: "Your Byte API key reached its limit.", hint: "It resets by itself (the message below says when). Or pick another model for now.", action: "byte" }
      : { title: "The provider's usage limit was reached.", hint: "Wait a little and send it again, or pick another model.", action: "again" };
  }
  if (has(/invalid api key|incorrect api key|api key (is )?(invalid|missing|not valid)|unauthori[sz]ed|authentication|\b401\b|revoked|invalid x-api-key|permission denied|\b403\b/)) {
    return byte
      ? { title: "The Byte API refused your key.", hint: "It may be mistyped or revoked. Byte API help says how to change it.", action: "byte" }
      : { title: "The model's server refused the API key.", hint: "Check the key in Settings › Models (remove the provider and add it with the right key).", action: "models" };
  }
  if (has(/(does not|doesn't) support tools|tools? (are |is )?not supported|tool calling is not|tool_choice|function calling is not/)) {
    return { title: "This model's server doesn't accept tool calls, so it can't edit files.", hint: byte ? "Ask for tool access on your Byte API key." : "Pick another model for coding, or turn tool calling on in the server's settings.", action: byte ? "byte" : "models" };
  }
  if (has(/model .*(not found|does not exist|not exist|unknown)|unknown model|no such model|model_not_found|\b404\b/)) {
    return { title: "The server doesn't have this model.", hint: "It may have been renamed or removed. Pick another model, or add it again in Settings › Models.", action: "models" };
  }
  if (has(/econnrefused|connection refused|fetch failed|enotfound|getaddrinfo|socket hang up|network|unable to connect|connect etimedout|econnreset/)) {
    return { title: "OpenCode couldn't reach the model's server.", hint: "Is it running, and is the address right? For a server on your own computer, start it and send the message again.", action: "again" };
  }
  if (has(/overloaded|\b50[234]\b|bad gateway|service unavailable|temporarily unavailable|server error|internal error/)) {
    return { title: "The model's server had a problem or is busy.", hint: "Send it again in a moment.", action: "again" };
  }
  if (has(/timed? ?out|timeout|deadline exceeded/)) {
    return { title: "The model took too long to answer.", hint: "A model that's still loading can be slow the first time. Send it again.", action: "again" };
  }
  return null;
}

/** A failed reply: the plain-words explanation with a button for the fix, and the original message underneath. */
export function ErrorNotice({ error, model, backend, onAgain }: { error: string; model?: ModelRef; backend?: string; onAgain?: () => void }) {
  const byte = useStore((s) => !!(backend && model && s.checks[backend]?.byte.includes(model.providerID)));
  const [open, setOpen] = useState(false);
  const e = explainError(error, byte);
  if (!e) return <div className="notice err">{error}</div>;
  return (
    <div className="notice err err-help">
      <div className="err-title">{e.title}</div>
      {e.hint && <div className="err-hint">{e.hint}</div>}
      <div className="help-btns">
        {e.action === "byte" && <button type="button" className="btn" onClick={() => openByteHelp(backend)}><LifeBuoy size={14} /> Byte API help</button>}
        {e.action === "models" && <button type="button" className="btn" onClick={() => openModels(backend)}><Wrench size={14} /> Settings › Models</button>}
        {onAgain && e.action === "again" && <button type="button" className="btn" onClick={onAgain}><RotateCw size={14} /> Send again</button>}
        <button type="button" className="linkish" onClick={() => setOpen(!open)}>{open ? "Hide" : "Show"} the server's message</button>
      </div>
      {open && <pre className="err-raw">{error}</pre>}
    </div>
  );
}

/** Above the message box: the chosen model was tried and can't use tools. */
export function ToolsBanner({ backend, model }: { backend?: string; model?: ModelRef }) {
  const c = useStore((s) => (backend ? s.checks[backend] : undefined));
  const [hidden, setHidden] = useState("");
  if (!backend || !model || !c) return null;
  const k = checkKey(backend, model.providerID, model.id);
  const r = c.results[k];
  if (!r || r.ok || r.code !== "tools" || hidden === k) return null;
  const byte = c.byte.includes(model.providerID);
  return (
    <div className="queued tools-bar">
      <TriangleAlert size={15} />
      <span className="q-text">
        {byte ? "Your Byte API key has no tool access yet: this model can chat, but can't edit files or run commands." : "This model can chat, but can't use tools: it won't edit files or run commands."}
      </span>
      <button type="button" className="btn primary" onClick={() => (byte ? openByteHelp(backend) : openModels(backend))}>{byte ? "Fix it" : "Details"}</button>
      <button type="button" className="act" onClick={() => setHidden(k)} aria-label="Hide" title="Hide">×</button>
    </div>
  );
}
