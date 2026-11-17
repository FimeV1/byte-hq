#!/bin/sh
# hq-guard
# HQ's pre-push guard for public repos. Installed by "Install push guard" in
# Settings > Git. Plain POSIX sh only, no bashisms: git runs the hook with /bin/sh
# on Mac and Linux, and Git for Windows runs it with its own sh, so the same file
# works everywhere.
#
# It blocks a push that (1) force-pushes or deletes a branch, (2) adds or changes
# a file that looks like a secret, or (3) adds or enlarges a file over 50 MB. A
# key is blocked even when it is added in one commit of the push and deleted in a
# later one: the lines every pushed commit ADDS are scanned too. It scans only
# what the push adds, so an incremental push stays fast even on a big repo (the
# first push of a big repo scans everything the push brings and can take a
# while), and it never prints a secret it finds -- only the file name, the
# commit, and the line number.
#
# git feeds the hook, on stdin, one line per ref it would push:
#   local-ref  local-sha  remote-ref  remote-sha

MAX_BYTES="52428800"         # 50 MB: a huge file must not ride in on a public repo
# A ref's hash length depends on the repo's object format (SHA-1 or SHA-256), so
# both the "no such ref" zeros and the empty tree ("nothing on the remote yet")
# are derived from the repo itself rather than hard-coded. `git mktree` with no
# entries prints the empty tree's hash and costs one small object; the SHA-1 hash
# is the fallback if mktree is unavailable.
EMPTY="$(git mktree </dev/null 2>/dev/null)"
[ -n "$EMPTY" ] || EMPTY="4b825dc642cb6eb9a060e54bf8d69288fbee4904"
ZERO="$(printf '%*s' "${#EMPTY}" '' | tr ' ' '0')"

# API-key-looking strings and a private-key block, in any file. Used by both the
# tip scan in bad_file and the per-commit added-lines scan at the bottom, so it
# lives here rather than in either one.
key_re='sk-[A-Za-z0-9_]{16,}|ghp_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{16,}|AKIA[0-9A-Z]{16}|xox[bp]-[A-Za-z0-9-]+|-----BEGIN [A-Za-z0-9 ]*PRIVATE KEY-----'

# Report a block and make git abort the push.
fail() {
	printf 'HQ guard: push blocked: %s\n' "$1"
	printf 'HQ guard: to proceed, remove the problem and push again. git push --no-verify skips this guard, but do not use it for a public repo.\n'
	exit 1
}

# Look at one pushed file's final content and flag a secret.
# Sets FAIL=1 and REASON when the file is bad. REASON names only the file and the
# offending line number(s) -- never the value -- so a leak can't leak again.
bad_file() {
	file="$1"
	rev="$2"
	base="${file##*/}"

	# A ".env" or ".env.<name>" file is a problem on its own.
	case "$base" in
		.env | .env.*)
			FAIL=1
			REASON="a file named $base was added (a dotenv-style secret); keep credentials out of the repo"
			return
			;;
	esac

	# The file's content at the pushed tip, read once.
	content="$(git show "$rev:$file" 2>/dev/null)"
	[ -n "$content" ] || return 0

	# A match is detected but only its line NUMBER is reported: grep -nE gives
	# "N:text" and cut keeps just the "N", so the value never leaves this shell.
	lns="$(printf '%s\n' "$content" | grep -nE "$key_re" 2>/dev/null | cut -d: -f1 | grep -E '^[0-9]+$' | tr '\n' ' ' | sed 's/ *$//')"
	if [ -n "$lns" ]; then
		FAIL=1
		REASON="a secret-looking value is in $file (on line(s) $lns); remove it and rewrite history before pushing"
		return
	fi

	# In config-shaped files, a "key = value" line (a password/secret/token...)
	# leaks a credential. Only these file types are checked, so normal code stays clean.
	case "$base" in
		*.ini | *.cfg | *.conf | *.config | *.yaml | *.yml | *.toml | *.properties | *.rc | *.xml | *.plist | .gitconfig)
			cfg_re='(^|[^[:alnum:]_])(password|passwd|secret|secret_key|token|api[_-]?key|access[_-]?token|auth)[[:space:]]*=[[:space:]]*[^[:space:]]'
			lns="$(printf '%s\n' "$content" | grep -inE "$cfg_re" 2>/dev/null | cut -d: -f1 | grep -E '^[0-9]+$' | tr '\n' ' ' | sed 's/ *$//')"
			if [ -n "$lns" ]; then
				FAIL=1
				REASON="a credential with a value (a password/secret/token assignment) is in config file $file (on line(s) $lns); use a secret manager instead"
				return
			fi
			;;
	esac
	return 0
}

