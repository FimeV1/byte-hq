#!/bin/sh
# Start an OpenCode server for HQ on this computer, in the background: http://127.0.0.1:${OPENCODE_PORT:-4096}.
# Its password lives in ~/.config/hq-app/opencode.env (readable only by you), made on the first run; HQ's setup
# needs it once. Log: ~/hq-opencode.log. Run it again after a restart (README › Keep it running).
#   OPENCODE_PORT=4097 ./run_opencode.sh     another port
#   HQ_OPENCODE_BIN=/path/to/opencode        a specific OpenCode 2 binary
set -eu
ENV_FILE="${HQ_OPENCODE_ENV:-$HOME/.config/hq-app/opencode.env}"
PORT="${OPENCODE_PORT:-4096}"
LOG="${HQ_OPENCODE_LOG:-$HOME/hq-opencode.log}"

OC="${HQ_OPENCODE_BIN:-}"
if [ -z "$OC" ]; then
  for c in "$(command -v opencode 2>/dev/null || true)" "$HOME/.opencode/bin/opencode"; do
    [ -n "$c" ] && [ -x "$c" ] || continue
    case "$("$c" --version 2>/dev/null)" in *v2.*|2.*) OC="$c"; break ;; esac
  done
fi
[ -n "$OC" ] || { echo "OpenCode 2 isn't installed. Install it with: curl -fsSL https://opencode.ai/v2/install | bash" >&2; exit 1; }

if [ ! -s "$ENV_FILE" ]; then
  mkdir -p "$(dirname "$ENV_FILE")"
  pw=$(LC_ALL=C tr -dc 'A-Za-z0-9' < /dev/urandom | head -c 24)
  (umask 077; printf 'OPENCODE_SERVER_PASSWORD=%s\n' "$pw" > "$ENV_FILE")
fi
chmod 600 "$ENV_FILE"
PW=$(sed -n 's/^OPENCODE_SERVER_PASSWORD=//p' "$ENV_FILE" | head -n 1)
[ -n "$PW" ] || { echo "No password in $ENV_FILE: delete the file and run this again." >&2; exit 1; }

# 200 = an OpenCode server that knows this password; 401 = something else is there.
status() { curl -s -o /dev/null -w '%{http_code}' -m 3 -u "opencode:$PW" "http://127.0.0.1:$PORT/api/info" 2>/dev/null || true; }
case "$(status)" in
  200) echo "OpenCode is already running on http://127.0.0.1:$PORT"; exit 0 ;;
  000) ;;
  *) echo "Port $PORT is taken by another program (or an OpenCode server with another password). Stop it, or use OPENCODE_PORT=<port> $0" >&2; exit 1 ;;
esac

# The password goes through the environment, never the command line (other users can read command lines).
OPENCODE_SERVER_PASSWORD="$PW" nohup "$OC" serve --hostname 127.0.0.1 --port "$PORT" >> "$LOG" 2>&1 &
i=0
while [ "$i" -lt 30 ]; do
  sleep 1; i=$((i + 1))
  [ "$(status)" = 200 ] && { echo "OpenCode $("$OC" --version 2>/dev/null | sed 's/^opencode //') is running on http://127.0.0.1:$PORT (log: $LOG)"; exit 0; }
done
echo "OpenCode didn't start within 30 seconds. See $LOG" >&2
exit 1
