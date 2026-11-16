// Phone notifications for HQ (Web Push; on an iPhone, HQ must be added to the Home Screen first).
//
// They only ever carry a short fixed line ("Finished on the server", "Needs your answer"),
// never what was said, so nothing private lands on the lock screen. Tapping opens that chat.
//
// Keys and subscriptions live next to HQ's config (push.json, mode 600).
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const webpush = require("web-push");

export function createNotifier({ configDir, contact = "", log = console.log }) {
  const file = path.join(configDir, "push.json");
  const load = () => (fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : {});
  const store = (d) => {
    fs.writeFileSync(file + ".tmp", JSON.stringify(d, null, 2), { mode: 0o600 });
    fs.renameSync(file + ".tmp", file);
  };
  let data = load();
  if (!data.vapid) {
    data.vapid = webpush.generateVAPIDKeys();
    data.subs = [];
    store(data);
  }
  // Apple's push service rejects a sender address on a made-up domain ("mailto:hq@localhost" got 403
  // BadJwtToken on every send). Only the push services ever see this address.
  // Push services want a real contact address (Apple rejects made-up domains): config.push.contact, a mailto: or https: URL.
  if (!contact) log("push: set config.push.contact (e.g. \"mailto:you@example.com\"); Apple rejects notifications without a real one");
  webpush.setVapidDetails(contact || "mailto:hq@example.com", data.vapid.publicKey, data.vapid.privateKey);

  return {
    publicKey: data.vapid.publicKey,
    count: () => (data.subs || []).length,
    subscribe(sub) {
      if (!sub?.endpoint?.startsWith("https://") || !sub.keys) throw new Error("not a push subscription");
      data.subs = [...(data.subs || []).filter((s) => s.endpoint !== sub.endpoint), sub];
      store(data);
    },
    unsubscribe(endpoint) {
      data.subs = (data.subs || []).filter((s) => s.endpoint !== endpoint);
      store(data);
    },
    /** Send to every subscribed device. `url` is opened when the notification is tapped. */
    async send(title, body, url = "/", tag = undefined) {
      const payload = JSON.stringify({ title, body, url, tag });
      const dead = [];
      await Promise.all(
        (data.subs || []).map((s) =>
          webpush.sendNotification(s, payload, { TTL: 3600 }).catch((e) => {
            if (e.statusCode === 404 || e.statusCode === 410) dead.push(s.endpoint); // phone unsubscribed
            else log(`push failed: ${e.statusCode || ""} ${e.message}`);
          }),
        ),
      );
      if (dead.length) {
        data.subs = data.subs.filter((s) => !dead.includes(s.endpoint));
        store(data);
      }
    },
  };
}

/**
 * When to notify, from each machine's live events:
 *  - a chat needs an answer (permission or question): always;
 *  - a turn finished after at least 15 s (Auto chats that changed files are left to auto.mjs, which
 *    notifies once the review is done).
 */
