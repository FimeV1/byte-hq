// Auto mode: HQ picks the model and reviews the work itself, so you never have to decide.
//
// How it chooses (settings in config.auto, see config.example.json):
//   - Worker AND reviewer: the PRIMARY model when it's available (healthy, and your optional busy check says the
//     machine isn't busy), otherwise the FALLBACK model.
//   - A fallback loaded only for a review can be unloaded straight after it (optional fallback.unload).
//   - Long chats are compacted before a primary turn once they pass compactAt tokens.
//   - Pictures: if the primary can't see images, an optional vision model describes them as text first.
//
// Runs in the HQ server (not the browser), so it keeps working when your phone is locked.
// A chat is in Auto mode when its OpenCode session metadata has hqAuto: true.
// For tests, config.auto.fakeState replaces the availability check with a fixed {up, busy, reason}.
import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { commitLine } from "./copies.mjs";

/**
 * Shrink a picture to 1600 px on its long side (JPEG) before a vision model reads it: a full-size phone screenshot
 * costs ~3x the vision tokens. Not below 1600 px: smaller images made models misread text. Uses macOS's sips;
 * on other systems (or if anything fails) the original picture is used.
 */
async function shrinkPicture(dataUri) {
  const m = /^data:(image\/[\w.+-]+);base64,(.*)$/s.exec(dataUri || "");
  if (!m || process.platform !== "darwin") return dataUri;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hq-pic-"));
  try {
    const src = path.join(dir, "in"), out = path.join(dir, "out.jpg");
    fs.writeFileSync(src, Buffer.from(m[2], "base64"));
    await new Promise((res, rej) => execFile("/usr/bin/sips", ["-Z", "1600", "-s", "format", "jpeg", "-s", "formatOptions", "85", src, "--out", out], { timeout: 20_000 }, (e) => (e ? rej(e) : res())));
    return "data:image/jpeg;base64," + fs.readFileSync(out).toString("base64");
  } catch {
    return dataUri;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const REVIEW_RULES = [
  { action: "*", resource: "*", effect: "deny" }, // in order: deny everything, then allow reading
  { action: "read", resource: "*", effect: "allow" },
  { action: "grep", resource: "*", effect: "allow" },
  { action: "glob", resource: "*", effect: "allow" },
];
const MAX_FIX_ROUNDS = 2;

export function createAuto({ config, backends, log = console.log, notify = null, testCopy = null }) {
  const A = {
    // { providerID, modelID, label, health?: url, start?: shell command, busyCheck?: shell command,
    //   images?: boolean (can it see pictures), llamaServerUrl?: url (cache save/restore around reviews) }
    primary: null,
    // { providerID, modelID, label, images?: boolean, unload?: { statusUrl, offUrl, token } }
    fallback: null,
    vision: null, // { url: Ollama-style /api/chat URL, model } — describes pictures for a primary that can't see them
    compactAt: 90_000,
    fakeState: null,
    ...(config.auto || {}),
  };
  const COMPACT_AT = A.compactAt;
  const PRIMARY = A.primary?.label || "the main model";
  const FALLBACK = A.fallback?.label || "the fallback model";

  // A machine answers 503 for a few seconds while it reloads a folder it hasn't used lately: retry.
  const call = async (b, method, p, body, tries = 4) => {
    for (let i = 1; ; i++) {
      try {
        return await call1(b, method, p, body);
      } catch (e) {
        if (i >= tries || !/-> 503 /.test(e.message)) throw e;
        await new Promise((r) => setTimeout(r, 1500 * i));
      }
    }
  };
  const call1 = async (b, method, p, body) => {
    const auth = b.user ? { authorization: "Basic " + Buffer.from(`${b.user}:${b.password}`).toString("base64") } : {};
    const r = await fetch(b.url.replace(/\/$/, "") + "/api" + p, {
      method,
      headers: { ...auth, ...(body ? { "content-type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(60_000),
    });
    const t = await r.text();
    if (!r.ok) throw new Error(`${method} ${p} -> ${r.status} ${t.slice(0, 160)}`);
    return t ? JSON.parse(t) : null;
  };
  const getMeta = async (b, sid) => (await call(b, "GET", `/session/${sid}`)).data.metadata || {};
  const setMeta = async (b, sid, patch) => call(b, "PATCH", `/session/${sid}`, { metadata: { ...(await getMeta(b, sid)), ...patch } });

  // ---- is the primary model available? -----------------------------------------------------------
  /** Run a shell command; resolves to its trimmed output, or null if it failed or timed out. */
  function sh(cmd, timeoutMs = 15_000) {
    return new Promise((resolve) => {
      const p = spawn(process.platform === "win32" ? "cmd" : "sh", process.platform === "win32" ? ["/c", cmd] : ["-c", cmd], { stdio: ["ignore", "pipe", "pipe"] });
      let out = "";
      p.stdout.on("data", (d) => (out += d));
      const t = setTimeout(() => p.kill(), timeoutMs);
      p.on("close", (code) => (clearTimeout(t), resolve(code === 0 ? out.trim() : null)));
      p.on("error", () => (clearTimeout(t), resolve(null)));
    });
  }
  const up = (u) => fetch(u, { signal: AbortSignal.timeout(2500) }).then((r) => r.ok).catch(() => false);

  // primary.busyCheck: any command (it may ssh to another machine). Exit 0 with output = busy, and the output is the
  // reason shown in HQ (e.g. the name of a running game). Exit 0 with no output = free. Failure = unreachable.
  let stateCache = { at: 0, v: null };
  async function primaryState() {
    if (A.fakeState) return A.fakeState;
    if (!A.primary) return { up: false, busy: false, reason: "no primary model is set" };
    if (stateCache.v && Date.now() - stateCache.at < 30_000) return stateCache.v;
    let busy = false, reason = "";
    if (A.primary.busyCheck) {
      const out = await sh(A.primary.busyCheck);
      if (out == null) {
        const v = { up: false, busy: false, reason: "its machine isn't answering" };
        stateCache = { at: Date.now(), v };
        return v;
      }
      busy = !!out;
      reason = out.split("\n")[0].slice(0, 60);
    }
    const v = { up: A.primary.health ? await up(A.primary.health) : true, busy, reason };
    stateCache = { at: Date.now(), v };
    return v;
  }

  /**
   * Start the primary model (primary.start) and wait for its health URL. A server that answers 503 while it loads
   * (llama.cpp's llama-server does) gets up to 4 minutes, since a first load from a cold disk can take more than 90 s;
   * one that never answers at all, 90 s. Falling back too early would send the job to the fallback model needlessly.
   */
  async function startPrimary() {
    if (A.fakeState) return !!A.fakeState.up;
    if (!A.primary?.start || !A.primary.health) return false;
    log(`auto: starting ${PRIMARY}`);
    if ((await sh(A.primary.start)) == null) return false;
    const t0 = Date.now();
    let loading = false;
    while (Date.now() - t0 < (loading ? 240_000 : 90_000)) {
      await new Promise((r) => setTimeout(r, 2000));
      const code = await fetch(A.primary.health, { signal: AbortSignal.timeout(2500) }).then((r) => r.status).catch(() => 0);
      if (code === 200) {
        stateCache.at = 0;
        log(`auto: ${PRIMARY} ready after ${Math.round((Date.now() - t0) / 1000)} s`);
        return true;
      }
      if (code === 503 && !loading) (loading = true), log(`auto: ${PRIMARY} is loading`);
    }
    log(`auto: ${PRIMARY} not ready after ${Math.round((Date.now() - t0) / 1000)} s${loading ? " (still loading)" : " (no answer)"}`);
    return false;
  }

  /** Text descriptions of pictures from the vision model (config.auto.vision), for a primary that can't see images. */
  async function describePictures(pictures) {
    if (!A.vision?.url || !A.vision?.model) throw new Error("no vision model is set");
    const prompt =
      "A coding assistant can't see this picture. In under 250 words: say what it shows (app, screen, file), then list the " +
      "text that matters exactly as written (titles, selected items, messages, errors, code), say how things differ in colour, " +
      "brightness or size where it shows, and point out anything highlighted, circled or visibly wrong. Describe only: don't judge, answer or comment on any request in it. No preamble.";
    const out = [];
    for (const [i, f] of pictures.entries()) {
      const small = await shrinkPicture(f.uri);
      const r = await fetch(A.vision.url, {
        method: "POST", headers: { "content-type": "application/json" }, signal: AbortSignal.timeout(60_000),
        body: JSON.stringify({
          model: A.vision.model, stream: false, think: false, options: { temperature: 0.2, num_predict: 500 },
          messages: [{ role: "user", content: prompt, images: [small.slice(small.indexOf(",") + 1)] }],
        }),
      });
      if (!r.ok) throw new Error(`vision model ${r.status}`);
      const t = (await r.json()).message?.content?.trim();
      if (!t) throw new Error("vision model returned nothing");
      out.push(pictures.length > 1 ? `Picture ${i + 1}${f.name ? ` (${f.name})` : ""}:\n${t}` : t);
    }
    return out.join("\n\n");
  }

  /** The model for work and reviews: {ref, role, label, why}, or null if neither is set or available. */
  async function pickModel(b, { start = true, images = false } = {}) {
    const models = (await call(b, "GET", `/model?location[directory]=${encodeURIComponent(b.chatsDir || b.home || "/")}`)).data;
    const find = (m) => m && models.find((x) => x.providerID === m.providerID && x.id === m.modelID);
    const primary = find(A.primary), fallback = find(A.fallback);
    const fb = (why) => (fallback ? { ref: { id: fallback.id, providerID: fallback.providerID }, role: "fallback", label: FALLBACK, why } : null);
    // A picture the primary can't see goes to a fallback that can.
    if (images && A.primary?.images === false && A.fallback?.images) return fb(`the message has a picture (${PRIMARY} can't see images)`);
    const s = await primaryState();
    if (primary && !s.busy && (s.up || (start && (await startPrimary())))) {
      return { ref: { id: primary.id, providerID: primary.providerID }, role: "primary", label: PRIMARY, why: "it's available" };
    }
    const why = !primary ? `${PRIMARY} isn't set up on this machine` : s.busy ? `its machine is busy${s.reason ? ` (${s.reason})` : ""}` : s.reason || `${PRIMARY} isn't running`;
    return fb(why) || (primary ? { ref: { id: primary.id, providerID: primary.providerID }, role: "primary", label: PRIMARY, why: "no fallback is set" } : null);
  }

  // ---- reviews --------------------------------------------------------------------------------
  function reviewPrompt(request, files, forCopy = false) {
    let diff = files.map((f) => `### ${f.file} (+${f.additions} -${f.deletions}, ${f.status})\n${f.patch}`).join("\n\n");
    if (diff.length > 60000) diff = diff.slice(0, 60000) + "\n\n[diff cut at 60,000 characters]";
    return [
      "You are reviewing a code change that another assistant made. You have not seen its conversation or reasoning, only the request and the result.",
      "", `The request it was given:\n"""\n${request.slice(0, 4000)}\n"""`, "", "The change (unified diff):", "```diff", diff, "```", "",
      "You can read and search the project's files to check surrounding code; you cannot change anything.",
      "Report only what matters: bugs, regressions, missed cases, things that don't do what was asked, and risks for a live system.",
      "For each: the file and line, what is wrong, why, and the fix. Skip style nitpicks. Under 300 words.",
      // The copy is committed to the live project as one git commit, and the chat title is often stale by
      // then, so the reviewer — which has just read the request and the whole diff —
      // writes the commit subject.
      ...(forCopy
        ? ["Write exactly one line starting with `COMMIT: ` — at most 72 characters, in the imperative, describing what THIS change does (not the request and not the review). Plain words only: no quotes, backticks, dollar signs or trailing punctuation."]
        : []),
      "End with exactly one line: `VERDICT: OK` if nothing needs changing, or `VERDICT: FIX` if something must be fixed.",
    ].join("\n");
  }

  const waitIdle = async (b, sid, maxMs = 20 * 60_000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < maxMs) {
      await new Promise((r) => setTimeout(r, 3000));
      if (!(await call(b, "GET", "/session/active")).data[sid]) return true;
    }
    return false;
  };
  const lastText = (msgs) => {
    for (let i = msgs.length - 1; i >= 0; i--) {
      const m = msgs[i];
      if (m.type !== "assistant") continue;
      const t = m.content.filter((p) => p.type === "text").map((p) => p.text).join("\n").trim();
      if (t) return t;
    }
    return "";
  };

  async function fallbackStatus() {
    const u = A.fallback?.unload;
    if (!u?.statusUrl) return null;
    return fetch(u.statusUrl, { signal: AbortSignal.timeout(5000) }).then((r) => r.json()).catch(() => ({ active: true }));
  }
  /** Unload the fallback model if it was loaded only for this review (fallback.unload: statusUrl, offUrl, token). */
  async function unloadFallbackIfOnlyForReview(before) {
    const u = A.fallback?.unload;
    if (!u?.offUrl || !before || before.active) return; // not configured, or it was already loaded for something else
    const st = await fallbackStatus();
    if (!st?.active || st.running_jobs) return;
    await fetch(u.offUrl, { method: "POST", headers: u.token ? { "x-token": u.token } : {}, signal: AbortSignal.timeout(60_000) }).catch(() => {});
    log(`auto: ${FALLBACK} unloaded after the review`);
  }

  // A llama-server primary holds one conversation's cache at a time, so a review on it would throw away the worker's
  // cache. Started with --slot-save-path, llama-server can save the cache to disk and load it back: do that around
  // the review (only when primary.llamaServerUrl is set).
  async function slot(action) {
    if (A.fakeState || !A.primary?.llamaServerUrl) return false;
    try {
      const r = await fetch(`${A.primary.llamaServerUrl.replace(/\/$/, "")}/slots/0?action=${action}`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ filename: "hq-worker.bin" }), signal: AbortSignal.timeout(120_000),
      });
      if (!r.ok) return log(`auto: worker cache ${action} not available (${r.status})`), false;
      const j = await r.json().catch(() => ({}));
      log(`auto: worker cache ${action}d (${j.n_saved ?? j.n_restored ?? "?"} tokens)`);
      return true;
    } catch (e) {
      return log(`auto: worker cache ${action} failed: ${e.message}`), false;
    }
  }

  /** Review one turn's changes in a read-only child chat, with the same model choice as the work. */
  async function reviewTurn(b, ses, turnId, request, files, whole = false) {
    const pick = await pickModel(b);
    if (!pick) return log(`auto ${ses.id}: no reviewer available`), null;
    const saved = pick.role === "primary" ? await slot("save") : false;
    const fallbackBefore = pick.role === "fallback" ? await fallbackStatus() : null;
    const child = (await call(b, "POST", "/session", {
      location: ses.location, parentID: ses.id, model: pick.ref, permissions: REVIEW_RULES,
      title: `Review: ${request.slice(0, 60)}`, metadata: { hqReview: true, turn: turnId, label: pick.label },
    })).data;
    log(`auto ${ses.id}: reviewing with ${pick.label} (${pick.why})`);
    const isCopy = !!ses.metadata?.hqCopy?.worktree;
    await call(b, "POST", `/session/${child.id}/prompt`, { text: reviewPrompt(request, files, isCopy) });
    await waitIdle(b, child.id);
    const review = lastText((await call(b, "GET", `/session/${child.id}/message?limit=50`)).data.reverse());
    // Commit subject for a copy: one line per reviewed turn, kept in the chat's metadata so Apply can use it.
    // The same turn can be reviewed twice (Auto and the review card), so keep the first. Saved straight after
    // the review is read: Apply only waits while the review chat is active, so a later save could miss it.
    if (isCopy) {
      const m = /^COMMIT:\s*(.+?)\s*$/im.exec(review || "");
      const line = m ? commitLine(m[1]) : "";
      if (line) {
        try {
          const meta = await getMeta(b, ses.id);
          const list = Array.isArray(meta.hqCommitLines) ? meta.hqCommitLines : [];
          // A whole-copy review replaces earlier lines for the same turn: it has seen everything since.
          if (whole) await setMeta(b, ses.id, { hqCommitLines: [...list.filter((x) => !(x && x.turn === turnId)), { turn: turnId, line, whole: true }] });
          else if (!list.some((x) => x && x.turn === turnId)) await setMeta(b, ses.id, { hqCommitLines: [...list, { turn: turnId, line }] });
        } catch (e) { log(`auto ${ses.id}: could not save COMMIT line: ${e.message}`); }
      } else {
        log(`auto ${ses.id}: reviewer gave no COMMIT line; Apply will fall back to the chat title`);
      }
    }
    if (saved) await slot("restore"); // the worker continues from its own cache
    await unloadFallbackIfOnlyForReview(fallbackBefore);
    return { pick, review };
  }

  const busy = new Set(); // chats Auto is reviewing right now

  /** Tokens in the chat's context now: the last measured step, or 0 when a compaction came after it (newest first). */
  async function contextNow(b, sid) {
    const msgs = (await call(b, "GET", `/session/${sid}/message?limit=30`)).data;
    const i = msgs.findIndex((m) => (m.type === "assistant" && m.tokens) || m.type === "compaction");
    const last = i >= 0 && msgs[i].type === "assistant" ? msgs[i] : null;
    return last ? last.tokens.input + (last.tokens.cache?.read || 0) + last.tokens.output : 0;
  }
  /** Compact with the chat's CURRENT model and wait for it. Throws if it fails. */
  async function compactAndWait(b, sid) {
    const older = (await call(b, "GET", `/session/${sid}/message?limit=30`)).data.find((m) => m.type === "compaction")?.id;
    await call(b, "POST", `/session/${sid}/compact`, {});
    for (let i = 0; i < 72; i++) {
      await new Promise((r) => setTimeout(r, 5000));
      const c = (await call(b, "GET", `/session/${sid}/message?limit=30`)).data.find((m) => m.type === "compaction" && m.id !== older);
      if (c?.status === "failed") throw new Error(`compaction failed: ${c.error?.message || "no reason given"}`);
      if (c?.status === "completed") return;
    }
    throw new Error("compaction didn't finish within 6 minutes");
  }
  const contextLimit = async (b, ref) => {
    if (!ref) return 0;
    const models = (await call(b, "GET", `/model?location[directory]=${encodeURIComponent(b.chatsDir || b.home || "/")}`)).data;
    return models.find((m) => m.id === ref.id && m.providerID === ref.providerID)?.limit?.context || 0;
  };

  /**
   * One long turn can still outgrow the model's window: Auto compacts before sending a message, not during a turn. When
   * an Auto chat's step fails with nothing written and the previous step held over 85% of that model's context, compact
   * and carry on, at most once per chat in 10 minutes (a chat that keeps failing for another reason is left to you).
   */
  const recovered = new Map();
  async function recoverFull(b, sid) {
    try {
      if (Date.now() - (recovered.get(sid) || 0) < 600_000) return;
      const ses = (await call(b, "GET", `/session/${sid}`)).data;
      if (!ses.metadata?.hqAuto) return;
      const msgs = (await call(b, "GET", `/session/${sid}/message?limit=10`)).data; // newest first
      const failed = msgs.find((m) => m.type === "assistant");
      const wrote = failed?.content?.some((p) => p.type === "tool" || ((p.type === "text" || p.type === "reasoning") && p.text?.trim()));
      if (!failed?.error || failed.error.type === "aborted" || wrote) return;
      const prev = msgs.find((m) => m.type === "assistant" && m !== failed && m.tokens);
      const ctx = prev ? prev.tokens.input + (prev.tokens.cache?.read || 0) + prev.tokens.output : 0;
      const limit = await contextLimit(b, failed.model);
      if (!limit || ctx < limit * 0.85) return;
      recovered.set(sid, Date.now());
      log(`auto ${sid}: a step failed at ${ctx} of ${limit} tokens (${failed.error.message}): compacting, then carrying on`);
      try {
        await compactAndWait(b, sid);
      } catch (e) {
        return log(`auto ${sid}: ${e.message}; leaving it to you`);
      }
      await routeAndSend(b, sid, "The chat ran out of room partway through your last step, so it was compacted. Carry on from where " +
        "you were: check the current state (git status, the files you were changing) rather than relying on memory, and read only what you need.", true);
    } catch (e) {
      log(`auto ${sid}: recovering a full chat failed: ${e.message}`);
    }
  }

  /**
   * A copy chat is applied as ONE commit of everything in the copy, so its review covers the whole copy (the copy
   * folder against the commit it started from, new files included), with the first request and later messages.
   * Returns null for a chat that isn't a live copy: those keep reviewing the last turn.
   */
  async function wholeCopyScope(b, ses) {
    const c = ses.metadata?.hqCopy;
    if (!c?.worktree || c.applied || c.discarded) return null;
    const msgs = (await call(b, "GET", `/session/${ses.id}/message?limit=200`)).data.reverse(); // oldest first
    const users = msgs.filter((m) => m.type === "user" && !m.pending && (m.text || "").trim());
    if (!users.length) return null;
    const files = (await call(b, "GET", `/vcs/diff?mode=working&untracked=files&context=3&location[directory]=${encodeURIComponent(c.worktree)}`)).data;
    const later = users.slice(1).slice(-5).map((m) => "- " + m.text.trim().replace(/\s+/g, " ").slice(0, 400));
    const request = users[0].text.trim().slice(0, 2600) +
      (later.length ? `\n\n(Later messages in the same chat${users.length > 6 ? ", the last five" : ""}:)\n${later.join("\n")}` : "") +
      "\n\n(The change below is the WHOLE copy so far, which is what gets applied as one commit.)";
    return { files, request };
  }

  async function afterTurn(b, sid) {
    if (busy.has(sid)) return;
    busy.add(sid);
    try {
      const ses = (await call(b, "GET", `/session/${sid}`)).data;
      const meta = ses.metadata || {};
      if (!meta.hqAuto || ses.parentID) return;
      // A copy that's already applied or discarded has no folder left: nothing to review or fix (2026-11-15: a review
      // still running at Apply saw its copy vanish, and Auto sent the model a fix round for a copy that no longer existed).
      if (meta.hqCopy?.applied || meta.hqCopy?.discarded) return;
      const msgs = (await call(b, "GET", `/session/${sid}/message?limit=200`)).data.reverse();
      const lastIdle = [...msgs].reverse().find((m) => m.type === "idle");
      if (lastIdle?.outcome !== "succeeded") return;
      // The turn that just ended starts at the first prompt after the previous idle marker.
      let start = null;
      for (let i = msgs.length - 1, seenIdle = false; i >= 0; i--) {
        if (msgs[i].type === "idle") {
          if (seenIdle) break;
          seenIdle = true;
        } else if (msgs[i].type === "user") start = msgs[i];
      }
      if (!start || meta.hqReviewed === start.id) return;
      const files = (await call(b, "GET", `/session/${sid}/diff?from=${start.id}&context=3`)).data;
      if (!files.length) {
        // A fix round that changed nothing (the model disagreed, or explained instead): the job is done.
        if (meta.hqFixRounds) {
          await setMeta(b, sid, { hqFixRounds: 0, hqReviewed: start.id });
          if (notify) notify(b, sid, ses, `Finished on the ${b.label || b.id} · after the review`);
        }
        return;
      }
      await setMeta(b, sid, { hqReviewed: start.id });

      // Working on a copy: the tests must pass in the copy before anything else.
      if (testCopy && meta.hqCopy && !meta.hqCopy.applied && !meta.hqCopy.discarded) {
        const t = await testCopy(b, sid).catch((e) => ({ ok: false, summary: `couldn't run the tests: ${e.message}`, steps: [] }));
        log(`auto ${sid}: tests in the copy ${t.ok ? "passed" : "FAILED"} (${t.summary})`);
        const rounds = Number(meta.hqFixRounds || 0);
        if (!t.ok) {
          if (rounds < MAX_FIX_ROUNDS) {
            await setMeta(b, sid, { hqFixRounds: rounds + 1, hqReviewed: null });
            const failed = (t.steps || []).filter((s) => s.exit !== 0).map((s) => `### ${s.name} (exit ${s.exit})\n\`\`\`\n${s.output.slice(-2500)}\n\`\`\``).join("\n\n");
            await routeAndSend(b, sid, `The tests failed in the copy:\n\n${failed || t.summary}\n\nFix the code so they pass. Don't change or skip the tests themselves.`, true);
          } else if (notify) notify(b, sid, ses, `Finished on the ${b.label || b.id} · tests still failing`);
          return;
        }
      }

      const whole = await wholeCopyScope(b, ses).catch((e) => (log(`auto ${sid}: whole-copy review scope failed, reviewing the turn: ${e.message}`), null));
      const r = whole?.files.length
        ? await reviewTurn(b, ses, start.id, whole.request, whole.files, true)
        : await reviewTurn(b, ses, start.id, String(meta.hqAutoRequest || start.text || ""), files);
      if (!r) return;
      const { pick, review } = r;
      const where = b.label || b.id;

      const rounds = Number(meta.hqFixRounds || 0);
      const fix = /VERDICT:\s*FIX/i.test(review);
      if (notify && !(fix && rounds < MAX_FIX_ROUNDS)) {
        // One notification per job, when it's really done (not between fix rounds).
        const outside = (await api.outsideEdits(b, ses).catch(() => [])).length;
        const note = outside ? ` · ${outside} file${outside > 1 ? "s" : ""} outside its folder not reviewed` : "";
        notify(b, sid, ses, (fix ? `Finished on the ${where} · the review still found problems` : `Finished on the ${where} · review looks good`) + note);
      }
      // Applied or discarded while the review ran: don't send a fix round into a copy that's gone.
      const nowCopy = (await call(b, "GET", `/session/${sid}`)).data.metadata?.hqCopy;
      if (fix && (nowCopy?.applied || nowCopy?.discarded)) {
        log(`auto ${sid}: review found problems, but the copy was already ${nowCopy.applied ? "applied" : "discarded"}; no fix round`);
        return;
      }
      if (fix && rounds < MAX_FIX_ROUNDS) {
        await setMeta(b, sid, { hqFixRounds: rounds + 1 });
        const findings = review.replace(/^.*VERDICT:.*$/im, "").trim();
        await routeAndSend(b, sid, `${pick.label} independently reviewed your last changes and reported:\n\n${findings}\n\nFix the real problems it found. If you disagree with a point, say why instead of changing the code.`, true);
      } else if (rounds) {
        await setMeta(b, sid, { hqFixRounds: 0 });
      }
    } catch (e) {
      log(`auto ${sid}: ${e.message}`);
    } finally {
      busy.delete(sid);
    }
  }

  /** Pick the model, compact if the primary would be swamped, then send. */
  async function routeAndSend(b, sid, text, isFix = false, files = undefined) {
    const isImage = (f) => /^data:image\//.test(f.uri || "") || /\.(png|jpe?g|gif|webp|heic)$/i.test(f.name || "");
    const pictures = (files || []).filter(isImage);
    // A real picture earlier in the chat is re-sent with every later message, so a primary that can't see images can't
    // take the chat any more.
    const hist = (await call(b, "GET", `/session/${sid}/message?limit=200`).catch(() => ({ data: [] }))).data;
    const pictureInHistory = hist.some((m) => m.type === "user" && (m.files || []).some((f) => /^image\//.test(f.mime || "")));
    let pick = await pickModel(b, { images: pictureInHistory });
    if (!pick) throw new Error("no model can answer: set config.auto.primary / fallback, and check they're running");
    if (pictures.length && pick.role === "primary" && A.primary?.images === false) {
      // The primary can't see images: the vision model describes them and the primary gets the text instead. If that
      // fails, the primary works from the user's words alone (it can usually tell what's meant).
      const described = await describePictures(pictures).catch((e) => (log(`auto ${sid}: describing the picture failed: ${e.message}`), null));
      const n = pictures.length;
      text += described
        ? `\n\n[${n > 1 ? `${n} pictures were` : "A picture was"} attached. You can't see images, so a vision model described ${n > 1 ? "them" : "it"}:]\n${described}`
        : `\n\n[${n > 1 ? `${n} pictures were` : "A picture was"} attached but couldn't be described (no vision model available). Work from the text; ask if you need to know what ${n > 1 ? "they show" : "it shows"}.]`;
      files = (files || []).filter((f) => !isImage(f));
      pick = { ...pick, why: `${pick.why} · ${described ? "picture described by the vision model" : "picture left out (no vision model)"}` };
    }
    if (pick.role === "primary") {
      // A compaction newer than the last measured step means that count is out of date: contextNow returns 0 then.
      const ctx = await contextNow(b, sid);
      if (ctx > COMPACT_AT) {
        log(`auto ${sid}: ${ctx} tokens in context, compacting before the ${PRIMARY} turn`);
        await call(b, "POST", `/session/${sid}/compact`, {});
      }
    }
    await call(b, "POST", `/session/${sid}/model`, { model: pick.ref });
    if (!isFix) await setMeta(b, sid, { hqAuto: true, hqFixRounds: 0, hqAutoRequest: text.slice(0, 4000) });
    await call(b, "POST", `/session/${sid}/prompt`, { text, ...(files?.length ? { files } : {}) });
    return pick;
  }

  // ---- watch every machine for finished turns ---------------------------------------------------
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
              const ev = JSON.parse(line.slice(5));
              if (ev.type === "session.execution.succeeded") afterTurn(b, ev.data.sessionID);
              else if (ev.type === "session.execution.failed") recoverFull(b, ev.data.sessionID);
            } catch { /* not JSON */ }
          }
        }
      } catch { /* server down: retry */ } finally {
        b.watchers.delete(ctl);
      }
      if (!b.removed) await new Promise((r) => setTimeout(r, 5000));
    }
  }
  for (const b of backends.values()) watch(b);

  const api = {
    /** True when Auto will review this chat's last turn (so the notifier leaves it to Auto). */
    /**
     * Files the latest turn changed OUTSIDE the chat's folder with the edit/write tools (only possible after you said
     * yes to external_directory). OpenCode's diff — and so the review — can't see them, so they are named.
     */
    async outsideEdits(b, ses) {
      const dir = (ses.location?.directory || "").replace(/[\\/]+$/, "");
      const msgs = (await call(b, "GET", `/session/${ses.id}/message?limit=200`)).data.reverse();
      let i = msgs.length - 1;
      if (msgs[i]?.type === "idle") i--; // the marker that ended this turn
      const out = new Set();
      for (; i >= 0 && msgs[i].type !== "idle"; i--) {
        if (msgs[i].type !== "assistant") continue;
        for (const p of msgs[i].content || []) {
          if (p.type !== "tool" || !/^(edit|write|patch|multiedit|apply_patch)$/.test(p.name || "")) continue;
          const f = p.state?.input?.path || p.state?.input?.filePath || p.state?.input?.file_path;
          if (typeof f === "string" && /^([\\/]|[A-Za-z]:)/.test(f) && !f.startsWith(dir + "/") && !f.startsWith(dir + "\\")) out.add(f);
        }
      }
      return [...out];
    },

    async willReview(b, ses) {
      if (!ses.metadata?.hqAuto) return false;
      const msgs = (await call(b, "GET", `/session/${ses.id}/message?limit=200`)).data.reverse();
      let start = null;
      for (let i = msgs.length - 1, seenIdle = false; i >= 0; i--) {
        if (msgs[i].type === "idle") {
          if (seenIdle) break;
          seenIdle = true;
        } else if (msgs[i].type === "user") start = msgs[i];
      }
      if (!start) return false;
      return (await call(b, "GET", `/session/${ses.id}/diff?from=${start.id}`)).data.length > 0;
    },
    /** Pick the model and send the message (used for every message in an Auto chat). */
    async send(backendId, sid, text, files) {
      const b = backends.get(backendId);
      if (!b) throw new Error("unknown machine");
      const pick = await routeAndSend(b, sid, text, false, files);
      return { label: pick.label, why: pick.why };
    },
    /**
     * Switch a chat to another model (picked by hand). When the chat already holds more than 80% of the new model's
     * context, compact it FIRST with the current model, which can still read all of it, so the next step fits.
     */
    async switchModel(backendId, sid, ref) {
      const b = backends.get(backendId);
      if (!b) throw new Error("unknown machine");
      const limit = await contextLimit(b, ref);
      const ctx = await contextNow(b, sid);
      let compacted = false;
      if (limit && ctx > limit * 0.8) {
        log(`switch ${sid}: ${ctx} tokens won't fit ${ref.providerID}/${ref.id} (${limit}): compacting with the current model first`);
        await compactAndWait(b, sid);
        compacted = true;
      }
      await call(b, "POST", `/session/${sid}/model`, { model: ref });
      return { compacted, ctx, limit };
    },
    /** Review one turn now (the review card's Yes), without the automatic fix round. */
    async review(backendId, sid, turnId) {
      const b = backends.get(backendId);
      if (!b) throw new Error("unknown machine");
      const ses = (await call(b, "GET", `/session/${sid}`)).data;
      const whole = await wholeCopyScope(b, ses).catch(() => null);
      if (whole?.files.length) {
        reviewTurn(b, ses, turnId, whole.request, whole.files, true).catch((e) => log(`review ${sid}: ${e.message}`));
        return { ok: true, whole: true };
      }
      const msgs = (await call(b, "GET", `/session/${sid}/message?limit=200`)).data;
      const request = msgs.find((m) => m.id === turnId)?.text || "";
      const files = (await call(b, "GET", `/session/${sid}/diff?from=${turnId}&context=3`)).data;
      if (!files.length) throw new Error("that turn changed no files");
      reviewTurn(b, ses, turnId, request, files).catch((e) => log(`review ${sid}: ${e.message}`)); // runs in the background
      return { ok: true };
    },
    /** What Auto would use right now (never starts anything). */
    async status(backendId) {
      const b = backends.get(backendId);
      if (!b) throw new Error("unknown machine");
      const p = await pickModel(b, { start: false }).catch(() => null);
      return { primary: await primaryState(), next: p && { label: p.label, why: p.why } };
    },
    /** Start watching a machine added while HQ runs (Settings › Servers). */
    watch,
  };
  return api;
}
