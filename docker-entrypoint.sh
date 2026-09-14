#!/bin/sh
set -e

# Environment the included plugins declared in their manifests (`system.env`),
# collected at build time. It is sourced rather than baked in with ENV because
# the variable NAMES are not known when the image is written — a plugin that
# needs PUPPETEER_EXECUTABLE_PATH ships that fact in its own plugin.json.
# Absent when the build carried no plugins, or none declared any.
if [ -f /app/plugin-system/env.sh ]; then
  . /app/plugin-system/env.sh
fi

echo "Running database migrations..."
node packages/engine/dist/database/migrate.js

echo "Starting engine..."
exec node packages/engine/dist/index.js
