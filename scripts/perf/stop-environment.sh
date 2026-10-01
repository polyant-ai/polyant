#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Removes every container and process the perf scripts started. Keeps .work/
# (results, sessions, settings); delete it by hand to start from nothing.
set -uo pipefail
source "$(dirname "$0")/env.sh"
docker rm -f "$PROXY_CONTAINER" "$WEB_CONTAINER" "$ENGINE_CONTAINER" "$PG_CONTAINER" >/dev/null 2>&1
docker network rm "$PERF_NETWORK" >/dev/null 2>&1
for name in fake-llm fake-mcp; do
  pidfile="$WORK_DIR/$name.pid"
  [ -f "$pidfile" ] && kill "$(cat "$pidfile")" 2>/dev/null
  rm -f "$pidfile"
done
echo "perf environment stopped"
