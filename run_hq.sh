#!/bin/sh
# Run HQ with its config (~/.config/hq-app/config.json, or $HQ_CONFIG) until it is stopped or the computer restarts.
cd "$(dirname "$0")" || exit 1
# Stop the previous HQ, but only if that pid is still HQ: a stale pid can belong to another program by now.
if [ -f hq.pid ]; then
  pid=$(cat hq.pid)
  ps -p "$pid" -o args= 2>/dev/null | grep -q "node server.mjs" && kill "$pid" 2>/dev/null
  sleep 0.5
fi
# HQ_DETACHED: keep running after this terminal closes (see server.mjs).
HQ_DETACHED=1 nohup node server.mjs >> "${HQ_LOG:-$HOME/hq-app.log}" 2>&1 &
echo $! > hq.pid
