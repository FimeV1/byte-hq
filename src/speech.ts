// Read an answer aloud. With HQ's voice server (the one voice conversation uses) it sounds the same as voice mode;
// without one, the browser's own speech does it, so the button works everywhere.
import { nextChunks, toSpeech } from "./VoiceMode";
import { getState, setState, toast } from "./store";

let stopCurrent: (() => void) | null = null;
let noServer = false; // HQ's voice server said no once: use the browser's speech from then on

export function stopSpeaking() {
  stopCurrent?.();
  stopCurrent = null;
  setState({ speaking: null });
}

/** Read `markdown` aloud; `key` marks which answer is playing (press again to stop). */
export async function readAloud(key: string, markdown: string) {
  if (getState().speaking === key) return stopSpeaking();
  stopSpeaking();
  const text = toSpeech(markdown).trim();
  if (!text) return;
  unlockPlayer(); // still inside the tap: iOS only lets audio play that was started from one
  const chunks = nextChunks(text, 0, true).chunks;
  setState({ speaking: key });
  let stopped = false;
  const done = () => !stopped && getState().speaking === key && setState({ speaking: null });
  const voice = getState().voiceName;
  if (voice && !noServer && (await serverSpeech(chunks, voice, () => stopped, (stop) => (stopCurrent = () => ((stopped = true), stop()))))) return done();
  if (stopped) return;
  if (!("speechSynthesis" in window)) {
    setState({ speaking: null });
    return toast("This browser can't read aloud");
  }
  stopCurrent = () => ((stopped = true), speechSynthesis.cancel());
  // One utterance per chunk: some browsers cut a long utterance off part-way.
  chunks.forEach((c, i) => {
    const u = new SpeechSynthesisUtterance(c);
    if (i === chunks.length - 1) u.onend = u.onerror = done;
    speechSynthesis.speak(u);
  });
}

// One audio element, started during the tap and reused for every chunk. iOS Safari refuses play() on audio created
// after an await (the network wait for the voice), so the first answer read on an iPhone stayed silent (2026-11-16).
let player: HTMLAudioElement | null = null;
const SILENCE = "data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAIA+AAACABAAZGF0YQAAAAA=";
function unlockPlayer() {
  try {
    player ||= new Audio();
    player.src = SILENCE;
    player.play().catch(() => {});
  } catch {
    player = null;
  }
}

/** Play the chunks through HQ's voice server, fetching the next while one plays. False if the server can't speak. */
async function serverSpeech(chunks: string[], voice: string, isStopped: () => boolean, onStop: (stop: () => void) => void): Promise<boolean> {
  const get = (t: string) =>
    fetch(`/hq/voice/speak?voice=${encodeURIComponent(voice)}`, { method: "POST", body: t }).then((r) => (r.ok ? r.blob() : Promise.reject(new Error(String(r.status)))));
  let next: Promise<Blob> | null = get(chunks[0]);
  for (let i = 0; i < chunks.length; i++) {
    let blob: Blob;
    try {
      blob = await next!;
    } catch {
      if (i === 0) noServer = true;
      return i > 0; // the first one failed: let the browser's speech do it instead
    }
    if (isStopped()) return true;
    next = i + 1 < chunks.length ? get(chunks[i + 1]) : null;
    next?.catch(() => {});
    const audio = player || new Audio();
    const url = URL.createObjectURL(blob);
    audio.src = url;
    onStop(() => audio.pause());
    await new Promise<void>((resolve) => {
      audio.onended = audio.onerror = () => resolve();
      audio.onpause = () => isStopped() && resolve();
      audio.play().catch((e) => {
        if ((e as Error).name === "NotAllowedError") toast("The browser blocked the sound: tap Read aloud again.", "info");
        resolve();
      });
    });
    URL.revokeObjectURL(url);
    if (isStopped()) return true;
  }
  return true;
}
