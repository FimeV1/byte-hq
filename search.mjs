// Search across every chat on every machine: titles and what was said (not tool output).
// The HQ server keeps an in-memory index of each chat's text, refreshed when a chat changes.

export function createSearch({ backends, log = console.log }) {
  const index = new Map(); // "backend|sid" -> { updated, title, dir, text }

  const call = async (b, p) => {
    const auth = b.user ? { authorization: "Basic " + Buffer.from(`${b.user}:${b.password}`).toString("base64") } : {};
    const r = await fetch(b.url.replace(/\/$/, "") + "/api" + p, { headers: auth, signal: AbortSignal.timeout(20_000) });
    if (!r.ok) throw new Error(`${p} -> ${r.status}`);
    return r.json();
  };

  function chatText(msgs) {
    const out = [];
    for (const m of msgs) {
      if (m.type === "user" && m.text) out.push(m.text);
      if (m.type === "assistant") for (const p of m.content || []) if (p.type === "text" && p.text) out.push(p.text);
    }
    return out.join("\n");
  }

  async function refresh(b) {
    const list = (await call(b, "/session?limit=300")).data.filter((s) => !s.parentID && !s.time.archived);
    const seen = new Set();
    const stale = [];
    for (const s of list) {
      const key = `${b.id}|${s.id}`;
      seen.add(key);
      const have = index.get(key);
      if (!have || have.updated !== s.time.updated) stale.push(s);
      else have.title = s.title || "";
    }
    for (const k of index.keys()) if (k.startsWith(b.id + "|") && !seen.has(k)) index.delete(k); // deleted chats
    // A few at a time, so a first search doesn't flood a machine.
    for (let i = 0; i < stale.length; i += 6) {
      await Promise.all(stale.slice(i, i + 6).map(async (s) => {
        try {
          const msgs = (await call(b, `/session/${s.id}/message?limit=200`)).data.reverse();
          index.set(`${b.id}|${s.id}`, { updated: s.time.updated, title: s.title || "", dir: s.location?.directory, text: chatText(msgs) });
        } catch { /* try again next search */ }
      }));
    }
  }

  function snippet(text, words) {
    const low = text.toLowerCase();
    const at = Math.min(...words.map((w) => low.indexOf(w)).filter((i) => i >= 0));
    if (!isFinite(at)) return text.slice(0, 140);
    const start = Math.max(0, at - 60);
    return (start ? "…" : "") + text.slice(start, at + 100).replace(/\s+/g, " ").trim() + (at + 100 < text.length ? "…" : "");
  }

  return {
    async search(q) {
      const words = String(q || "").toLowerCase().split(/\s+/).filter((w) => w.length > 1).slice(0, 8);
      if (!words.length) return [];
      await Promise.all([...backends.values()].map((b) => refresh(b).catch((e) => log(`search ${b.id}: ${e.message}`))));
      const hits = [];
      for (const [key, c] of index) {
        const title = c.title.toLowerCase();
        const text = c.text.toLowerCase();
        if (!words.every((w) => title.includes(w) || text.includes(w))) continue;
        const score = words.reduce((n, w) => n + (title.includes(w) ? 10 : 0) + Math.min(5, text.split(w).length - 1), 0);
        const [backend, sid] = key.split("|");
        hits.push({ backend, sid, dir: c.dir, title: c.title || "Untitled chat", snippet: snippet(c.text, words), score, updated: c.updated });
      }
      return hits.sort((a, b) => b.score - a.score || b.updated - a.updated).slice(0, 40);
    },
  };
}
