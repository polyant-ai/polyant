#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Runs one k6 script with the resource sampler alongside, and stores under
# .work/results/<label>/: the k6 summary (k6.txt), every sample (k6.csv.gz),
# the sampler (sampler.csv), the costliest and the most frequent statements
# (top-queries.txt, top-calls.txt) and the engine's errors and warnings.
# Usage: run-load-test.sh <label> <script in k6/> [-e NAME=value ...]
set -euo pipefail
source "$(dirname "$0")/env.sh"
if [ $# -lt 2 ] || [ ! -f "$PERF_DIR/k6/$2" ]; then
  echo "usage: run-load-test.sh <label> <script in k6/> [-e NAME=value ...]" >&2
  exit 1
fi
LABEL=$1; SCRIPT=$2; shift 2
OUT="$WORK_DIR/results/$LABEL"
mkdir -p "$OUT"
since=$(date -u +%Y-%m-%dT%H:%M:%SZ)

psql_perf -qc "SELECT pg_stat_statements_reset()" >/dev/null
"$PERF_DIR/sample-resources.sh" > "$OUT/sampler.csv" 2>/dev/null &
SAMPLER=$!
trap 'kill $SAMPLER 2>/dev/null || true' EXIT

docker run --rm -v "$PERF_DIR":/perf -w /perf/k6 -e BASE="http://host.docker.internal:$ENGINE_PORT" "$@" grafana/k6:latest \
  run --quiet --out "csv=/perf/.work/results/$LABEL/k6.csv.gz" "$SCRIPT" > "$OUT/k6.txt" 2>&1 || true

stmt="FROM pg_stat_statements WHERE dbid = (SELECT oid FROM pg_database WHERE datname = '$PG_DB')"
psql_perf -c "SELECT calls, round(total_exec_time::numeric) AS total_ms, round(mean_exec_time::numeric, 1) AS mean_ms,
  round(max_exec_time::numeric) AS max_ms, regexp_replace(left(query, 140), '\s+', ' ', 'g') AS query $stmt
  ORDER BY total_exec_time DESC LIMIT 25" > "$OUT/top-queries.txt"
psql_perf -c "SELECT calls, regexp_replace(left(query, 140), '\s+', ' ', 'g') AS query $stmt ORDER BY calls DESC LIMIT 40" > "$OUT/top-calls.txt"
docker logs --since "$since" "$ENGINE_CONTAINER" 2>&1 | grep -E "ERROR|WARN" | sed -E 's/[0-9a-f-]{36}/<id>/g' \
  | sort | uniq -c | sort -rn | head -30 > "$OUT/engine-errors.txt" || true
grep -E "checks_succeeded|http_req_failed" "$OUT/k6.txt" || true
echo "results in $OUT"
