// Hands-free voice conversation, like ChatGPT's voice mode.
//
// Loop: listen (voice activity detection on the mic) -> speech-to-text (config.voice.stt) -> send to the open
// chat -> read the reply aloud with Kokoro sentence by sentence while it streams -> listen again.
// Talking over the reply stops it (barge-in). Talking while the agent works queues the message.
import { useEffect, useRef, useState } from "react";
import { Mic, MicOff, Square, X } from "lucide-react";
import { api } from "./api";
import { ensureSession, getState, sendPrompt, setVoiceName, setVoiceOpen, stop, toast, useStore } from "./store";
import { buildTurns, viewTurn } from "./turns";

const VOICES: [string, string][] = [
  ["am_michael", "Michael (US)"], ["am_onyx", "Onyx (US)"], ["af_heart", "Heart (US)"],
  ["bm_george", "George (UK)"], ["bm_lewis", "Lewis (UK)"],
];

const VOICE_INSTRUCTION =
  "The user is talking to you by voice and hears your replies read aloud. Keep replies short and conversational: " +
  "one to four spoken sentences. No markdown, headings, bullet lists, tables, emoji or code in the reply itself; " +
  "say numbers and symbols the way you would out loud. Still use your tools to actually do things. When you produce " +
  "code, files or long results, put them in files or the chat and say so in a sentence. Before a long task, say in a " +
  "few words what you are about to do.";

type Phase = "starting" | "listening" | "hearing" | "transcribing" | "thinking" | "speaking";

/** Markdown answer -> text worth saying aloud. */
export function toSpeech(md: string): string {
  return md
    .replace(/```[\s\S]*?(```|$)/g, " (the code is in the chat) ")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    .replace(/^\s*[-*+]\s+/gm, "")
    .replace(/^\s*\d+\.\s+/gm, "")
    .replace(/^\|.*\|$/gm, "")
    .replace(/[*_~>#|]/g, "")
    .replace(/https?:\/\/\S+/g, "the link")
    .replace(/[ \t]+/g, " ");
}

/**
 * Take the complete sentences of `text` after position `from`, grouped into chunks of 40+ characters
 * (fewer, more natural-sounding requests). When `final`, the unfinished tail is taken too.
 */
export function nextChunks(text: string, from: number, final: boolean): { chunks: string[]; upTo: number } {
  const chunks: string[] = [];
  let start = from; // start of the chunk being built
  let taken = from; // everything before this has been handed out
  const re = /[.!?…:;](?=\s|$)|\n+/g;
  re.lastIndex = from;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const end = m.index + m[0].length;
    if (!final && end === text.length) break; // the stream may still be inside this sentence
    if (text.slice(start, end).trim().length >= 40) {
      chunks.push(text.slice(start, end).trim());
      start = taken = end;
    }
  }
  // A long run with no sentence end (lists, code-ish text): break it at a space so speech keeps flowing.
  while (!final && text.length - start > 220) {
    const cut = text.lastIndexOf(" ", start + 200);
    if (cut <= start) break;
    chunks.push(text.slice(start, cut).trim());
    start = taken = cut;
  }
  if (final) {
    const rest = text.slice(start).trim();
    if (rest) chunks.push(rest);
    taken = text.length;
  }
  return { chunks, upTo: taken };
}

// iPhones only allow sound from an audio context unlocked inside the tap itself, so the mic
// button calls this before voice mode opens.
let primed: AudioContext | null = null;
export function primeVoiceAudio() {
  try {
    primed = new AudioContext();
    primed.resume();
    const b = primed.createBuffer(1, 1, 22050); // a silent blip finishes the unlock on iOS
    const src = primed.createBufferSource();
    src.buffer = b;
    src.connect(primed.destination);
    src.start();
  } catch {
    primed = null;
  }
}

