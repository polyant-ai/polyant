#!/bin/sh
set -e

echo "Running database migrations..."
node --import tsx packages/engine/src/database/migrate.ts

echo "Starting engine..."
exec node packages/engine/dist/index.js
