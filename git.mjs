// Settings › Git: the git state of every project, at a glance, and the safe way to connect a
// project to a remote. HQ reads and reports (and runs `git fetch` when the user clicks Refresh);
// pushing is left to agents and terminals, which know their own rules.
//
// Every command runs on the machine the project is on, through OpenCode's shell API, the same way
// copies.mjs does: ONE git command per run (no &&, no pipes, no >), every path and URL quoted so
// the same code works on every platform, and nothing may ever wait for a password:
//   GIT_TERMINAL_PROMPT=0            git never prompts for a username or password
//   GIT_SSH_COMMAND=ssh -o BatchMode=yes -o ConnectTimeout=10
//                                    ssh never prompts either (the shell has no TTY, but the flags
//                                    are the guarantee)
// OpenCode's shell is bash on Mac/Linux and PowerShell on Windows, so the environment is set the
// way each shell takes it, on the same single line, right in front of the one git command:
//   POSIX:      GIT_TERMINAL_PROMPT=0 GIT_SSH_COMMAND='ssh …' git …
//   PowerShell: $env:GIT_TERMINAL_PROMPT='0'; $env:GIT_SSH_COMMAND='ssh …'; git …
// (a `;` in PowerShell is how one line does two things — it is not the && chaining the rule bans).
// The values are fixed strings written here, never user input.

const GITHUB_API = "api.github.com";
const VIS_TTL = 10 * 60 * 1000; // how long owner/repo visibility is cached (unauthenticated rate limit)
const visCache = new Map(); // "owner/repo" -> { at, visibility }

/** A remote URL with whatever login is in it removed, before it goes back to the browser. */
export function stripCredentials(u) {
  const m = String(u || "").trim().match(/^(https?|ssh|git):\/\/(?:([^/@]*)@)?(.+)$/i);
  if (!m) return u; // not a URL (e.g. a bare path): nothing in it to strip
  const scheme = m[1].toLowerCase();
  const user = m[2] || "";
  // https:// user@ and user:pass@ are credentials. ssh://git@host is the login name, not a secret,
  // so it stays; only ssh:// user:pass@ is stripped (the password is the secret).
  if (scheme === "ssh" && !user.includes(":")) return `${m[1]}://${user}@${m[3]}`;
  return `${m[1]}://${m[3]}`;
}

/** github.com/<owner>/<repo> for a GitHub remote (either URL form); null for anything else. */
export function githubParts(remote) {
  let host = "", p = "";
  const scp = String(remote || "").trim().match(/^git@github\.com:(.+)$/);
  const url = !scp && String(remote || "").trim().match(/^(?:https?|ssh)?:\/\/(?:[^@/]*@)?([^/]+)\/(.+)$/i);
  if (scp) { host = "github.com"; p = scp[1]; }
  else if (url) { host = url[1].toLowerCase(); p = url[2]; }
  if (host !== "github.com") return null;
  const segs = p.split("/").map((s) => s.trim()).filter(Boolean);
  if (segs.length < 2) return null;
  return { owner: segs[0], repo: segs[1].replace(/\.git$/i, "") };
}

