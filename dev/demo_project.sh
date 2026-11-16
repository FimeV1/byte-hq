#!/bin/sh
# A small git project for screenshots and demos: ask HQ "Add retries to fetchJson" in a project chat on it.
# Usage: sh dev/demo_project.sh [folder]   (default: dev/project/demo-app)
DIR="${1:-$(dirname "$0")/project/demo-app}"
rm -rf "$DIR" && mkdir -p "$DIR/src" && cd "$DIR" || exit 1
cat > src/fetch.js <<'JS'
// Small helpers for talking to the API.
export async function fetchJson(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url} answered ${r.status}`);
  return r.json();
}
JS
printf '# demo-app\n\nA tiny app for trying HQ.\n' > README.md
git init -q && git add -A && git -c user.name=demo -c user.email=demo@example.com commit -qm "Start demo app"
echo "Demo project ready: $(pwd)"