/** Float32 audio at `rate` -> 16 kHz mono 16-bit WAV, which is what Whisper wants. */
export function toWav(chunks: Float32Array[], rate: number): Blob {
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const ratio = rate / 16000;
  const out = new Int16Array(Math.floor(total / ratio));
  let i = 0;
  let acc = 0;
  let cnt = 0;
  let next = ratio;
  let pos = 0;
  for (const c of chunks) {
    for (let k = 0; k < c.length; k++, pos++) {
      acc += c[k];
      cnt++;
      if (pos + 1 >= next && i < out.length) {
        out[i++] = Math.max(-1, Math.min(1, acc / cnt)) * 0x7fff;
        acc = 0;
        cnt = 0;
        next += ratio;
      }
    }
  }
  const buf = new ArrayBuffer(44 + out.length * 2);
  const v = new DataView(buf);
  const w = (o: number, s: string) => [...s].forEach((ch, j) => v.setUint8(o + j, ch.charCodeAt(0)));
  w(0, "RIFF"); v.setUint32(4, 36 + out.length * 2, true); w(8, "WAVE"); w(12, "fmt ");
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true); v.setUint32(24, 16000, true);
  v.setUint32(28, 32000, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true); w(36, "data"); v.setUint32(40, out.length * 2, true);
  new Int16Array(buf, 44).set(out);
  return new Blob([buf], { type: "audio/wav" });
}

const rms = (a: Float32Array) => {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * a[i];
  return Math.sqrt(s / a.length);
};

