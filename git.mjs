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

// A remote URL is user input that will end up inside a shell command on someone else's machine,
// so it is allowed only in the exact forms git itself accepts, nothing else:
//   https://host/path        (the everyday form; no login in it, no http://)
//   ssh://host/path, ssh://user@host/path
//   user@host:path           (the scp-like form, e.g. git@github.com:owner/repo)
// No spaces, quotes, ; | $ ` & < > \ or newlines, ever: the allowlist below already makes them
// impossible, and the first check keeps the error message about them explicit.
export function validateRemoteUrl(u) {
  const s = String(u || "").trim();
  if (!s) return "paste a URL first";
  if (/[\s"'`;|&<>\r\n]/.test(s) || s.includes("\\"))
    return `a URL can't contain ${[...new Set([...s].filter((c) => /[\s"'`;|&<>\r\n\\]/.test(c)))].map((c) => ({ " ": "a space", '"': "a quote", "'": "a quote", "\n": "a line break" }[c] || `“${c}”`)).join(", ")}`;
  const host = "[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*";
  const path = "[A-Za-z0-9._~%/-]+";
  const forms = [
    new RegExp(`^https://${host}(?::\\d{1,5})?/${path}$`, "i"),
    new RegExp(`^ssh://(?:[a-z0-9][a-z0-9._-]*@)?${host}(?::\\d{1,5})?/${path}$`, "i"),
    // A user name starts with a letter or digit: "-x@host" could reach ssh as an option, not a name.
    new RegExp(`^[a-z0-9][a-z0-9._-]*@${host}:${path}$`, "i"),
  ];
  if (!forms.some((re) => re.test(s)))
    return "not a repo URL: use https://host/path, ssh://host/path, or user@host:path";
  return null;
}

