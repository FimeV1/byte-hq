#!/bin/sh
# Throwaway git fixtures for the Settings > Git dev test. Everything lives in dev/throwaway/
# (git-ignored): a repo with no remote, ahead, behind, both at once, a GitHub remote
# (credentials in the URL, to test the stripping) pointing at a public octocat repo, a bare repo
# as a local "remote" (so Check login can succeed and fail without touching GitHub), and a clone
# whose origin is an https URL that refuses connections (Check login: fails, without hanging).
# The "not a git repository" case needs a folder that is NOT inside any repo, so it is made in the
# system temp folder (a folder inside this checkout would sit in HQ's own repo).
# Run it, then add one project per folder to dev/projects.dev.json (machine "dev").
set -e
A="$(cd "$(dirname "$0")/throwaway" && pwd)"
cd "$A"
rm -rf plain-dir repo-noremote remote-ahead remote-behind remote-both ahead behind both clean ghpub bare-remote linked broken-login scratch

# a git repo, no remote, one uncommitted (untracked) file
git init -q -b main repo-noremote
(cd repo-noremote && git config user.email dev@example.com && git config user.name Dev && \
  echo s > s.txt && git add -A && git commit -qm seed && echo untracked > untracked.txt)

# remotes, seeded from the noremote repo (a plain clone works fine as a remote)
for R in remote-ahead remote-behind remote-both; do git clone -q --no-local repo-noremote "$R"; done

# ahead: clone + one local commit (ahead 1, behind 0)
git clone -q --no-local remote-ahead ahead
(cd ahead && git config user.email dev@example.com && git config user.name Dev && \
  echo a > a.txt && git add -A && git commit -qm local)

# behind: clone, let the remote advance, fetch (so the last fetched state is behind 1)
git clone -q --no-local remote-behind behind
git --git-dir=remote-behind/.git --work-tree=remote-behind/.git commit -q --allow-empty -m "remote commit"
(cd behind && git fetch -q)

# both: clone, let the remote advance, one local commit, fetch (ahead 1, behind 1); plus a modified file
git clone -q --no-local remote-both both
git --git-dir=remote-both/.git --work-tree=remote-both/.git commit -q --allow-empty -m "remote commit"
(cd both && git config user.email dev@example.com && git config user.name Dev && \
  echo b > b.txt && git add -A && git commit -qm local && git fetch -q && echo c >> b.txt)

# clean: a clone of a quiet remote — in sync, no uncommitted files (no problems at all)
git clone -q --no-local remote-ahead clean

# github: a GitHub remote (with credentials in the URL) at a known-public octocat repo
git clone -q --no-local repo-noremote ghpub
(cd ghpub && git config user.email dev@example.com && git config user.name Dev && \
  git remote set-url origin "https://devuser:fakepass123@github.com/octocat/Hello-World.git")

# bare-remote: a local bare repo acting as a remote (offline, no GitHub), with a clone in sync with it
git init -q --bare -b main bare-remote
git clone -q bare-remote linked
(cd linked && git config user.email dev@example.com && git config user.name Dev && \
  echo l > l.txt && git add -A && git commit -qm seed && git push -q origin main)

# broken-login: a clone whose origin is an https URL that refuses connections (port 9)
git clone -q bare-remote broken-login
(cd broken-login && git config user.email dev@example.com && git config user.name Dev && \
  git remote set-url origin "https://127.0.0.1:9/some/repo.git")

# not a git repository: a plain folder outside every repo
T="$TMPDIR/hq-git-plain"
rm -rf "$T" && mkdir -p "$T" && echo hi > "$T/hi.txt"

for d in repo-noremote ahead behind both clean ghpub linked broken-login; do
  printf "%-14s " "$d:"; (cd "$d" && git status -sb 2>&1 | head -1)
done
printf "%-14s " "plain-dir:"; echo "$T (not in any repo)"
