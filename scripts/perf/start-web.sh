#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Starts the production web build with the production limits, behind an nginx
# that routes like the ALB (nginx.conf mirrors infra/lib/constructs/
# compute-construct.ts): /api/auth/* to the web, the engine's prefixes to the
# engine, everything else to the web. Browser tests use :$PROXY_PORT.
set -euo pipefail
source "$(dirname "$0")/env.sh"
[ -f "$WORK_DIR/perf.env" ] || { echo "run prepare-environment.sh first" >&2; exit 1; }
set -a; source "$WORK_DIR/perf.env"; set +a

if ! docker image inspect "$WEB_IMAGE" >/dev/null 2>&1; then
  docker build -q -f "$REPO_DIR/Dockerfile.web" --build-arg NEXT_PUBLIC_API_URL="http://host.docker.internal:$ENGINE_PORT" \
    -t "$WEB_IMAGE" "$REPO_DIR"
fi
docker network create "$PERF_NETWORK" >/dev/null 2>&1 || true
docker rm -f "$WEB_CONTAINER" "$PROXY_CONTAINER" >/dev/null 2>&1 || true
docker run -d --name "$WEB_CONTAINER" --network "$PERF_NETWORK" --network-alias perf-web \
  --cpus "$WEB_CPUS" --memory "$WEB_MEMORY" \
  -e AUTH_SECRET="$AUTH_SECRET" -e AUTH_INTERNAL_SECRET="$AUTH_INTERNAL_SECRET" -e AUTH_TRUST_HOST=true \
  -e INTERNAL_ENGINE_URL="http://host.docker.internal:$ENGINE_PORT" "$WEB_IMAGE" >/dev/null
sed "s/host.docker.internal:4400/host.docker.internal:$ENGINE_PORT/" "$PERF_DIR/nginx.conf" > "$WORK_DIR/nginx.conf"
docker run -d --name "$PROXY_CONTAINER" --network "$PERF_NETWORK" -p "$PROXY_PORT:80" \
  -v "$WORK_DIR/nginx.conf:/etc/nginx/conf.d/default.conf:ro" nginx:alpine >/dev/null
for _ in $(seq 1 30); do curl -sf -o /dev/null "localhost:$PROXY_PORT/login" && break; sleep 2; done
echo "panel up on :$PROXY_PORT"
