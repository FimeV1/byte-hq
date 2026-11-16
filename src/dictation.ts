// Dictation: the mic button in the message box. Records until pressed again, then puts the words into the box.
// With HQ's voice server it uses the same speech-to-text as voice mode; without one, the browser's own speech
// recognition (Chrome, Edge and Safari send the audio to their maker for that), when the browser has it.
import { toWav } from "./VoiceMode";

type Rec = { stop: () => Promise<string>; cancel: () => void };

type SpeechRec = {
  lang: string; continuous: boolean; interimResults: boolean;
  onresult: ((e: { results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }> }) => void) | null;
  onerror: ((e: { error: string }) => void) | null;
  onend: (() => void) | null;
  start: () => void; stop: () => void; abort: () => void;
};
const BrowserSpeech = (window as unknown as { SpeechRecognition?: new () => SpeechRec; webkitSpeechRecognition?: new () => SpeechRec })
  .SpeechRecognition || (window as unknown as { webkitSpeechRecognition?: new () => SpeechRec }).webkitSpeechRecognition;

/** Can dictation work here at all? (The mic needs https or localhost.) */
export const canDictate = (hasVoiceServer: boolean) =>
  window.isSecureContext && ((hasVoiceServer && typeof navigator.mediaDevices?.getUserMedia === "function") || !!BrowserSpeech);

export async function startDictation(hasVoiceServer: boolean): Promise<Rec> {
  if (hasVoiceServer && typeof navigator.mediaDevices?.getUserMedia === "function") return recordForServer();
  if (BrowserSpeech) return browserRecognition();
  throw new Error("this browser can't take dictation here");
}

async function recordForServer(): Promise<Rec> {
  // The audio context is made and resumed while still inside the tap (before waiting for the mic), or iOS leaves it
  // paused and records silence.
  const ctx = new AudioContext();
  const resumed = ctx.resume();
  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
  } catch (e) {
    ctx.close().catch(() => {});
    throw new Error((e as Error).name === "NotAllowedError" ? "the microphone isn't allowed" : (e as Error).message);
  }
  await resumed;
  const src = ctx.createMediaStreamSource(stream);
  const proc = ctx.createScriptProcessor(4096, 1, 1);
  const chunks: Float32Array[] = [];
  proc.onaudioprocess = (ev) => void chunks.push(new Float32Array(ev.inputBuffer.getChannelData(0)));
  src.connect(proc);
  proc.connect(ctx.destination); // needed for onaudioprocess to fire; outputs silence
  const end = () => {
    proc.disconnect();
    src.disconnect();
    stream.getTracks().forEach((t) => t.stop());
    ctx.close().catch(() => {});
  };
  return {
    cancel: end,
    stop: async () => {
      const rate = ctx.sampleRate;
      end();
      if (chunks.reduce((n, c) => n + c.length, 0) < rate * 0.3) return ""; // under a third of a second: nothing said
      const r = await fetch("/hq/voice/transcribe", { method: "POST", body: toWav(chunks, rate) });
      if (!r.ok) throw new Error(`speech-to-text failed (${r.status})`);
      return String(((await r.json()) as { text?: string }).text || "").trim();
    },
  };
}

function browserRecognition(): Promise<Rec> {
  const rec = new BrowserSpeech!();
  rec.lang = navigator.language || "en-GB";
  rec.continuous = true;
  rec.interimResults = false;
  let text = "";
  let failed = "";
  let ended: () => void = () => {};
  const done = new Promise<void>((ok) => (ended = ok));
  rec.onresult = (e) => {
    text = Array.from(e.results).filter((r) => r.isFinal).map((r) => r[0].transcript).join(" ");
  };
  rec.onerror = (e) => void (failed = e.error === "not-allowed" ? "the microphone isn't allowed" : e.error === "no-speech" ? "" : e.error);
  rec.onend = () => ended();
  rec.start();
  return Promise.resolve({
    cancel: () => rec.abort(),
    stop: async () => {
      rec.stop();
      await Promise.race([done, new Promise((ok) => setTimeout(ok, 4000))]);
      if (failed) throw new Error(failed);
      return text.trim();
    },
  });
}
