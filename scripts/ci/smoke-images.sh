#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
#
# Starts the built engine and web images the way an installation does and
# checks that they work together, catching what a successful `docker build`
# cannot: a migration missing from dist, a module or a plugin that fails to
# load in the runtime stage, an environment variable the image needs, a web
# that cannot reach the engine.
#
#   scripts/ci/smoke-images.sh <engine-image> <web-image>
#
# The web image must be built with --build-arg NEXT_PUBLIC_API_URL=http://engine:4000
# (its rewrites are fixed at build time). Everything runs on a private Docker
# network and is removed on exit; only the two HTTP ports are published, on
# 127.0.0.1.
set -euo pipefail

engine_image="$1"
web_image="$2"
id="polyant-smoke-$$"
net="$id"
engine_port="${SMOKE_ENGINE_PORT:-4000}"
web_port="${SMOKE_WEB_PORT:-3000}"

# Test-only secrets: they protect a database that lives for one minute.
auth_secret="smoke-auth-secret-at-least-32-characters-long"
internal_secret="smoke-internal-credentials-verify-secret"
encryption_key="0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
database_url="postgresql://polyant:smoke@db:5432/polyant"

cleanup() {
  docker rm -f "$id-web" "$id-engine" "$id-db" >/dev/null 2>&1 || true
  docker network rm "$net" >/dev/null 2>&1 || true
}
trap cleanup EXIT

fail() {
  echo "::error::$1" >&2
  for c in engine web; do
    if docker inspect "$id-$c" >/dev/null 2>&1; then
      echo "----- $c logs -----" >&2
      docker logs --tail 200 "$id-$c" >&2 || true
    fi
  done
  exit 1
}

# wait_http <url> <seconds> <container>: until the URL answers with any HTTP status.
wait_http() {
  local url="$1" seconds="$2" container="$3"
  for _ in $(seq 1 "$seconds"); do
    if curl -s -o /dev/null "$url"; then return 0; fi
    if [ "$(docker inspect -f '{{.State.Running}}' "$id-$container" 2>/dev/null)" != "true" ]; then
      fail "the $container container stopped before answering $url"
    fi
    sleep 1
  done
  fail "$url did not answer within ${seconds}s"
}

docker network create "$net" >/dev/null

docker run -d --name "$id-db" --network "$net" --network-alias db \
  -e POSTGRES_USER=polyant -e POSTGRES_PASSWORD=smoke -e POSTGRES_DB=polyant \
  pgvector/pgvector:pg16 >/dev/null
for _ in $(seq 1 60); do
  docker exec "$id-db" pg_isready -U polyant -d polyant >/dev/null 2>&1 && break
  sleep 1
done
docker exec "$id-db" pg_isready -U polyant -d polyant >/dev/null || fail "PostgreSQL did not start"

echo "Starting the engine image (it migrates the empty database first)..."
docker run -d --name "$id-engine" --network "$net" --network-alias engine \
  -p "127.0.0.1:${engine_port}:4000" \
  -e DATABASE_URL="$database_url" -e API_PORT=4000 \
  -e AUTH_SECRET="$auth_secret" -e AUTH_INTERNAL_SECRET="$internal_secret" \
  -e ENCRYPTION_KEY="$encryption_key" \
  "$engine_image" >/dev/null
wait_http "http://127.0.0.1:${engine_port}/health" 180 engine
health="$(curl -s "http://127.0.0.1:${engine_port}/health")"
echo "$health" | grep -q '"status":"ok"' || fail "engine /health did not report ok: $health"
# Every migration the image ships is recorded as applied: "Migrations applied
# successfully" is printed even when drizzle skipped them, and a build that
# drops one from dist boots on a partial schema.
shipped="$(docker exec "$id-engine" node -p 'require("./packages/engine/dist/database/migrations/meta/_journal.json").entries.length')"
applied="$(docker exec "$id-db" psql -U polyant -d polyant -tAc 'SELECT count(*) FROM drizzle.__drizzle_migrations')"
[ -n "$shipped" ] && [ "$shipped" -gt 0 ] || fail "the image ships no migration journal"
[ "$applied" = "$shipped" ] || fail "the database records $applied migrations, the image ships $shipped"
echo "Engine healthy, $applied of $shipped migrations applied."

echo "Starting the web image..."
docker run -d --name "$id-web" --network "$net" \
  -p "127.0.0.1:${web_port}:3000" \
  -e DATABASE_URL="$database_url" \
  -e AUTH_SECRET="$auth_secret" -e AUTH_INTERNAL_SECRET="$internal_secret" \
  -e AUTH_URL="http://127.0.0.1:${web_port}" -e AUTH_TRUST_HOST=true \
  -e INTERNAL_ENGINE_URL=http://engine:4000 \
  "$web_image" >/dev/null
wait_http "http://127.0.0.1:${web_port}/login" 120 web
login="$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:${web_port}/login")"
[ "$login" = "200" ] || fail "web /login answered $login"

# Through the web's rewrite to the engine: without a session the engine itself
# refuses (401). A 404 or a 5xx means the web does not reach the engine.
proxied="$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:${web_port}/api/instances")"
[ "$proxied" = "401" ] || fail "web /api/instances answered $proxied instead of the engine's 401"

echo "Smoke test passed: migrations applied, engine healthy, web serving and reaching the engine."