export function createGit({ backends, projects, log = console.log }) {
  const call = async (b, method, p, body) => {
    const auth = b.user ? { authorization: "Basic " + Buffer.from(`${b.user}:${b.password}`).toString("base64") } : {};
    const r = await fetch(b.url.replace(/\/$/, "") + "/api" + p, {
      method, headers: { ...auth, ...(body ? { "content-type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(120_000),
    });
    const t = await r.text();
    if (!r.ok) throw new Error(`${method} ${p} -> ${r.status} ${t.slice(0, 200)}`);
    return t ? JSON.parse(t) : null;
  };
  const loc = (d) => "location[directory]=" + encodeURIComponent(d);
  const machine = (id) => {
    const b = backends.get(id);
    if (!b) throw new Error("unknown machine");
    return b;
  };
  const isWindows = (dir) => /^[A-Za-z]:[\\/]/.test(dir);
  // Same quoting as copies.mjs: single quotes expand nothing on Mac/Linux; Windows keeps double quotes.
  const qPosix = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
  const qWin = (s) => `"${String(s).replace(/"/g, '\\"')}"`;
  const quoter = (dir) => (isWindows(dir) ? qWin : qPosix);

  /** Run one command on that machine; returns {exit, output}. */
  async function run(b, dir, command, timeoutMs = 60_000) {
    const sh = (await call(b, "POST", `/shell?${loc(dir)}`, { command, cwd: dir, timeout: timeoutMs })).data;
    const t0 = Date.now();
    let st = sh;
    while (st.status === "running" && Date.now() - t0 < timeoutMs + 5000) {
      await new Promise((r) => setTimeout(r, 700));
      st = (await call(b, "GET", `/shell/${sh.id}?${loc(dir)}`)).data;
    }
    let output = "";
    for (let cursor = 0, i = 0; i < 20; i++) {
      const o = (await call(b, "GET", `/shell/${sh.id}/output?${loc(dir)}&cursor=${cursor}`)).data;
      output += o.output;
      if (!o.output || o.cursor >= o.size) break;
      cursor = o.cursor;
    }
    await call(b, "DELETE", `/shell/${sh.id}?${loc(dir)}`).catch(() => {});
    return { exit: st.status === "exited" ? st.exit ?? 0 : st.status === "timeout" ? 124 : 1, output };
  }

  /** The no-prompt environment, in front of the one git command (see the note at the top). */
  const envPrefix = (dir) => {
    const ssh = "ssh -o BatchMode=yes -o ConnectTimeout=10";
    return isWindows(dir)
      ? `$env:GIT_TERMINAL_PROMPT='0'; $env:GIT_SSH_COMMAND='${ssh}'; git `
      : `GIT_TERMINAL_PROMPT=0 GIT_SSH_COMMAND='${ssh}' git `;
  };

  /** Read one file on that machine through OpenCode's fs API (no shell, so it works everywhere). */
  async function readRemoteFile(b, dir, file) {
    const r = await fetch(b.url.replace(/\/$/, "") + `/api/fs/read/${file}?${loc(dir)}`, {
      headers: b.user ? { authorization: "Basic " + Buffer.from(`${b.user}:${b.password}`).toString("base64") } : {},
      signal: AbortSignal.timeout(20_000),
    });
    if (!r.ok) return null;
    return (await r.text()).slice(0, 64_000);
  }

  /** public / private / unknown, from the GitHub API with no token: 200 = public, 404 = private or
   *  missing, anything else (rate limit, network) = unknown. Cached briefly, so a list of many
   *  projects doesn't burn the unauthenticated rate limit. */
  async function visibility(owner, repo) {
    const key = owner + "/" + repo;
    const hit = visCache.get(key);
    if (hit && Date.now() - hit.at < VIS_TTL) return hit.visibility;
    let visibility = "unknown";
    try {
      const r = await fetch(`https://${GITHUB_API}/repos/${owner}/${repo}`, {
        headers: { accept: "application/vnd.github+json" },
        signal: AbortSignal.timeout(10_000),
      });
      visibility = r.status === 200 ? "public" : r.status === 404 ? "private" : "unknown";
    } catch {
      visibility = "unknown";
    }
    visCache.set(key, { at: Date.now(), visibility });
    return visibility;
  }

  const find = (id) => {
    const p = projects().find((x) => x.id === id);
    if (!p) throw new Error("unknown project");
    return p;
  };

  /**
   * The read-only state of one project. Nothing here fetches or changes anything: ahead/behind is
   * the last fetched state (the Refresh button runs the fetch). Throws "can't reach <machine>"
   * when the machine isn't answering, so the caller can show that without counting it a git problem.
   */
  async function status(projectId) {
    const p = find(projectId);
    const b = machine(p.backend);
    const dir = p.directory;
    const q = quoter(dir);
    const out = {
      id: p.id, name: p.name, backend: p.backend,
      isGit: false, branch: null, remote: null, owner: null, repo: null,
      visibility: "unknown", ahead: 0, behind: 0, uncommitted: 0,
      lastCommitAt: null, hasGuard: false, problems: [],
    };
    const g = (cmd, timeoutMs = 20_000) => run(b, dir, envPrefix(dir) + cmd, timeoutMs).catch((e) => ({ exit: 1, output: "", _err: e.message }));
    const probe = await g("rev-parse --is-inside-work-tree");
    if (probe._err || probe.exit === 124) throw new Error(`can't reach ${b.label || p.backend}`);
    out.isGit = probe.output.trim() === "true";
    if (!out.isGit) {
      out.problems.push("not a git repository");
      return out;
    }
    const hookFile = isWindows(dir) ? ".git\\hooks\\pre-push" : ".git/hooks/pre-push";
    const [br, rem, ab, st, lc, hook] = await Promise.all([
      g("branch --show-current"),
      g("remote get-url origin"),
      g(`rev-list --left-right --count ${q("HEAD...@{u}")}`),
      g("status --porcelain"),
      g("log -1 --pretty=%ct"),
      readRemoteFile(b, dir, hookFile),
    ]);
    // The guard is HQ's own hook: it exists and carries the marker the installer writes.
    out.hasGuard = typeof hook === "string" && hook.includes("# hq-guard");
    if (br.output.trim()) out.branch = br.output.trim();
    const remote = rem.output.trim();
    if (rem.exit === 0 && remote) {
      out.remote = stripCredentials(remote);
      const gh = githubParts(remote);
      if (gh) {
        out.owner = gh.owner;
        out.repo = gh.repo;
        out.visibility = await visibility(gh.owner, gh.repo);
      }
    } else if (rem.exit !== 0) {
      out.problems.push("no remote");
    }
    // ahead/behind: HEAD...@{u} with --left-right counts "ahead behind"; the command fails when
    // the branch has no upstream set.
    if (ab.exit === 0) {
      const [ahead, behind] = ab.output.trim().split(/\s+/).map(Number);
      out.ahead = ahead || 0;
      out.behind = behind || 0;
      if (out.ahead || out.behind) out.problems.push(`out of sync: ${out.ahead} to push, ${out.behind} to pull`);
    } else if (rem.exit === 0 && remote) {
      out.problems.push("no upstream branch");
    }
    out.uncommitted = st.output.split(/\r?\n/).filter((l) => l.trim()).length;
    const ct = lc.output.trim();
    if (lc.exit === 0 && /^\d+$/.test(ct)) out.lastCommitAt = Number(ct) * 1000;
    if (out.visibility === "public" && !out.hasGuard) out.problems.push("public repo without a push guard");
    return out;
  }

  /** Refresh: fetch the remote so ahead/behind is current. The user's button only; never automatic. */
  async function refresh(projectId) {
    const p = find(projectId);
    const b = machine(p.backend);
    const q = quoter(p.directory);
    const probe = await run(b, p.directory, envPrefix(p.directory) + "rev-parse --is-inside-work-tree", 20_000).catch((e) => ({ exit: 1, output: "", _err: e.message }));
    if (probe._err || probe.exit === 124) throw new Error(`can't reach ${b.label || p.backend}`);
    if (probe.output.trim() !== "true") throw new Error("not a git repository");
    const r = await run(b, p.directory, envPrefix(p.directory) + "fetch --prune", 30_000);
    if (r.exit !== 0) {
      const last = r.output.trim().split(/\r?\n/).pop() || `exit ${r.exit}`;
      throw new Error(`fetch failed: ${last.slice(0, 300)}`);
    }
    return status(projectId);
  }

  return { status, refresh };
}
