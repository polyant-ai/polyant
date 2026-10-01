# SPDX-License-Identifier: AGPL-3.0-or-later
# Shared settings for the perf scripts. Sourced, not executed. Every value can
# be overridden from the environment.
PERF_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
REPO_DIR=$(cd "$PERF_DIR/../.." && pwd)
WORK_DIR="$PERF_DIR/.work"

PG_CONTAINER=${PG_CONTAINER:-polyant-perf-pg}
ENGINE_CONTAINER=${ENGINE_CONTAINER:-polyant-perf-engine}
WEB_CONTAINER=${WEB_CONTAINER:-polyant-perf-web}
PROXY_CONTAINER=${PROXY_CONTAINER:-polyant-perf-proxy}
PERF_NETWORK=${PERF_NETWORK:-polyant-perf}

ENGINE_IMAGE=${ENGINE_IMAGE:-polyant-perf-engine}
WEB_IMAGE=${WEB_IMAGE:-polyant-perf-web}

PG_PORT=${PG_PORT:-55432}
ENGINE_PORT=${ENGINE_PORT:-4400}
PROXY_PORT=${PROXY_PORT:-4480}
FAKE_LLM_PORT=${FAKE_LLM_PORT:-7070}
FAKE_MCP_PORT=${FAKE_MCP_PORT:-7171}

# Production task sizing (infra/config/_example.yaml): the engine container
# gets 768 CPU units / 1536 MiB, the web container 256 / 512.
ENGINE_CPUS=${ENGINE_CPUS:-0.75}
ENGINE_MEMORY=${ENGINE_MEMORY:-1536m}
WEB_CPUS=${WEB_CPUS:-0.25}
WEB_MEMORY=${WEB_MEMORY:-512m}
PG_CPUS=${PG_CPUS:-2}
PG_MEMORY=${PG_MEMORY:-2g}

# A throwaway local database: the credentials are not secrets.
PG_DB=perf
PG_USER=perf
PG_PASSWORD=perf
PG_URL_DOCKER="postgres://$PG_USER:$PG_PASSWORD@host.docker.internal:$PG_PORT/$PG_DB"

psql_perf() { docker exec -i "$PG_CONTAINER" psql -U "$PG_USER" -d "$PG_DB" "$@"; }

wait_for_engine() {
  for _ in $(seq 1 90); do
    curl -sf "localhost:$ENGINE_PORT/health" >/dev/null && return 0
    sleep 2
  done
  echo "engine did not become healthy on :$ENGINE_PORT" >&2
  docker logs --tail 30 "$ENGINE_CONTAINER" >&2
  return 1
}
