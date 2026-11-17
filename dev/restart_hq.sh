#!/bin/sh
# Rebuild the UI and restart the dev HQ server (http://127.0.0.1:4112).
cd "$(dirname "$0")/.." || exit 1
npx vite build 2>&1 | grep -E "built|rror"
# Stop only our own previous instance: whatever listens on the dev port 4112. Not by pid file: a stale pid can belong
# to another process by now (it once killed the shell that ran this script).
old=$(lsof -ti tcp:4112 -sTCP:LISTEN); [ -n "$old" ] && kill $old 2>/dev/null; sleep 0.5
HQ_CONFIG=dev/config.dev.json nohup node server.mjs > dev/hq.log 2>&1 &
echo $! > dev/hq.pid
sleep 1; cat dev/hq.log
