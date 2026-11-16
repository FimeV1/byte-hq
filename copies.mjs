// "Work on a copy": the agent works in a git worktree of the project, the change is tested there, and
// only a tested change is applied to the live project (as one commit of just those files).
// For local models it's worth working on a copy, then adding to live only once it's tested.
//
// Uses OpenCode's own worktree API (copies live in its data folder) and its shell API to run git and
// tests on whichever machine the project is on. Each git step is its own command (no &&, no >), so the
// same code works in a Windows shell.
//
// Session metadata: hqCopy = { base, worktree, projectID, guard, applied?, discarded? }, hqTest = last result.

/**
 * Permission rules that keep a copy chat out of the live project. OpenCode's tool for commands is `shell`
 * (not `bash`), and the last matching rule wins, so these go after any "allow everything" rule.
 * Shell commands are matched as text, so every way of writing the path is listed. Tools called inside
 * OpenCode's `execute` (e.g. session_move into the live folder) hit the same rules.
 */
export function copyGuard(base, home) {
  const forms = new Set([base, base.replace(/\\/g, "/")]);
  if (home && base.startsWith(home)) {
    const rel = base.slice(home.length).replace(/\\/g, "/");
    for (const h of ["~", "$HOME", "${HOME}"]) forms.add(h + rel);
  }
  // The path must end where it ends ("~/app" must not catch "~/app-old"): followed by a slash, a space, a quote,
  // a semicolon or the end of the command.
  const ends = ["/*", " *", "'*", '"*', ";*", ""];
  const root = base.replace(/[\\/]+$/, "");
  return [
    { action: "external_directory", resource: root, effect: "deny" },
    { action: "external_directory", resource: root + "/*", effect: "deny" },
    { action: "external_directory", resource: root + "/**", effect: "deny" },
    ...[...forms].flatMap((f) => ends.map((e) => ({ action: "shell", resource: `*${f.replace(/[\\/]+$/, "")}${e}`, effect: "deny" }))),
  ];
}

/**
 * The services to restart after applying these files, from the project's restart map ({commands, map: [[regex, [names]]]}).
 * The first matching rule wins per file (so "docs/x.py" can map to nothing); names come back in the order of
 * `commands` (so a build runs before the server restart). "all" replaces the services it already covers.
 */
export function restartPlan(project, files) {
  const R = project?.restart;
  if (!R?.map || !R.commands) return [];
  const want = new Set();
  for (const f of files) {
    const rule = R.map.find(([re]) => new RegExp(re).test(f.replace(/\\/g, "/")));
    for (const n of rule ? rule[1] : []) if (R.commands[n]) want.add(n);
  }
  let names = Object.keys(R.commands).filter((n) => want.has(n));
  if (names.includes("all")) names = names.filter((n) => n === "all" || /api/.test(n)); // `all` = everything except the API units
  return names;
}

/** The standing instruction a copy chat gets, so the model knows where it is. */
export function copyInstruction(base, worktree, home) {
  const short = home && base.startsWith(home) ? "~" + base.slice(home.length) : base;
  return (
    `You are working on a COPY of this project, not the live one. Your folder is ${worktree}. ` +
    `The live project is ${base}: never edit files there, never run commands in it, never copy files into it ` +
    `(HQ blocks it). Wherever AGENTS.md or any other note names ${short} or ${base}, for you that means ` +
    `this copy. If something you need only exists in the live folder, say so instead of going there. ` +
    `When you finish, the user tests this copy in HQ and applies it to live; never restart live services from a copy.`
  );
}

// How applied commits credit the work (config.credit). By default nothing is added. Set it to credit your assistant:
// { "name": "My Assistant ({role})", "email": "...", "line": "...", "footer": "..." }. {role} becomes
// "local coding model" / "local review model". The email decides whose GitHub avatar shows as co-author.
const CREDIT = { name: null, email: "", line: "Made and tested on a copy.", footer: "" };

