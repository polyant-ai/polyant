#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Starts (or restarts) the engine under test with the production task limits,
# pointed at the perf database and the fake model provider.
# Extra arguments go to `docker run`, e.g. -e NODE_OPTIONS=--cpu-prof.
#   THROTTLE_ENABLED=true   keep the rate limit on (default off: a load test
#                           would otherwise measure 429s)
#   ENGINE_IMAGE=<image>    test another build, e.g. one on a newer Node
set -euo pipefail
source "$(dirname "$0")/env.sh"

[ -f "$WORK_DIR/perf.env" ] || { echo "run prepare-environment.sh first" >&2; exit 1; }

docker rm -f "$ENGINE_CONTAINER" >/dev/null 2>&1 || true
docker run -d --name "$ENGINE_CONTAINER" \
  --cpus "$ENGINE_CPUS" --memory "$ENGINE_MEMORY" \
  --env-file "$WORK_DIR/perf.env" \
  -e DATABASE_URL="$PG_URL_DOCKER" -e API_PORT=4000 \
  -e THROTTLE_ENABLED="${THROTTLE_ENABLED:-false}" \
  -e OPENAI_BASE_URL="http://host.docker.internal:$FAKE_LLM_PORT/v1" \
  -p "$ENGINE_PORT:4000" "$@" "$ENGINE_IMAGE" >/dev/null
wait_for_engine
echo "engine up on :$ENGINE_PORT ($ENGINE_IMAGE, ${ENGINE_CPUS} vCPU, $ENGINE_MEMORY)"
