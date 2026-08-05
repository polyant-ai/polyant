#!/bin/sh
set -e

echo "Running database migrations..."
node packages/engine/dist/database/migrate.js

echo "Starting engine..."
exec node packages/engine/dist/index.js