/**
 * A model-written line (the chat title, or the reviewer's COMMIT line) going into `git commit -m`: keep it to plain
 * words. A title with a backticked word in it was once executed by the shell when committed, so nothing a shell
 * could act on may survive: no backticks, $, %, ", \\ or !.
 */
export function commitLine(s) {
  return String(s || "").replace(/[`$%"\\!]/g, "").replace(/\s+/g, " ").trim().slice(0, 72);
}

export function createCopies({ backends, projects, credit = {}, log = console.log }) {
  const C = { ...CREDIT, ...credit, name: typeof credit.name === "string" ? (r) => credit.name.replace("{role}", r).replace("{model}", r) : null };
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
  const getSes = async (b, sid) => (await call(b, "GET", `/session/${sid}`)).data;
  const setMeta = async (b, sid, patch) => {
    const meta = (await getSes(b, sid)).metadata || {};
    await call(b, "PATCH", `/session/${sid}`, { metadata: { ...meta, ...patch } });
  };
  const isWindows = (dir) => /^[A-Za-z]:[\\/]/.test(dir);
  // Quoting for commands run through a machine's shell. On Mac/Linux, double quotes still expand `...` and $(...),
  // so a model-written chat title in the commit message could run a command (found 2026-11-15: a title with
  // `persona_lock` in backticks was executed). Single quotes expand nothing there. Windows keeps double quotes.
  const qPosix = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
  const qWin = (s) => `"${String(s).replace(/"/g, '\\"')}"`;
  const quoter = (dir) => (isWindows(dir) ? qWin : qPosix);

  /** Run one command on that machine; returns {exit, output}. */
  async function run(b, dir, command, timeoutMs = 600_000) {
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

  /** Co-author lines by ROLE (who wrote the change, who reviewed it), never model names. Empty unless credit.name is set. */
  async function coAuthors(b, ses) {
    if (!C.name || !C.email) return [];
    const roles = [];
    const wrote = (await call(b, "GET", `/session/${ses.id}/message?limit=200`)).data.some((m) => m.type === "assistant");
    if (wrote) roles.push("local coding model");
    let reviewed = false;
    for (const k of (await call(b, "GET", `/session?parentID=${ses.id}&limit=50`)).data) {
      if (k.metadata?.hqReview && (await call(b, "GET", `/session/${k.id}/message?limit=20`)).data.some((m) => m.type === "assistant")) reviewed = true;
    }
    if (reviewed) roles.push("local review model");
    return roles.map((r) => `${C.name(r)} <${C.email}>`);
  }

  return {
    /** Is this folder inside a git repository (so a chat in it can work on a copy)? */
    async isGit(backendId, dir) {
      const b = machine(backendId);
      return (await run(b, dir, "git rev-parse --is-inside-work-tree", 20_000).catch(() => ({ output: "" }))).output.trim() === "true";
    },

    /** Make a copy of the project and a chat that works in it. */
    async start(backendId, base, body = {}) {
      const b = machine(backendId);
      const info = await call(b, "GET", `/location?${loc(base)}`);
      const projectID = info.project?.id;
      const isGit = (await run(b, base, "git rev-parse --is-inside-work-tree")).output.trim() === "true";
      if (!projectID || !isGit) throw new Error("that folder isn't a git repository, so it can't be copied");
      const name = "hq-" + new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
      const worktree = (await call(b, "POST", "/worktree", { projectID, name })).directory;
      // Keep the chat out of the live project (copy chats had said they were working on live: the
      // docs they read name the live folder as "the" source of truth, and nothing told them they were on a copy).
      // Deny rules come last, so they win even over "allow everything"; they are kept in the metadata so the app
      // can re-add them when the permission mode changes. Tested: edit/write/read and shell commands that name the
      // live path are refused. A deliberately disguised path (built from pieces in a script) still gets through.
      const guard = copyGuard(base, b.home);
      const ses = (await call(b, "POST", "/session", {
        location: { directory: worktree },
        ...(body.model ? { model: body.model } : {}),
        permissions: [...(body.permissions || []), ...guard],
        metadata: { ...(body.auto ? { hqAuto: true } : {}), hqCopy: { base, worktree, projectID, guard } },
      })).data;
      // Say it in words too: the model otherwise only sees an unfamiliar folder path.
      await call(b, "PUT", `/experimental/session/${ses.id}/instructions/entries/hq-copy`, { value: copyInstruction(base, worktree, b.home) })
        .catch((e) => log(`copy instruction: ${e.message}`));
      // Gitignored tool folders the project's own docs tell models to use (e.g. `.venv/bin/python …`). Linked, not
      // copied, so the checks work in the copy instead of sending the model to the live folder.
      // OpenCode fills the worktree in the background, so wait for its checkout (.git) first.
      if (!isWindows(worktree)) {
        for (const d of [".venv", "node_modules"]) {
          // Absolute paths only: while the worktree folder doesn't exist yet, the shell starts in the live project.
          const src = qPosix(base + "/" + d);
          const w = qPosix(worktree);
          const r = await run(b, base,
            `i=0; while [ ! -e ${w}/.git ] && [ $i -lt 40 ]; do sleep 0.5; i=$((i+1)); done; cd ${w} || exit 1; ` +
            // A link is a file to git: a "dir/" ignore pattern doesn't cover it, and Apply runs `git add -A`. So
            // make the link, then keep it only if git ignores it (no change shows up); otherwise remove it.
            `if [ -d ${src} ] && [ ! -e ${d} ]; then ln -s ${src} ${d}; ` +
            `if [ -z "$(git status --porcelain -- ${d})" ]; then echo linked; else rm -f ${d}; echo not-ignored; fi; else echo skipped; fi`, 30_000,
          ).catch((e) => ({ exit: 1, output: e.message }));
          if (r.output.includes("linked")) log(`copy: linked ${d} into ${worktree}`);
          else if (r.output.includes("not-ignored")) log(`copy: did not link ${d}: git would treat the link as a new file (add a plain "${d}" line to .gitignore)`);
          else if (r.exit !== 0) log(`copy: could not link ${d}: ${r.output.trim().slice(-200)}`);
        }
      }
      log(`copy: ${base} -> ${worktree} (${backendId})`);
      return ses;
    },

    /** Syntax-check changed files, then run the project's test command, inside the copy. */
    async test(backendId, sid) {
      const b = machine(backendId);
      const ses = await getSes(b, sid);
      const c = ses.metadata?.hqCopy;
      if (!c?.worktree) throw new Error("this chat isn't working on a copy");
      const wt = c.worktree;
      const q = quoter(wt);
      const steps = [];
      const changed = (await run(b, wt, "git status --porcelain")).output.split(/\r?\n/)
        .map((l) => l.slice(3).trim().replace(/^"|"$/g, "")).filter(Boolean).map((f) => f.split(" -> ").pop());
      const py = changed.filter((f) => f.endsWith(".py"));
      const js = changed.filter((f) => /\.(m?js|cjs)$/.test(f));
      if (py.length && !isWindows(wt)) steps.push({ name: `Python syntax (${py.length} file${py.length > 1 ? "s" : ""})`, ...(await run(b, wt, `python3 -m py_compile ${py.map(q).join(" ")}`)) });
      for (const f of js) steps.push({ name: `JavaScript syntax: ${f}`, ...(await run(b, wt, `node --check ${q(f)}`)) });
      const project = projects().find((p) => p.backend === backendId && p.directory === c.base);
      // Static check that catches what local models get wrong most (a name that doesn't exist, a missing import,
      // a typo'd variable) without running anything. Only when the project names a Python that has pyflakes;
      // only real errors fail it, not style warnings like unused imports.
      // Only errors the change INTRODUCED fail it: the same files are checked in the live project too, and errors
      // already there are listed as warnings (2026-11-15: two old bugs in a changed file failed a copy that hadn't
      // touched them). Compared by file and message, not line number, since edits shift lines.
      if (py.length && project?.python && !isWindows(wt)) {
        const BAD = /undefined name|syntax|unexpected indent|unindent|invalid|referenced before assignment|unable to detect undefined/i;
        const errs = (out) => out.split(/\r?\n/).filter((l) => BAD.test(l) && !/No such file/i.test(l));
        const key = (l) => l.replace(/^(.*?):\d+(:\d+)?:\s*/, "$1: ").replace(/on line \d+/g, "on line N");
        const mine = errs((await run(b, wt, `${project.python} -m pyflakes ${py.map(q).join(" ")}`)).output);
        const live = errs((await run(b, c.base, `${project.python} -m pyflakes ${py.map(q).join(" ")}`)).output);
        const left = live.map(key);
        const fresh = mine.filter((l) => {
          const i = left.indexOf(key(l));
          if (i < 0) return true;
          left.splice(i, 1);
          return false;
        });
        const old = mine.filter((l) => !fresh.includes(l));
        const out = [
          fresh.length ? "New errors from this change:\n" + fresh.join("\n") : "No new undefined names or syntax errors.",
          ...(old.length ? ["Already in the live code (not caused by this change, worth fixing separately):\n" + old.join("\n")] : []),
        ].join("\n\n");
        steps.push({ name: "Python names and imports (pyflakes)", exit: fresh.length ? 1 : 0, output: out });
      }
      const test = project?.test;
      if (test) steps.push({ name: "Project tests", ...(await run(b, wt, test)) });
      const ok = steps.every((s) => s.exit === 0);
      const result = {
        ok, at: Date.now(), ran: steps.length, changed: changed.length,
        // No changes in the copy usually means the model edited files OUTSIDE the project folder (2026-11-15: a
        // config in the home folder): those edits went straight to live, so there is nothing here to test or apply.
        summary: !changed.length ? "nothing to test: this copy has no changes. Edits to files outside the project folder (configs in the home folder, other machines) aren't in the copy: they were made live straight away."
          : steps.length ? steps.map((s) => `${s.exit === 0 ? "passed" : "FAILED"}: ${s.name}`).join("; ") : "nothing to check (no test command and no Python/JS changes)",
        steps: steps.map((s) => ({ name: s.name, exit: s.exit, output: s.output.slice(-4000) })),
      };
      await setMeta(b, sid, { hqTest: { ok, at: result.at, summary: result.summary } });
      return result;
    },

    /** Put the copy's change into the live project as one commit of just those files, then remove the copy. */
    async apply(backendId, sid) {
      const b = machine(backendId);
      const ses = await getSes(b, sid);
      const c = ses.metadata?.hqCopy;
      if (!c?.worktree || c.applied || c.discarded) throw new Error("nothing to apply");
      // Not while the independent review is still reading the copy: applying deletes the copy under it, and its
      // verdict would be lost (2026-11-15).
      const active = (await call(b, "GET", "/session/active")).data || {};
      const kids = (await call(b, "GET", `/session?parentID=${sid}&limit=50`)).data || [];
      if (kids.some((k) => k.metadata?.hqReview && active[k.id])) throw new Error("the independent review is still running; apply when it has finished");
      const wt = c.worktree;
      const q = quoter(c.base);
      const must = async (dir, cmd, what) => {
        const r = await run(b, dir, cmd);
        if (r.exit !== 0) throw new Error(`${what}: ${r.output.trim().slice(-600) || "exit " + r.exit}`);
        return r.output;
      };
      await must(wt, "git add -A", "staging the copy");
      const files = (await must(wt, "git diff --cached --name-only HEAD", "listing changes")).split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
      if (!files.length) throw new Error("the copy has no changes");
      // A git repository inside the copy (a model's test fixtures, a stray clone) is staged as an embedded repo:
      // just a pointer, committed as a broken link, and published if the project is pushed (2026-11-16: a copy chat
      // left eight test repos loose in dev/). Refuse new ones; changes to existing submodules are fine.
      const embedded = (await must(wt, "git diff --cached --raw HEAD", "checking for repositories inside the copy"))
        .split(/\r?\n/).map((l) => l.match(/^:(\d{6}) 160000 \S+ \S+ \S+\t(.+)$/)).filter((m) => m && m[1] !== "160000").map((m) => m[2]);
      if (embedded.length) {
        throw new Error(`this change adds ${embedded.length === 1 ? "a git repository" : embedded.length + " git repositories"} inside the project ` +
          `(${embedded.slice(0, 5).join(", ")}${embedded.length > 5 ? ", …" : ""}), which would be committed as a broken link. ` +
          "Ask the chat to delete them or move them into a git-ignored folder, then apply again.");
      }
      const patch = `${c.base.replace(/[\\/]+$/, "")}${isWindows(c.base) ? "\\" : "/"}.git${isWindows(c.base) ? "\\" : "/"}hq-apply.patch`;
      await must(wt, `git diff --cached --binary HEAD --output=${q(patch)}`, "making the patch");
      // Everything that can fail without touching the live project happens first.
      // The subject says what the change does. The independent reviewer saw the request and the whole
      // diff, so its line wins over the chat title, which goes stale when a chat changes topic
      // One line per reviewed turn; the first is the subject, the rest go in the body.
      const reviewed = [...new Set((ses.metadata?.hqCommitLines || [])
        .filter((l) => l && typeof l.line === "string" && l.line.trim())
        .map((l) => commitLine(l.line)))]
        .filter(Boolean);
      const lines = reviewed.length ? reviewed : [commitLine(ses.title) || "change from HQ"];
      const test = ses.metadata?.hqTest;
      const credits = await coAuthors(b, ses).catch(() => []);
      const tested = test?.ok ? `Tests: ${test.summary}.` : "Not tested before it was applied.";
      // Co-author lines must be the LAST lines of the message: git and GitHub only read trailers at the very end.
      // (A footer after them would hide the co-authors on GitHub.)
      const also = lines.length > 1 ? `\nAlso in this change:\n${lines.slice(1).map((l) => "- " + l).join("\n")}` : "";
      const msg = `${lines[0]}\n\n${C.line}\n${tested}${also}` +
        (C.footer ? `\n\n${C.footer}` : "") +
        (credits.length ? "\n\n" + credits.map((x) => `Co-Authored-By: ${x}`).join("\n") : "");
      // Refuses (changing nothing) if the live files changed in a way that conflicts. Changes elsewhere in the same
      // file are fine; only edits near the same lines conflict. Say which files moved on in live since the copy.
      const fits = await run(b, c.base, `git apply --check ${q(patch)}`);
      if (fits.exit !== 0) {
        const from = (await run(b, wt, "git rev-parse HEAD")).output.trim();
        const moved = new Set();
        if (/^[0-9a-f]{7,40}$/.test(from)) {
          for (const f of (await run(b, c.base, `git diff --name-only ${from} HEAD -- ${files.map(q).join(" ")}`)).output.split(/\r?\n/)) if (f.trim()) moved.add(f.trim());
        }
        for (const l of (await run(b, c.base, `git status --porcelain -- ${files.map(q).join(" ")}`)).output.split(/\r?\n/)) if (l.trim()) moved.add(l.slice(3).trim());
        const which = moved.size ? ` Changed in live since this copy was made: ${[...moved].join(", ")}.` : "";
        throw new Error(`the change doesn't fit the live files any more: live was edited near the same lines.${which} ` +
          `Nothing was changed. Start a new copy and ask for the change again. (${fits.output.trim().slice(-300)})`);
      }
      await must(c.base, `git apply ${q(patch)}`, "applying");
      let commit;
      try {
        await must(c.base, `git add -- ${files.map(q).join(" ")}`, "staging");
        await must(c.base, `git commit -m ${q(msg)} -- ${files.map(q).join(" ")}`, "committing");
        commit = (await must(c.base, "git rev-parse --short HEAD", "reading the commit")).trim();
      } catch (e) {
        // Put the live project back exactly as it was, then report.
        await run(b, c.base, `git reset -q -- ${files.map(q).join(" ")}`);
        await run(b, c.base, `git apply -R ${q(patch)}`);
        throw new Error(`${e.message} (the live project was put back as it was)`);
      }
      await call(b, "DELETE", "/worktree", { projectID: c.projectID, directory: wt, force: true }).catch((e) => log(`copy cleanup: ${e.message}`));
      // Which services run the applied files (the project's restart map). Not restarted here: HQ offers a button,
      // because a restart cuts off replies in progress and may need to wait for something the project's own check knows about.
      const project = projects().find((p) => p.backend === backendId && p.directory === c.base);
      const restart = restartPlan(project, files);
      await setMeta(b, sid, { hqCopy: { ...c, applied: commit, ...(restart.length ? { restart } : {}) }, hqAuto: false });
      log(`copy applied: ${c.base} commit ${commit} (${files.length} files)${restart.length ? `; restart offered: ${restart.join(", ")}` : ""}`);
      return { commit, files, restart };
    },

    /** Restart the services an applied copy touched: the project's safety check, each restart, then its health check. */
    async restart(backendId, sid) {
      const b = machine(backendId);
      const ses = await getSes(b, sid);
      const c = ses.metadata?.hqCopy;
      if (!c?.applied || !c.restart?.length) throw new Error("nothing to restart for this chat");
      const project = projects().find((p) => p.backend === backendId && p.directory === c.base);
      const R = project?.restart;
      if (!R) throw new Error("this project has no restart settings");
      if (R.check) {
        const chk = await run(b, c.base, R.check, 60_000);
        if (chk.exit !== 0) throw new Error(chk.output.trim().slice(-400) || "the safety check refused");
      }
      const results = [];
      for (const name of c.restart) {
        const r = await run(b, c.base, R.commands[name], 180_000);
        results.push({ name, exit: r.exit, output: r.output.trim().slice(-300) });
        if (r.exit !== 0) break;
      }
      let verify = null;
      if (R.verify && results.every((r) => r.exit === 0)) verify = await run(b, c.base, R.verify, 120_000);
      const ok = results.every((r) => r.exit === 0) && (!verify || verify.exit === 0);
      const summary = ok
        ? `Restarted ${c.restart.join(", ")}${verify ? "; everything is back up" : ""}.`
        : results.find((r) => r.exit !== 0)
          ? `Restarting ${results.find((r) => r.exit !== 0).name} failed: ${results.find((r) => r.exit !== 0).output}`
          : `Restarted, but the health check found a problem:\n${verify.output.trim().slice(-600)}`;
      await setMeta(b, sid, { hqCopy: { ...c, restarted: { at: Date.now(), ok, summary } } });
      log(`copy restart (${backendId} ${c.base}): ${summary.split("\n")[0]}`);
      return { ok, summary, results, verify: verify ? verify.output.trim().slice(-800) : null };
    },

    async discard(backendId, sid) {
      const b = machine(backendId);
      const ses = await getSes(b, sid);
      const c = ses.metadata?.hqCopy;
      if (!c?.worktree) throw new Error("this chat isn't working on a copy");
      await call(b, "DELETE", "/worktree", { projectID: c.projectID, directory: c.worktree, force: true }).catch((e) => log(`copy discard: ${e.message}`));
      await setMeta(b, sid, { hqCopy: { ...c, discarded: true }, hqAuto: false });
      return { ok: true };
    },
  };
}