export function watchForNotifications({ backends, notifier, isAutoReviewed, outsideEdits = async () => [], log = console.log }) {
  const started = new Map(); // session id -> when its turn started
  const onMachine = new Map(); // session id -> machine, for turns in progress
  const lastSeen = new Map(); // session id -> last event of any kind (streamed text, tool calls…)
  const warned = new Set(); // turns already reported as possibly stuck
  const STALL_MS = Number(process.env.HQ_STALL_MS) || 5 * 60_000; // HQ_STALL_MS: shorter, for testing on the dev stack
  const label = (b) => b.label || b.id;
  const link = (b, sid, dir) => `/?open=${encodeURIComponent(JSON.stringify({ backend: b.id, sid, dir }))}`;

  async function lastUserMessageTime(b, sid) {
    const auth = b.user ? { authorization: "Basic " + Buffer.from(`${b.user}:${b.password}`).toString("base64") } : {};
    const r = await fetch(`${b.url.replace(/\/$/, "")}/api/session/${sid}/message?limit=30`, { headers: auth, signal: AbortSignal.timeout(15000) });
    const msgs = (await r.json()).data || [];
    const u = msgs.find((m) => m.type === "user"); // newest first
    return u?.time?.created || 0;
  }

  async function sessionInfo(b, sid) {
    const auth = b.user ? { authorization: "Basic " + Buffer.from(`${b.user}:${b.password}`).toString("base64") } : {};
    const r = await fetch(`${b.url.replace(/\/$/, "")}/api/session/${sid}`, { headers: auth, signal: AbortSignal.timeout(15000) });
    return (await r.json()).data;
  }

  async function onEvent(b, ev) {
    const d = ev.data || {};
    const sid = d.sessionID ?? d.form?.sessionID;
    if (sid) lastSeen.set(sid, Date.now());
    if (!notifier.count()) return;
    if (/^session\.execution\./.test(ev.type)) log(`notify: ${b.id} ${ev.type} ${ev.data?.sessionID || ""}`);
    if (!sid) return;
    if (ev.type === "session.execution.started") return void (started.set(sid, Date.now()), onMachine.set(sid, b), warned.delete(sid));
    if (/^session\.execution\.(succeeded|failed|interrupted)$/.test(ev.type)) onMachine.delete(sid);
    const askedForAnswer = ev.type === "permission.asked" || ev.type === "form.created";
    const finished = ev.type === "session.execution.succeeded" || ev.type === "session.execution.failed";
    if (!askedForAnswer && !finished) return;
    const ses = await sessionInfo(b, sid).catch(() => null);
    if (!ses || ses.parentID) return; // review chats report through auto.mjs
    // Test chats (self-test, scripted checks) never reach the phone; their decisions are still logged.
    const testChat = !!ses.metadata?.hqNoNotify || /hq-selftest/.test(ses.location?.directory || "") || /self-test/i.test(ses.title || "");
    const url = link(b, sid, ses.location?.directory);
    if (askedForAnswer && testChat) return void log(`notify: ${sid} needs an answer (test chat, not sent)`);
    if (askedForAnswer) return notifier.send("HQ", `Needs your answer (${label(b)})`, url, `ask-${sid}`);
    // If the start was missed (HQ restarted mid-turn, the event stream reconnected), time the turn from its
    // last user message instead of treating it as instant: a missed start used to mean no notification at all.
    let t0 = started.get(sid);
    if (!t0) t0 = await lastUserMessageTime(b, sid).catch(() => 0);
    const took = t0 ? Date.now() - t0 : Infinity;
    started.delete(sid);
    if (took < 15_000) return void log(`notify: ${sid} finished after ${Math.round(took / 1000)} s, too quick to notify`);
    if (testChat) return void log(`notify: ${sid} ${ev.type === "session.execution.failed" ? "failed" : "finished"} after ${Math.round(took / 1000)} s (test chat, not sent)`);
    if (ev.type === "session.execution.failed") return notifier.send("HQ", `Stopped with an error (${label(b)})`, url, `done-${sid}`);
    // Auto chats that changed files, or are mid fix-round, are reported by auto.mjs after the review.
    if (ses.metadata?.hqFixRounds || (await isAutoReviewed(b, ses))) return void log(`notify: ${sid} finished; Auto reviews it and notifies after`);
    // Files changed outside the chat's folder aren't in its diff, so no review saw them: say so (a count only;
    // notifications never carry chat content).
    const outside = (await outsideEdits(b, ses)).length;
    const extra = outside ? ` · changed ${outside} file${outside > 1 ? "s" : ""} outside its folder (not reviewed)` : "";
    log(`notify: ${sid} finished after ${Math.round(took / 1000)} s, sending${extra}`);
    return notifier.send("HQ", `Finished on the ${label(b)}${extra}`, url, `done-${sid}`);
  }

  async function watch(b) {
    // Ends when the machine is removed in Settings; an edit aborts the stream so it reconnects with the new address.
    while (!b.removed) {
      const ctl = new AbortController();
      (b.watchers ||= new Set()).add(ctl);
      try {
        const auth = b.user ? { authorization: "Basic " + Buffer.from(`${b.user}:${b.password}`).toString("base64") } : {};
        const r = await fetch(b.url.replace(/\/$/, "") + "/api/event", { headers: auth, signal: ctl.signal });
        const reader = r.body.getReader();
        let buf = "";
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += Buffer.from(value).toString();
          let i;
          while ((i = buf.indexOf("\n\n")) >= 0) {
            const line = buf.slice(0, i).split("\n").find((l) => l.startsWith("data:"));
            buf = buf.slice(i + 2);
            if (!line) continue;
            try {
              onEvent(b, JSON.parse(line.slice(5))).catch((e) => log(`notify: ${e.message}`));
            } catch { /* not JSON */ }
          }
        }
      } catch { /* machine down: retry */ } finally {
        b.watchers.delete(ctl);
      }
      if (!b.removed) await new Promise((r) => setTimeout(r, 5000));
    }
  }
  // A turn with no events at all for 5 minutes is probably stuck (a model that stopped answering, a hung tool).
  // Say so once, so you aren't left waiting on a "Working…" that will never finish.
  setInterval(async () => {
    for (const [sid, b] of onMachine) {
      const quiet = Date.now() - (lastSeen.get(sid) || started.get(sid) || Date.now());
      if (quiet < STALL_MS || warned.has(sid) || !notifier.count()) continue;
      warned.add(sid);
      const ses = await sessionInfo(b, sid).catch(() => null);
      if (!ses || ses.parentID) continue;
      const test = !!ses.metadata?.hqNoNotify || /hq-selftest/.test(ses.location?.directory || "") || /self-test/i.test(ses.title || "");
      log(`notify: ${sid} quiet for ${Math.round(quiet / 60000)} min${test ? " (test chat, not sent)" : ", sending a stuck warning"}`);
      if (!test) notifier.send("HQ", `No progress for ${Math.round(quiet / 60000)} min: it may be stuck (${label(b)})`, link(b, sid, ses.location?.directory), `stuck-${sid}`);
    }
  }, 30_000);
  for (const b of backends.values()) watch(b);
  return { link, watch };
}
