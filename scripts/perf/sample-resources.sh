#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Samples resource use every 2s until killed, as CSV on stdout: engine and
# Postgres CPU% (of one core) and memory, Postgres sessions that are active,
# idle in a transaction or waiting on a lock, and /health latency, which
# rises when the engine's event loop is blocked.
set -uo pipefail
source "$(dirname "$0")/env.sh"
echo "t,engine_cpu,engine_mem_mib,pg_cpu,pg_active,pg_idle_tx,pg_lock_wait,health_ms"
while :; do
  t=$(date +%s)
  stats=$(docker stats --no-stream --format '{{.Name}} {{.CPUPerc}} {{.MemUsage}}' "$ENGINE_CONTAINER" "$PG_CONTAINER")
  ecpu=$(echo "$stats" | awk -v n="$ENGINE_CONTAINER" '$1==n{gsub("%","",$2);print $2}')
  emem=$(echo "$stats" | awk -v n="$ENGINE_CONTAINER" '$1==n{v=$3; if (v ~ /GiB/) {gsub("GiB","",v); v=v*1024} else gsub("MiB","",v); print v}')
  pcpu=$(echo "$stats" | awk -v n="$PG_CONTAINER" '$1==n{gsub("%","",$2);print $2}')
  conns=$(psql_perf -Atc "SELECT count(*) FILTER (WHERE state = 'active'), count(*) FILTER (WHERE state LIKE 'idle in%'),
    count(*) FILTER (WHERE wait_event_type = 'Lock') FROM pg_stat_activity WHERE datname = '$PG_DB' AND pid <> pg_backend_pid()" | tr '|' ',')
  h=$(curl -s -o /dev/null -m 10 -w '%{time_total}' "localhost:$ENGINE_PORT/health" | awk '{printf "%d", $1*1000}')
  echo "$t,$ecpu,$emem,$pcpu,$conns,$h"
  sleep 2
done