export function createGit({ backends, projects, guardTemplate = null, log = console.log }) {
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

  /** The fs API resolves a file's path INSIDE its location, and it does not walk up
   *  out of it with "..". A relative path is fine when the location is the repo
   *  itself (.git/hooks/pre-push); an absolute path outside it (a linked
   *  worktree's shared git dir, a core.hooksPath) needs the file's own directory
   *  as the location instead. */
  const fsTarget = (dir, file) => {
    if (file.startsWith("/") || /^[A-Za-z]:[\\/]/.test(file)) {
      const i = Math.max(file.lastIndexOf("/"), file.lastIndexOf("\\"));
      return { dir: file.slice(0, i), file: file.slice(i + 1) };
    }
    return { dir, file };
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

  /** public / private / unknown, from the GitHub API with no token: 200 = public, 404 = private OR
   *  the repo doesn't exist (a typo in the remote also 404s — GitHub never says which), anything
   *  else (rate limit, network) = unknown. Cached briefly, so a list of many projects doesn't burn
   *  the unauthenticated rate limit. */
  async function visibility(owner, repo) {
    const key = owner + "/" + repo;
    const hit = visCache.get(key);
    if (hit && Date.now() - hit.at < VIS_TTL) return hit.visibility;
    let visibility = "unknown";
    try {
      const r = await fetch(`https://${GITHUB_API}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`, {
        headers: { accept: "application/vnd.github+json" },
        signal: AbortSignal.timeout(10_000),
      });
      visibility = r.status === 200 ? "public" : r.status === 404 ? "private-or-missing" : "unknown";
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
    // Where git actually runs a pre-push hook: .git/hooks/pre-push in an ordinary
    // repo, the shared git dir's hooks when this project is a linked worktree, and
    // core.hooksPath if set. The answer is absolute (--path-format=absolute, git
    // >= 2.31; the relative default stays as the fallback for older git) so it
    // also works when the project is a subfolder of the repo -- a relative
    // answer would be "../.git/..." and the fs API refuses to walk up.
    // fsTarget splits the path into the (location, file) pair the fs API wants;
    // the shell calls take it as-is.
    const hookFile = (await g("rev-parse --path-format=absolute --git-path hooks/pre-push")).output.trim()
      || (isWindows(dir) ? ".git\\hooks\\pre-push" : ".git/hooks/pre-push");
    const hf = fsTarget(dir, hookFile);
    const [br, rem, ab, st, lc, hook, hookx] = await Promise.all([
      g("branch --show-current"),
      g("remote get-url origin"),
      g(`rev-list --left-right --count ${q("HEAD...@{u}")}`),
      g("status --porcelain"),
      g("log -1 --pretty=%ct"),
      readRemoteFile(b, hf.dir, hf.file),
      // test -x is a plain shell command, not a git one, so it goes through run
      // (which the git-prefixing g() above would mangle). On Windows the exec
      // bit is meaningless: Git for Windows runs hooks regardless.
      (isWindows(dir) ? { exit: 0 } : run(b, dir, "test -x " + q(hookFile), 20_000)),
    ]);
    // The guard is HQ's own hook: it exists, carries the marker the installer
    // writes, and (on POSIX) is executable -- git silently ignores a
    // non-executable hook, so that would not be a guard at all.
    out.hasGuard = typeof hook === "string" && hook.includes("# hq-guard") && (isWindows(dir) || hookx.exit === 0);
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

  /**
   * Connect a repo that has no remote: `git remote add origin <url>`. The URL was already checked
   * by the dialog (and is shown to the user there before they confirm), and is checked AGAIN here,
   * on the server, before anything runs. `git remote add` only writes config — it contacts nothing —
   * but the quoting rule still applies.
   */
  async function connectRemote(projectId, url) {
    const p = find(projectId);
    const b = machine(p.backend);
    const dir = p.directory;
    const bad = validateRemoteUrl(url);
    if (bad) throw new Error(bad);
    const q = quoter(dir);
    const probe = await run(b, dir, envPrefix(dir) + "rev-parse --is-inside-work-tree", 20_000).catch((e) => ({ exit: 1, output: "", _err: e.message }));
    if (probe._err || probe.exit === 124) throw new Error(`can't reach ${b.label || p.backend}`);
    if (probe.output.trim() !== "true") throw new Error("not a git repository");
    const cur = await run(b, dir, envPrefix(dir) + "remote get-url origin", 20_000);
    if (cur.exit === 0 && cur.output.trim()) throw new Error("this project already has a remote named origin");
    const r = await run(b, dir, envPrefix(dir) + `remote add origin ${q(url.trim())}`, 30_000);
    if (r.exit !== 0) {
      const last = r.output.trim().split(/\r?\n/).pop() || `exit ${r.exit}`;
      throw new Error(`could not connect: ${last.slice(0, 300)}`);
    }
    return status(projectId);
  }

  // What a failed `git push --dry-run` usually means, in words the user can act on. Order matters:
  // the first match wins, and the login checks come before the permission ones (a missing login
  // fails before git ever asks the remote).
  const LOGIN_WHY = [
    [/could not read Username|terminal prompts disabled|Authentication failed/i,
      "no login saved on this machine for that remote — git would ask for a password, and HQ refuses to wait for one. Save a login there (a credential helper, a token in the URL, or an SSH key) and check again."],
    [/Host key verification failed/i,
      "this machine's ssh has never been offered that host's key, so it can't be trusted yet. Open a terminal on that machine and run ssh to the host once (or add its key to known_hosts), then check again."],
    [/Permission denied \(publickey\)/i,
      "this machine's SSH key isn't accepted by that remote. Add the machine's public key to the account that pushes there."],
    [/(?:status 403|not authorized|insufficient [a-z ]*access|repository is not allowed|permission to push)/i,
      "this login can reach the remote but isn't allowed to push to that repo. Give the account push access to it."],
  ];

  /**
   * "Check login": can this machine push to this project's origin? A real push with --dry-run,
   * which transfers nothing (and --no-verify, so no local hooks run) — but it answers the only
   * question that matters: does the login on this box work for that remote. envPrefix means it
   * can never wait for a password; a timeout is a failed check, not a hang.
   */
  async function checkLogin(projectId) {
    const p = find(projectId);
    const b = machine(p.backend);
    const dir = p.directory;
    const probe = await run(b, dir, envPrefix(dir) + "rev-parse --is-inside-work-tree", 20_000).catch((e) => ({ exit: 1, output: "", _err: e.message }));
    if (probe._err || probe.exit === 124) throw new Error(`can't reach ${b.label || p.backend}`);
    if (probe.output.trim() !== "true") throw new Error("not a git repository");
    const rem = await run(b, dir, envPrefix(dir) + "remote get-url origin", 20_000);
    const remote = rem.output.trim();
    if (rem.exit !== 0 || !remote)
      return { ok: false, why: "no remote named origin on this project yet — connect one first." };
    const r = await run(b, dir, envPrefix(dir) + "push --dry-run --no-verify origin HEAD", 60_000);
    if (r.exit === 0) {
      // A dry run sends no files, so GitHub can't apply its rule that a token may only change .github/workflows files
      // with the "workflow" permission: that refusal only shows up on a real push. Say so instead of implying it's covered.
      const gh = githubParts(remote);
      return { ok: true, why: "login works on this machine for that remote. Nothing was pushed." +
        (gh ? " (One thing a dry run can't check: pushing changes to .github/workflows needs a token with the workflow permission.)" : "") };
    }
    if (r.exit === 124) {
      return { ok: false, why: `timed out after 60 s — nothing moved, and nothing was pushed. The remote or the connection is very slow.` };
    }
    const out = r.output.trim();
    // A rejected non-fast-forward means the login WORKED (git got far enough to compare branches);
    // the branch just needs a pull or rebase. Not a login problem.
    if (/non-fast-forward/i.test(out)) {
      return { ok: true, why: "login works — but this branch is behind, or has diverged from, the remote, so a real push would be rejected until you pull or rebase. Nothing was pushed." };
    }
    const hit = LOGIN_WHY.find(([re]) => re.test(out));
    // For the unclassified case, show the first line that looks like the actual error, not git's
    // trailing boilerplate ("and the repository exists.").
    const lines = out.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    const real = lines.find((l) => /fatal:|error:|denied|refused|failed|host key/i.test(l)) || lines[0] || `exit ${r.exit}`;
    return { ok: false, why: (hit ? hit[1] : `the remote refused the check (${real.slice(0, 200)}).`) + " Nothing was pushed." };
  }

  /**
   * Install the push guard on a public project that has none: write HQ's
   * hooks/pre-push.sh into the repo's pre-push hook -- where git actually runs
   * it: .git/hooks/pre-push, the shared git dir for a linked worktree, or
   * core.hooksPath if set -- and make it executable. A pre-push hook the user
   * already has there that isn't HQ's is never overwritten -- the same two
   * checks the dialog showed (the repo is public, and no foreign hook sits
   * there) are repeated here, on the server.
   */
  async function installGuard(projectId) {
    const p = find(projectId);
    const b = machine(p.backend);
    const dir = p.directory;
    if (!guardTemplate) throw new Error("the guard template isn't available on this installation of HQ");
    const probe = await run(b, dir, envPrefix(dir) + "rev-parse --is-inside-work-tree", 20_000).catch((e) => ({ exit: 1, output: "", _err: e.message }));
    if (probe._err || probe.exit === 124) throw new Error(`can't reach ${b.label || p.backend}`);
    if (probe.output.trim() !== "true") throw new Error("not a git repository");
    // Re-check what the dialog showed, on the server, on the same values.
    const st = await status(projectId);
    if (st.visibility !== "public") throw new Error("this isn't a public repo, so the guard isn't needed");
    const q = quoter(dir);
    // The same "where git runs the hook" answer status() uses (see there),
    // absolute so it is also right when the project is a subfolder of the repo.
    const [hookProbe, commonDirProbe, hooksPathProbe] = await Promise.all([
      run(b, dir, envPrefix(dir) + "rev-parse --path-format=absolute --git-path hooks/pre-push", 20_000),
      run(b, dir, envPrefix(dir) + "rev-parse --path-format=absolute --git-common-dir", 20_000),
      run(b, dir, envPrefix(dir) + "config --get core.hooksPath", 20_000),
    ]);
    const hookFile = hookProbe.output.trim() || (isWindows(dir) ? ".git\\hooks\\pre-push" : ".git/hooks/pre-push");
    // A core.hooksPath that points OUTSIDE the git dir is the user's own hooks
    // location -- usually a tracked folder like .husky. Writing HQ's hook there
    // would add a file to the repo itself, where it could get committed: refuse.
    // (A hooksPath inside the git dir is fine: nothing new enters the repo.)
    // The reference is the COMMON git dir: in a linked worktree --git-dir is
    // the per-worktree .git/worktrees/<name>, but the hook still lives in the
    // shared git dir's hooks folder.
    const commonDir = commonDirProbe.output.trim();
    if (commonDir && !hookFile.startsWith(commonDir + "/") && !hookFile.startsWith(commonDir + "\\"))
      throw new Error(`this repo uses its own hooks folder (core.hooksPath = ${hooksPathProbe.output.trim() || hookFile.replace(/([/\\])pre-push$/, "")}); HQ won't add files to it`);
    const hf = fsTarget(dir, hookFile);
    const existing = await readRemoteFile(b, hf.dir, hf.file);
    if (existing !== null && !existing.includes("# hq-guard"))
      throw new Error("a pre-push hook is already installed and it isn't HQ's, so HQ left it in place");
    // Write the guard, then make it executable on POSIX (Mac / Linux). Git for
    // Windows runs hooks regardless of the file mode, so it needs no chmod.
    await writeRemoteFile(b, hf.dir, hf.file, guardTemplate);
    if (!isWindows(dir)) {
      const r = await run(b, dir, "chmod +x " + q(hookFile), 20_000);
      if (r.exit !== 0) {
        // A hook without the exec bit is dead weight, and its marker would make the
        // dialog claim protection git silently ignores: remove what was just written
        // (best effort), then report.
        await run(b, dir, "rm -f " + q(hookFile), 20_000).catch(() => {});
        const last = r.output.trim().split(/\r?\n/).pop() || `exit ${r.exit}`;
        throw new Error(`the guard could not be made executable, so HQ removed it again: ${last.slice(0, 200)}`);
      }
    }
    return status(projectId);
  }

  /** A file-write through OpenCode's experimental fs/write endpoint. */
  async function writeRemoteFile(b, dir, file, content) {
    const u = b.url.replace(/\/$/, "") + `/api/experimental/fs/write?path=${encodeURIComponent(file)}&${loc(dir)}`;
    const r = await fetch(u, {
      method: "POST",
      headers: b.user
          ? { "content-type": "application/octet-stream", authorization: "Basic " + Buffer.from(`${b.user}:${b.password}`).toString("base64") }
          : { "content-type": "application/octet-stream" },
      body: content,
      signal: AbortSignal.timeout(30_000),
    });
    const t = await r.text();
    if (!r.ok) throw new Error(`writing ${file} failed (${r.status}): ${t.slice(0, 200)}`);
    return t;
  }
  return { status, refresh, connectRemote, checkLogin, installGuard };
}
