#!/usr/bin/env bash
# HQ installer for macOS and Linux:
#   curl -fsSL https://raw.githubusercontent.com/FimeV1/byte-hq/main/install.sh | bash
#
# 1. checks git and Node.js 22+ (it never installs those: they need your admin password)
# 2. installs OpenCode 2 if it's missing (asks before replacing OpenCode 1)
# 3. downloads HQ to ~/hq (HQ_DIR=… to choose), or updates it if it's already there
# 4. starts an OpenCode server on this computer (run_opencode.sh) and runs HQ's setup with its address and password
# 5. builds HQ and offers to start it
# Never uses sudo. Run it again any time to update.
set -euo pipefail

REPO="${HQ_REPO:-https://github.com/FimeV1/byte-hq.git}"
DIR="${HQ_DIR:-$HOME/hq}"
CONFIG="${HQ_CONFIG:-$HOME/.config/hq-app/config.json}"

say() { printf '%s\n' "$*"; }
step() { printf '\n\033[1m%s\033[0m\n' "$*"; }
die() { printf '\nHQ install stopped: %s\n' "$*" >&2; exit 1; }

# When piped from curl, this script IS standard input, so questions are read from the terminal instead.
if [ -t 0 ]; then TTY=/dev/stdin
elif (exec < /dev/tty) 2>/dev/null; then TTY=/dev/tty
else die "it needs a terminal to ask setup's questions. Download it and run: bash install.sh"
fi
yes_no() { # yes_no "question" default(y|n)
  local a def="${2:-y}"
  printf '%s %s ' "$1" "$([ "$def" = y ] && echo '[Y/n]' || echo '[y/N]')" >&2
  IFS= read -r a < "$TTY" || a=""
  a="${a:-$def}"
  case "$a" in [yY]*) return 0 ;; *) return 1 ;; esac
}
major_of() { "$1" --version 2>/dev/null | sed -n 's/^[^0-9]*\([0-9][0-9]*\)\..*/\1/p' | head -n 1; }

step "Checking this computer"
case "$(uname -s)" in
  Darwin|Linux) ;;
  *) die "this installer is for macOS and Linux (on Windows, use WSL or follow the README's steps)." ;;
esac
command -v git > /dev/null || die "git is missing. macOS: run 'xcode-select --install'. Linux: install it with your package manager (e.g. sudo apt install git)."
command -v node > /dev/null || die "Node.js is missing. Install Node.js 22 or newer from https://nodejs.org, then run this again."
command -v npm > /dev/null || die "npm is missing (it comes with Node.js from https://nodejs.org)."
NODE_MAJOR=$(node -p 'process.versions.node.split(".")[0]')
[ "$NODE_MAJOR" -ge 22 ] || die "HQ needs Node.js 22 or newer; this is $(node --version). Update it from https://nodejs.org."
command -v curl > /dev/null || die "curl is missing."
say "git, Node.js $(node --version) and curl: ok"

step "OpenCode"
OC=""
OLD=""
for c in "$(command -v opencode 2>/dev/null || true)" "$HOME/.opencode/bin/opencode"; do
  [ -n "$c" ] && [ -x "$c" ] || continue
  m=$(major_of "$c")
  if [ "${m:-0}" -ge 2 ]; then OC="$c"; break; fi
  [ -n "$OLD" ] || OLD="$c"
done
if [ -n "$OC" ]; then
  say "Found $("$OC" --version 2>/dev/null) at $OC"
else
  if [ -n "$OLD" ]; then
    say "Found $("$OLD" --version 2>/dev/null) at $OLD, but HQ needs OpenCode 2."
    say "Installing OpenCode 2 puts it in ~/.opencode/bin, replacing OpenCode 1 there if that's where it is."
    say "If you rely on your OpenCode 1 setup, read https://opencode.ai/v2/docs first."
    yes_no "Install OpenCode 2 now?" n || die "OpenCode 2 is needed. Install it yourself with: curl -fsSL https://opencode.ai/v2/install | bash"
  else
    say "OpenCode isn't installed: installing OpenCode 2 (https://opencode.ai/v2/install)."
  fi
  curl -fsSL https://opencode.ai/v2/install | bash
  OC="$HOME/.opencode/bin/opencode"
  m=$(major_of "$OC" 2>/dev/null || true)
  [ -x "$OC" ] && [ "${m:-0}" -ge 2 ] || die "OpenCode 2 didn't install. Try: curl -fsSL https://opencode.ai/v2/install | bash"
fi
export HQ_OPENCODE_BIN="$OC"

step "HQ"
if [ -d "$DIR/.git" ]; then
  case "$(git -C "$DIR" remote get-url origin 2>/dev/null)" in
    *byte-hq*|"$REPO") ;;
    *) die "$DIR is a different git repository. Choose another folder: HQ_DIR=~/somewhere bash install.sh" ;;
  esac
  [ -z "$(git -C "$DIR" status --porcelain --untracked-files=no)" ] || die "$DIR has local changes; commit or stash them, then run this again."
  say "Updating $DIR"
  git -C "$DIR" pull --ff-only || die "couldn't update $DIR (see git's message above). If you changed files there, move them aside and run this again."
elif [ -e "$DIR" ] && [ -n "$(ls -A "$DIR" 2>/dev/null)" ]; then
  die "$DIR already exists and isn't HQ. Choose another folder: HQ_DIR=~/somewhere bash install.sh"
else
  say "Downloading HQ to $DIR"
  git clone "$REPO" "$DIR"
fi
cd "$DIR"
npm ci --no-fund --no-audit

step "Starting an OpenCode server for HQ"
sh ./run_opencode.sh
OC_PORT="${OPENCODE_PORT:-4096}"
OC_ENV="${HQ_OPENCODE_ENV:-$HOME/.config/hq-app/opencode.env}"

step "Setup"
run_setup=1
if [ -f "$CONFIG" ]; then
  say "HQ is already set up ($CONFIG)."
  yes_no "Run setup again? (your current settings are backed up first)" n || run_setup=0
fi
if [ "$run_setup" = 1 ]; then
  say "Answer a few questions; pressing Enter takes the suggestion in [brackets]."
  # The server's address and password go to setup through the environment, so you don't have to type them.
  HQ_SETUP_OPENCODE_URL="http://127.0.0.1:$OC_PORT" \
  HQ_SETUP_OPENCODE_PASSWORD="$(sed -n 's/^OPENCODE_SERVER_PASSWORD=//p' "$OC_ENV" | head -n 1)" \
    npm run --silent setup < "$TTY"
  [ -f "$CONFIG" ] || die "setup didn't write a config. Run it again with: cd $DIR && npm run setup"
fi

step "Building"
npm run --silent build

URL=$(HQ_CONFIG_PATH="$CONFIG" node -e 'const c=JSON.parse(require("fs").readFileSync(process.env.HQ_CONFIG_PATH,"utf8"));const l=(c.listen||[{}])[0];console.log(`http://${l.host||"127.0.0.1"}:${l.port||4110}`)')
step "Done"
if yes_no "Start HQ now?" y; then
  sh ./run_hq.sh
  sleep 2
  say "HQ is running: open $URL and sign in (the login is the one from setup)."
else
  say "Start it later with: cd $DIR && ./run_hq.sh   then open $URL"
fi
say "Then: New Project, pick the folder of a git repository, and start a chat. Add your own models in Settings › Models."
say ""
say "After a restart, run both again:  cd $DIR && ./run_opencode.sh && ./run_hq.sh"
say "To start them with the computer, see the README's \"Keep it running\". Logs: ~/hq-opencode.log and ~/hq-app.log"
say "To update HQ later, run this installer again."
