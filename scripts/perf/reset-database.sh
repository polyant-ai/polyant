#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Puts the database back to the state prepare-environment.sh left it in, so
# runs that wrote conversations do not skew the next one. Restarts the engine,
# whose caches would otherwise point at rows that no longer exist.
set -euo pipefail
source "$(dirname "$0")/env.sh"
docker stop "$ENGINE_CONTAINER" >/dev/null 2>&1 || true
docker exec "$PG_CONTAINER" psql -U "$PG_USER" -d postgres -qc "DROP DATABASE IF EXISTS $PG_DB WITH (FORCE)"
docker exec "$PG_CONTAINER" psql -U "$PG_USER" -d postgres -qc "CREATE DATABASE $PG_DB TEMPLATE perf_seeded"
"$PERF_DIR/start-engine.sh"
