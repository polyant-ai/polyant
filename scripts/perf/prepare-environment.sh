#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Builds the whole load-test environment from scratch: a throwaway Postgres
# with pg_stat_statements, the engine image, migrations, the synthetic dataset,
# signed-in sessions, the fake providers, the engine, and model keys for the
# agents the load tests talk to. Safe to re-run: it starts over each time.
#   SCALE=full   (default) 200 orgs, ~1.8k agents, ~200k conversations, ~2M messages,
#                ~4.4 GB; about five minutes on a laptop
#   SCALE=small  5 orgs, a few hundred conversations: checks the scripts in seconds
#   KNOWLEDGE=0  skip the knowledge base seed (~1 GB with its vector index)
set -euo pipefail
source "$(dirname "$0")/env.sh"
SCALE=${SCALE:-full}
case "$SCALE" in
  full)  SEED_VARS=(-v orgs=200 -v big_convs=100000 -v small_convs=500 -v long_conv_msgs=20000 -v kb_div=1) ;;
  small) SEED_VARS=(-v orgs=5 -v big_convs=200 -v small_convs=20 -v long_conv_msgs=100 -v kb_div=100) ;;
  *) echo "SCALE must be full or small" >&2; exit 1 ;;
esac
for tool in docker node curl openssl; do
  command -v "$tool" >/dev/null || { echo "$tool is required" >&2; exit 1; }
done
[ -d "$REPO_DIR/node_modules" ] || { echo "run npm ci at the repo root first" >&2; exit 1; }
mkdir -p "$WORK_DIR/results"

echo "== settings"
if [ ! -f "$WORK_DIR/perf.env" ]; then
  cat > "$WORK_DIR/perf.env" <<EOF
ENCRYPTION_KEY=$(openssl rand -hex 32)
AUTH_SECRET=$(openssl rand -hex 32)
AUTH_INTERNAL_SECRET=$(openssl rand -hex 32)
NODE_ENV=production
EOF
fi
set -a; source "$WORK_DIR/perf.env"; set +a

echo "== engine image ($ENGINE_IMAGE)"
if ! docker image inspect "$ENGINE_IMAGE" >/dev/null 2>&1; then
  docker build -q -f "$REPO_DIR/Dockerfile.engine" -t "$ENGINE_IMAGE" "$REPO_DIR"
fi

echo "== postgres ($PG_CONTAINER on :$PG_PORT)"
docker rm -f "$PG_CONTAINER" "$ENGINE_CONTAINER" >/dev/null 2>&1 || true
# shm-size: parallel HNSW index builds need more than Docker's 64 MB default.
docker run -d --name "$PG_CONTAINER" --cpus "$PG_CPUS" --memory "$PG_MEMORY" --shm-size=1g \
  -e POSTGRES_USER=$PG_USER -e POSTGRES_PASSWORD=$PG_PASSWORD -e POSTGRES_DB=$PG_DB \
  -p "$PG_PORT:5432" pgvector/pgvector:pg16 \
  -c shared_preload_libraries=pg_stat_statements -c pg_stat_statements.track=all \
  -c max_connections=200 -c shared_buffers=512MB >/dev/null
for _ in $(seq 1 30); do docker exec "$PG_CONTAINER" pg_isready -U "$PG_USER" >/dev/null 2>&1 && break; sleep 1; done
sleep 2

echo "== migrations"
docker run --rm --env-file "$WORK_DIR/perf.env" -e DATABASE_URL="$PG_URL_DOCKER" \
  --entrypoint node "$ENGINE_IMAGE" packages/engine/dist/database/migrate.js | tail -1
psql_perf -qc "CREATE EXTENSION IF NOT EXISTS pg_stat_statements"

echo "== seed ($SCALE)"
for f in "$PERF_DIR"/sql/[0-9][0-9]-*.sql; do
  case "$f" in *knowledge*) [ "${KNOWLEDGE:-1}" = 1 ] || continue ;; esac
  echo "   $(basename "$f")"
  psql_perf -q "${SEED_VARS[@]}" < "$f"
done
psql_perf -Atc "SELECT u.id || E'\t' || u.email || E'\t' || coalesce(o.slug, '') || E'\t' || coalesce(o.id::text, '') FROM users u
  LEFT JOIN organization_memberships m ON m.user_id = u.id LEFT JOIN organizations o ON o.id = m.organization_id
  WHERE u.email LIKE 'perf-%' ORDER BY u.email" > "$WORK_DIR/users.tsv"
node "$PERF_DIR/mint-sessions.mjs" < "$WORK_DIR/users.tsv" > "$WORK_DIR/sessions.json"

# Agent lists the load tests pick from: <slug>|<org>|<workspace> per line.
agents_query="SELECT i.slug || '|' || o.slug || '|' || w.slug FROM instances i
  JOIN workspaces w ON w.id = i.workspace_id JOIN organizations o ON o.id = w.organization_id WHERE o.slug LIKE 'perf-org-%'"
psql_perf -Atc "$agents_query AND (o.slug = 'perf-org-1' OR (i.slug LIKE '%-a1' AND w.slug IN ('perf-ws-1', 'perf-ws-2'))) ORDER BY 1 LIMIT 100" > "$WORK_DIR/agents-100.tsv"
psql_perf -Atc "$agents_query ORDER BY md5(i.slug) LIMIT 1000" > "$WORK_DIR/agents-1000.tsv"
psql_perf -Atc "$agents_query AND i.knowledge_enabled ORDER BY 1" > "$WORK_DIR/agents-kb.tsv"
cp "$WORK_DIR/agents-100.tsv" "$WORK_DIR/agents.tsv"

echo "== fake providers and engine"
"$PERF_DIR/start-fake-providers.sh" >/dev/null
"$PERF_DIR/start-engine.sh"
sort -u "$WORK_DIR/agents-100.tsv" "$WORK_DIR/agents-1000.tsv" "$WORK_DIR/agents-kb.tsv" > "$WORK_DIR/agents-keyed.tsv"
node "$PERF_DIR/set-agent-keys.mjs" agents-keyed.tsv

echo "== snapshot"
psql_perf -qc "ANALYZE"
docker exec -e PGOPTIONS="-c client_min_messages=warning" "$PG_CONTAINER" psql -U "$PG_USER" -d postgres -qc "DROP DATABASE IF EXISTS perf_seeded"
docker stop "$ENGINE_CONTAINER" >/dev/null
docker exec "$PG_CONTAINER" psql -U "$PG_USER" -d postgres -qc "CREATE DATABASE perf_seeded TEMPLATE $PG_DB"
"$PERF_DIR/start-engine.sh" >/dev/null
psql_perf -Atc "SELECT 'ready: ' || (SELECT count(*) FROM instances) || ' agents, ' || (SELECT count(*) FROM conversations)
  || ' conversations, ' || (SELECT count(*) FROM conversation_messages) || ' messages, '
  || (SELECT count(*) FROM knowledge_chunks) || ' knowledge chunks, ' || pg_size_pretty(pg_database_size('$PG_DB'))"
