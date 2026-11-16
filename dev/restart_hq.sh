#!/bin/sh
# Rebuild the UI and restart the dev HQ server (http://127.0.0.1:4112).
cd "$(dirname "$0")/.." || exit 1
npx vite build 2>&1 | grep -E "built|rror"
# Stop only our own previous instance (by pid file), never another app's server.mjs.
[ -f dev/hq.pid ] && kill "$(cat dev/hq.pid)" 2>/dev/null; sleep 0.5
HQ_CONFIG=dev/config.dev.json nohup node server.mjs > dev/hq.log 2>&1 &
echo $! > dev/hq.pid
sleep 1; cat dev/hq.log
