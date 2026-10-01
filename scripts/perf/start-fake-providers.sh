#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# (Re)starts the fake model provider and the fake MCP server as background
# processes. Their FAKE_* / MCP_* settings pass through from the environment,
# so a test switches the model's behaviour by restarting it, e.g.:
#   FAKE_TOOLS=searchKnowledge FAKE_TOOL_ARGS='{"searchKnowledge":{"query":"orari"}}' ./start-fake-providers.sh
set -euo pipefail
source "$(dirname "$0")/env.sh"
mkdir -p "$WORK_DIR"

for name in fake-llm fake-mcp; do
  pidfile="$WORK_DIR/$name.pid"
  if [ -f "$pidfile" ]; then kill "$(cat "$pidfile")" 2>/dev/null || true; rm -f "$pidfile"; fi
done
sleep 0.5

FAKE_PORT=$FAKE_LLM_PORT nohup node "$PERF_DIR/fake-llm.mjs" > "$WORK_DIR/fake-llm.log" 2>&1 &
echo $! > "$WORK_DIR/fake-llm.pid"
MCP_PORT=$FAKE_MCP_PORT nohup node "$PERF_DIR/fake-mcp.mjs" > "$WORK_DIR/fake-mcp.log" 2>&1 &
echo $! > "$WORK_DIR/fake-mcp.pid"
sleep 0.5
cat "$WORK_DIR/fake-llm.log" "$WORK_DIR/fake-mcp.log"
