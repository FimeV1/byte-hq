#!/bin/sh
# Run HQ with its config (~/.config/hq-app/config.json, or $HQ_CONFIG) until it is stopped or the computer restarts.
cd "$(dirname "$0")" || exit 1
[ -f hq.pid ] && kill "$(cat hq.pid)" 2>/dev/null; sleep 0.5
nohup node server.mjs >> "${HQ_LOG:-$HOME/hq-app.log}" 2>&1 &
echo $! > hq.pid