export function VoiceMode() {
  const voiceName = useStore((s) => s.voiceName) || "am_michael";
  const [phase, setPhase] = useState<Phase>("starting");
  const [muted, setMuted] = useState(false);
  const [heard, setHeard] = useState("");
  const [saying, setSaying] = useState("");
  const [error, setError] = useState("");
  const orb = useRef<HTMLDivElement>(null);

  // Everything the audio callbacks touch lives in one ref so they always see current values.
  const r = useRef({
    ctx: null as AudioContext | null,
    stream: null as MediaStream | null,
    phase: "starting" as Phase,
    muted: false,
    floor: 0.008,
    loud: 0,
    quiet: 0,
    capture: [] as Float32Array[],
    preroll: [] as Float32Array[],
    // speaking
    sid: null as string | null,
    msgId: "" as string,
    spokenUpTo: 0,
    /** Replies not to read aloud: everything before voice mode, and replies the person talked over. */
    skip: new Set<string>(),
    queue: [] as Promise<AudioBuffer | null>[],
    playing: null as AudioBufferSourceNode | null,
    outLevel: null as AnalyserNode | null,
    awaitingReply: false,
    instructed: new Set<string>(),
    closed: false,
    voice: voiceName,
  });
  r.current.voice = voiceName;
  const go = (p: Phase) => {
    r.current.phase = p;
    setPhase(p);
  };

  // ---- speaking -------------------------------------------------------------------------------
  const stopSpeaking = () => {
    const s = r.current;
    s.queue = [];
    try { s.playing?.stop(); } catch { /* already stopped */ }
    s.playing = null;
    setSaying("");
  };

  const say = (text: string) => {
    const s = r.current;
    const ctx = s.ctx!;
    const p = fetch(`/hq/voice/speak?voice=${encodeURIComponent(s.voice)}`, { method: "POST", body: text })
      .then((res) => (res.ok ? res.arrayBuffer() : Promise.reject(new Error(`speech failed (${res.status})`))))
      .then((b) => ctx.decodeAudioData(b))
      .catch((e) => (toast(e.message), null));
    (p as Promise<AudioBuffer | null> & { text?: string }).text = text;
    s.queue.push(p);
    if (!s.playing) playNext();
  };

  const playNext = async () => {
    const s = r.current;
    const item = s.queue[0] as (Promise<AudioBuffer | null> & { text?: string }) | undefined;
    if (!item) {
      s.playing = null;
      setSaying("");
      if (!s.awaitingReply && !s.closed && (s.phase === "speaking" || s.phase === "thinking")) go("listening");
      return;
    }
    const buf = await item;
    if (s.queue[0] !== item) return; // interrupted while it was being made
    s.queue.shift();
    if (!buf) return playNext();
    const src = s.ctx!.createBufferSource();
    src.buffer = buf;
    src.connect(s.outLevel!);
    s.playing = src;
    setSaying(item.text || "");
    if (s.phase !== "hearing") go("speaking");
    src.onended = () => {
      if (s.playing === src) playNext();
    };
    src.start();
  };

  // Follow the open chat's newest reply and speak new sentences as they arrive.
  useEffect(() => {
    let last = "";
    const tick = () => {
      const s = r.current;
      if (!s.sid || s.closed) return;
      const st = getState();
      const chat = st.chat[s.sid];
      if (!chat) return;
      const running = !!st.active[s.sid];
      const turns = buildTurns(chat.messages);
      const turn = turns[turns.length - 1];
      if (!turn) return;
      const v = viewTurn(turn, running);
      const msg = v.lastAssistant;
      if (!msg || s.skip.has(msg.id)) return;
      const sig = msg.id + ":" + v.answer.length + ":" + running;
      if (sig === last) return;
      last = sig;
      if (msg.id !== s.msgId) (s.msgId = msg.id), (s.spokenUpTo = 0);
      const text = toSpeech(v.answer);
      const done = !running || !!msg.time.completed;
      const { chunks, upTo } = nextChunks(text, s.spokenUpTo, done);
      s.spokenUpTo = upTo;
      chunks.forEach(say);
      if (!running) {
        s.awaitingReply = false;
        if (!s.playing && s.queue.length === 0 && (s.phase === "thinking" || s.phase === "speaking")) go("listening");
      }
    };
    const t = window.setInterval(tick, 120);
    return () => window.clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---- sending what was heard ------------------------------------------------------------------
  const handleUtterance = async (chunks: Float32Array[]) => {
    const s = r.current;
    go("transcribing");
    try {
      const res = await fetch("/hq/voice/transcribe", { method: "POST", body: toWav(chunks, s.ctx!.sampleRate) });
      const body = await res.json();
      if (!res.ok) throw new Error(body.message || "speech-to-text failed");
      const text = String(body.text || "").trim();
      // Whisper invents these from noise; ignore them.
      if (!text || /^(\[.*\]|\(.*\)|thank you\.?|thanks for watching!?|you)$/i.test(text)) return go(s.playing ? "speaking" : s.awaitingReply ? "thinking" : "listening");
      setHeard(text);
      const sid = await ensureSession();
      if (!sid) throw new Error("no chat open");
      if (s.sid !== sid) {
        // Only replies from now on are read aloud.
        for (const m of getState().chat[sid]?.messages || []) if (m.type === "assistant") s.skip.add(m.id);
        s.sid = sid;
      }
      const backend = getState().current!.space.backend;
      if (!s.instructed.has(sid)) {
        s.instructed.add(sid);
        await api.setInstruction(backend, sid, "hq-voice", VOICE_INSTRUCTION).catch(() => {});
      }
      s.awaitingReply = true;
      go("thinking");
      await sendPrompt(text);
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e));
      go("listening");
    }
  };

  // ---- microphone + voice activity detection ------------------------------------------------------
  useEffect(() => {
    const s = r.current;
    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
      setError(`Voice needs the secure address. Open ${location.hostname.endsWith(".ts.net") ? location.origin : "HQ through its https:// address (see Settings)"}.`);
      return;
    }
    let proc: ScriptProcessorNode | null = null;
    let raf = 0;
    (async () => {
      try {
        const ctx = primed && primed.state !== "closed" ? primed : new AudioContext();
        primed = null;
        s.ctx = ctx;
        await ctx.resume();
        const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
        if (s.closed) return stream.getTracks().forEach((t) => t.stop());
        s.stream = stream;
        const src = ctx.createMediaStreamSource(stream);
        const inLevel = ctx.createAnalyser();
        inLevel.fftSize = 512;
        src.connect(inLevel);
        s.outLevel = ctx.createAnalyser();
        s.outLevel.fftSize = 512;
        s.outLevel.connect(ctx.destination);
        proc = ctx.createScriptProcessor(2048, 1, 1);
        src.connect(proc);
        proc.connect(ctx.destination); // needed for onaudioprocess to fire; outputs silence
        const frameSec = 2048 / ctx.sampleRate;
        proc.onaudioprocess = (ev) => {
          const data = new Float32Array(ev.inputBuffer.getChannelData(0));
          if (s.muted || s.closed) return;
          const level = rms(data);
          const speakingOut = !!s.playing;
          // Echo cancellation is imperfect, so it takes a louder voice to interrupt a reply.
          const startAt = Math.max(0.015, s.floor * 3) * (speakingOut ? 2.5 : 1);
          const endAt = Math.max(0.01, s.floor * 2);
          if (s.phase !== "hearing") {
            s.preroll.push(data);
            // Keep the moments before speech is detected, so a short first word ("Stop.") isn't cut off.
            if (s.preroll.length * frameSec > 0.8) s.preroll.shift();
            if (level > startAt) s.loud++;
            else {
              s.loud = Math.max(0, s.loud - 1); // a short gap between words doesn't start over
              if (level < endAt) s.floor = s.floor * 0.97 + level * 0.03;
            }
            const needed = speakingOut ? 0.25 : 0.12;
            if (s.loud * frameSec >= needed && s.phase !== "transcribing" && s.phase !== "starting") {
              if (speakingOut) {
                stopSpeaking(); // barge-in: drop the rest of this reply
                s.skip.add(s.msgId);
              }
              s.capture = [...s.preroll];
              s.quiet = 0;
              go("hearing");
            }
            return;
          }
          s.capture.push(data);
          s.quiet = level < endAt ? s.quiet + 1 : 0;
          const length = s.capture.length * frameSec;
          if ((s.quiet * frameSec > 0.9 && length > 0.5) || length > 60) {
            const chunks = s.capture;
            s.capture = [];
            s.loud = 0;
            handleUtterance(chunks);
          }
        };
        const draw = () => {
          const a = s.playing ? s.outLevel! : inLevel;
          const buf = new Float32Array(a.fftSize);
          a.getFloatTimeDomainData(buf);
          const lvl = Math.min(1, rms(buf) * (s.playing ? 4 : 8));
          if (orb.current) orb.current.style.setProperty("--lvl", lvl.toFixed(3));
          raf = requestAnimationFrame(draw);
        };
        draw();
        go("listening");
      } catch (e) {
        setError(e instanceof Error && e.name === "NotAllowedError" ? "Microphone permission was refused." : `Could not start the microphone: ${e instanceof Error ? e.message : e}`);
      }
    })();
    return () => {
      s.closed = true;
      cancelAnimationFrame(raf);
      if (proc) proc.onaudioprocess = null;
      stopSpeaking();
      s.stream?.getTracks().forEach((t) => t.stop());
      s.ctx?.close().catch(() => {});
      const cur = getState().current;
      if (cur) s.instructed.forEach((sid) => api.removeInstruction(cur.space.backend, sid, "hq-voice").catch(() => {}));
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    r.current.muted = muted;
    if (muted && r.current.phase === "hearing") (r.current.capture = []), go("listening");
  }, [muted]);

  const label: Record<Phase, string> = {
    starting: "Starting…",
    listening: muted ? "Muted" : "Listening",
    hearing: "Listening…",
    transcribing: "Got it…",
    thinking: "Thinking…",
    speaking: "Speaking",
  };

  return (
    <div className="vm" role="dialog" aria-label="Voice conversation">
      <div className="vm-top">
        <select className="vm-voice" value={voiceName} onChange={(e) => setVoiceName(e.target.value)} aria-label="Voice">
          {VOICES.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
        </select>
        <button type="button" className="vm-btn small" onClick={() => setVoiceOpen(false)} aria-label="End voice conversation"><X size={20} /></button>
      </div>
      <div className="vm-center">
        {error ? (
          <div className="vm-error">{error}</div>
        ) : (
          <>
            <div ref={orb} className={"vm-orb " + phase + (muted ? " muted" : "")} />
            <div className="vm-state">{label[phase]}</div>
            {heard && <div className="vm-heard">“{heard}”</div>}
            {saying && <div className="vm-saying">{saying}</div>}
          </>
        )}
      </div>
      <div className="vm-bottom">
        <button type="button" className={"vm-btn" + (muted ? " off" : "")} onClick={() => setMuted(!muted)} aria-label={muted ? "Unmute" : "Mute"}>
          {muted ? <MicOff size={24} /> : <Mic size={24} />}
        </button>
        <button
          type="button"
          className="vm-btn"
          onClick={() => {
            stopSpeaking();
            r.current.skip.add(r.current.msgId);
            r.current.awaitingReply = false;
            stop();
            go("listening");
          }}
          aria-label="Stop"
          title="Stop talking and stop the work"
        >
          <Square size={20} fill="currentColor" />
        </button>
        <button type="button" className="vm-btn end" onClick={() => setVoiceOpen(false)} aria-label="End voice conversation"><X size={24} /></button>
      </div>
    </div>
  );
}
