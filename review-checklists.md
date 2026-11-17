# Review checklists: known ways around guards

Auto's reviews (`reviewPrompt` in auto.mjs) add a section of this file to the review of any change whose files or
added lines match its `when:` pattern (a case-insensitive regular expression). The reviewer must then list the ways
someone could get past the change, trace each one in the code, and ask for a real test of any it can't rule out.

Read on every review, so an edit here applies at once (no restart). Set `auto.checklists` in the config to use your
own copy. **Add a line whenever a review, a test or an incident finds a hole** (date it): models are bad at inventing
these cases and good at following a list. Changes to `.md` and `.txt` files never trigger a section.

## Git hooks and pushes
when: pre-push|hooks/|core\.hooksPath|git push|--no-verify
- Every commit in the push, not just the final files: a key added in one commit and deleted in a later one is still in the history that gets pushed (2026-11-17).
- Renames and copies: `git diff --diff-filter=AM` skips them, so a renamed file that gains a key passes. Use `--no-renames` (2026-11-17).
- `core.hooksPath` (Husky and similar) and worktrees (`.git` is a file there): `.git/hooks/pre-push` is then ignored or wrong. Find the real path with `git rev-parse --git-path hooks/pre-push` (2026-11-17).
- A new branch (remote hash all zeros: no base to diff against), a branch or tag deletion (local hash all zeros), tags.
- SHA-256 repos: hashes are 64 characters, not 40; don't hard-code the zero hash or the empty tree.
- File names with spaces, unicode (`core.quotepath`), `$(...)` or backticks, newlines.
- POSIX hooks must be executable or git silently skips them; a status that says "guarded" must check that.
- `git push --no-verify` always skips a hook: a hook is a safety net, never the only protection.

## Secret scanning and leak checks
when: secret|api[_-]?key|credential|leak|private key|ghp_|github_pat|\bsk-|\.env\b
- A block, log line, error message or test output must never print the secret's value; only the file and line.
- Allow-lists can silence the whole checker: a `/` in an allow entry broke a `sed s/.../` and every check passed (2026-11-16). Keep a self-test that a known secret IS caught.
- Exit codes: `checker | tail` returns tail's status, so a failed check looks clean (2026-11-17). Use `set -o pipefail`, or don't pipe the checker.
- `.env` and `.env.<name>` files, private-key blocks, and keys inside config files (`*.yaml`, `*.toml`, `.gitconfig`).
- Binary files and very large files: skipped, or slow?

## Shell scripts and commands
when: \.sh\b|#!/bin/sh|#!/bin/bash|\bsed\b|\bssh\b|heredoc|<<
- Pipes hide failures (see above); `set -e` doesn't catch a failure inside a pipe or `$(...)`.
- An unquoted heredoc (`<<EOF`) runs `$(...)` and backticks in its text; over ssh that happens on the far side (2026-11-17).
- Unquoted `$var` splits on spaces and expands `*`; `IFS=... set -- $x` keeps the new IFS afterwards in POSIX sh.
- `sed` with a delimiter that can appear in the data; `grep` patterns built from user text.
- A command written into a script file and run with `sh script.sh` bypasses per-command permission checks: check what the script does.

## Permissions, paths and folders
when: external_directory|realpath|path\.resolve|"allow"|"deny"|effect: "(allow|deny)"|outside (the|its) folder|permission rules?
- `..`, symlinks and `cd ..` chains can leave a folder that a string check thinks you're in.
- Prefix checks: `/a/bc` starts with `/a/b`; compare with a trailing separator.
- In OpenCode permission rules the LAST matching rule wins.
- macOS and Windows paths are case-insensitive; Windows uses backslashes and drive letters.
- A file written by a shell command (`>`, `cp`, `sed -i`) skips the edit tool, so HQ can't show, review or undo it.

## Logins, keys and auth
when: timingSafeEqual|sameString|hmac|set-cookie|signup|bearer|checkAuth|auth\.password|x-api-key
- Compare secrets in constant time; never log them, or echo them back in an error.
- A missing or empty header must fail closed, not count as the owner (unless it's a deliberate local-only rule).
- Rate limits and lockouts per key and per IP; what happens on the 1000th wrong try?