# One line per ref to push.
while IFS= read -r line; do
	[ -n "$line" ] || continue
	IFS=' ' set -- $line
	lref="${1-}"; lsha="${2-}"; rref="${3-}"; rsha="${4-0}"

	# 1) Deleting a branch is not allowed for a public repo.
	if [ "$lsha" = "$ZERO" ]; then
		fail "deleting the branch $rref"
	fi

	# 2) force-push / non-fast-forward: what is on the remote must already be an
	#    ancestor of what we are pushing. A brand-new ref (remote sha all zero) is
	#    the first push, and it is allowed.
	if [ "$rsha" != "$ZERO" ]; then
		if ! git merge-base --is-ancestor "$rsha" "$lsha" 2>/dev/null; then
			fail "force-pushing $rref (a non-fast-forward that would rewrite remote history)"
		fi
	fi

	# 3) The files the push would add or change. A normal push is the range
	#    remote..local. A new ref (a new branch or tag) is the commits it adds
	#    that the remote does not already have: the first of those, diffed
	#    against its parent. A new tag pointing at a commit the remote already
	#    has adds no commits at all, so there is nothing to scan and the push
	#    goes straight through -- a tag must not re-scan the whole tree.
	if [ "$rsha" = "$ZERO" ]; then
		first="$(git rev-list --reverse "$lsha" --not --remotes 2>/dev/null | head -n 1)"
		if [ -z "$first" ]; then
			continue
		fi
		base="$(git rev-parse --verify --quiet "$first^" 2>/dev/null)" || base="$EMPTY"
	else
		base="$rsha"
	fi
	# quotepath=false: file names must come back raw, not C-quoted, or the
	# git show/cat-file calls below can't find a name like "café.bin".
	# The filter keeps Added, Modified and Renamed: a rename is, from the
	# remote's point of view, an add of the new name, so `git mv .env prod.env`
	# has to be scanned under its new name (R entries are dropped without it).
	names="$(git -c core.quotepath=false diff --name-only --diff-filter=AMR "$base" "$lsha" 2>/dev/null)"
	# The lines the push ADDS, commit by commit. The tip scan above only sees
	# files that survive to the tip, so a key added in one commit of the push
	# and deleted in a later one would reach the remote's history unscanned.
	# For a new ref, only the commits not already on the remote.
	if [ "$rsha" = "$ZERO" ]; then
		added="$(git log -p --no-renames --format=commit:%h "$lsha" --not --remotes 2>/dev/null)"
	else
		added="$(git log -p --no-renames --format=commit:%h "$rsha..$lsha" 2>/dev/null)"
	fi

	# 4) Check every pushed file: its size, then (if small enough to be text) its
	#    contents. A while/read fed by a heredoc -- not a pipe -- so a block in the
	#    loop can abort the whole push (in a pipe, fail's exit code would die with
	#    the subshell). The heredoc delimiter is unquoted on purpose: $names is
	#    the only expansion in it, and a shell never re-expands the *value* of a
	#    variable, so a file named "$(reboot)" is read as a literal name, not run.
	#    (File names containing newlines would confuse the line-based loop; git
	#    allows them, but no sane repo pushes them.)
	while IFS= read -r name; do
		[ -n "$name" ] || continue

		# Size: block anything the push would add or enlarge past 50 MB.
		size="$(git cat-file -s "$lsha:$name" 2>/dev/null)"
		case "$size" in
			'' | *[!0-9]*)
				size=0
				;;
		esac
		if [ "$size" -gt "$MAX_BYTES" ]; then
			fail "$name is about $((size / 1048576)) MB (over the 50 MB limit)"
		fi

		# Contents: a secret-looking value or a .env file.
		FAIL=0; REASON=""
		bad_file "$name" "$lsha"
		if [ "${FAIL}" = "1" ]; then
			fail "$REASON"
		fi
	done <<END
$names
END

	# 5) The lines added by every commit of the push (step 3's names only see
	#    the tip). The awk sees "commit:<sha>" lines, "diff --git" boundaries and
	#    "+++ b/<path>" file headers; an added line is the one after a "+", so
	#    headers (which start "+++ b/") are skipped. Only the key pattern is
	#    matched here, and the report names the short commit and the file --
	#    never the value. (The config-file password/secret/token pattern is not
	#    repeated here: its values belong to config files, and those are caught
	#    by the tip scan unless someone deletes them again, which this check's
	#    key pattern still covers.)
	hit="$(printf '%s\n' "$added" | awk -v re="$key_re" '
		/^commit:/ { commit = substr($0, 8) }
		/^diff --git / { file = ""; next }
		# The + must be escaped: unescaped, awk treats them as quantifiers and
		# the rule silently never matches (this is where file names die).
		/^\+\+\+ b\// { file = substr($0, 7); next }
		/^\+/ {
			if (file == "" || commit == "") next
			if (substr($0, 2) ~ re) { print commit " " file; exit }
		}
	' 2>/dev/null)"
	if [ -n "$hit" ]; then
		fail "a secret-looking value was added in commit ${hit%% *} to ${hit#* } and is still in the push (it may be deleted again before the tip, but the remote would keep it in history); remove it from every commit and push again"
	fi
done
