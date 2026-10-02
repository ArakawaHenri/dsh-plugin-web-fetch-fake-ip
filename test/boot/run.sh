#!/usr/bin/env bash
# Boot the real DeepSeek Harness three ways in a throwaway $DSH_HOME and report
# what ctx.web.fetch() does in each. Nothing under ~/.dsh is touched.
#
#   ./run.sh                 # all three profiles
#   DSH_APP=/path/to.app ./run.sh
#
# Requires the dsh desktop app to be installed (it supplies the Node runtime,
# the CLI inside app.asar, and the harness packages the plugin imports).
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN="$(cd "$HERE/../.." && pwd)"
APP="${DSH_APP:-/Applications/DeepSeek Harness.app}"
NODE="$APP/Contents/Resources/runtime/bin/node"
CLI="$APP/Contents/Resources/app.asar/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js"
WORK="${WORK:-$HERE/.boot-tmp}"
PORT="${PORT:-39099}"
TIMEOUT_S="${TIMEOUT_S:-45}"

# The CLI lives INSIDE app.asar, which only the Electron-provided Node can read.
for required in "$NODE" "$APP/Contents/Resources/app.asar"; do
  [ -e "$required" ] || { echo "missing $required (set DSH_APP)" >&2; exit 2; }
done
export DSH_DESKTOP_NODE_EXECUTABLE="$APP/Contents/MacOS/DeepSeek Harness"

# A loopback target: only mode off may reach it.
mkdir -p "$WORK"
python3 -m http.server "$PORT" --bind 127.0.0.1 > "$WORK/server.log" 2>&1 &
SERVER_PID=$!
trap 'kill $SERVER_PID 2>/dev/null' EXIT
sleep 1

node "$HERE/mkhomes.mjs" "$WORK" "$PLUGIN" "$HERE/probe" "$PORT" || exit 1

run() {
  local home="$1" log="$WORK/run-$1.log" waited=0
  DSH_HOME="$WORK/homes/$home" "$NODE" "$CLI" --profile web --no-open --port 0 > "$log" 2>&1 &
  local pid=$!
  while kill -0 "$pid" 2>/dev/null && [ "$waited" -lt "$TIMEOUT_S" ]; do sleep 1; waited=$((waited + 1)); done
  kill "$pid" 2>/dev/null
  wait "$pid" 2>/dev/null
  echo "===== $home (exit after ${waited}s) ====="
  grep -E '^\[probe\]' "$log" || { echo "no probe output; last lines of $log:"; tail -5 "$log"; }
}

echo "harness : $APP"
echo "plugin  : $PLUGIN"
echo "work    : $WORK"
echo
run baseline
run fakeip
run off
echo
echo "expected: baseline -> both WEB_BLOCKED_URL; fakeip -> example.com OK, 127.0.0.1 WEB_BLOCKED_URL; off -> both OK"
