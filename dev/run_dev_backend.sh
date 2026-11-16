#!/bin/sh
# Start the mock model (:4299) and an isolated OpenCode 2.x server (:4298, user opencode, password "dev", localhost only).
cd "$(dirname "$0")"
pkill -f '[m]ock_model.py' 2>/dev/null
python3 mock_model.py mock.log &
export XDG_CONFIG_HOME="$PWD/xdg/config" XDG_DATA_HOME="$PWD/xdg/data" XDG_STATE_HOME="$PWD/xdg/state" XDG_CACHE_HOME="$PWD/xdg/cache"
export OPENCODE_SERVER_PASSWORD=dev  # dev only, localhost only
exec "${OPENCODE_BIN:-opencode}" serve --hostname 127.0.0.1 --port 4298
