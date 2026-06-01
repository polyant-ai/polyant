# =============================================================================
# Multi-stage Dockerfile for @polyant/engine (NestJS + Drizzle)
# =============================================================================
# Builds the TypeScript backend, runs DB migrations at startup, then starts
# the production server. Works on any container platform (Render, Fly.io,
# Railway, Kubernetes, ECS, etc.).
#
# Build context: monorepo root (not packages/engine/)
#   docker build -f packages/engine/Dockerfile .
# =============================================================================

# -----------------------------------------------------------------------------
# Stage 1: builder — Install ALL deps + compile TypeScript
# -----------------------------------------------------------------------------
FROM node:22-alpine AS builder
LABEL stage=builder

WORKDIR /app

# Copy all package.json files to preserve monorepo workspace structure
COPY package.json package-lock.json ./
COPY packages/engine/package.json ./packages/engine/
COPY packages/web/package.json ./packages/web/

# Skip Puppeteer's bundled Chromium download — it's glibc-linked and won't run
# on Alpine (musl). The runner image installs Alpine's chromium package and
# points Puppeteer at it via PUPPETEER_EXECUTABLE_PATH.
ENV PUPPETEER_SKIP_DOWNLOAD=true
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true

# Install all dependencies (full monorepo — hoisting needs all workspaces)
RUN npm ci

# Copy engine source
COPY packages/engine/ ./packages/engine/

# Clean stale dist/ (COPY may bring orphan .js files from host) and build fresh
RUN rm -rf ./packages/engine/dist
RUN npm run build -w @polyant/engine

# Reinstall production-only deps (prune doesn't work reliably with workspaces + hoisting).
# Keep the Puppeteer Chromium-download skip flags from above active for this step too.
RUN rm -rf node_modules packages/engine/node_modules packages/web/node_modules && \
    PUPPETEER_SKIP_DOWNLOAD=true PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true \
    npm ci --omit=dev && \
    mkdir -p packages/engine/node_modules

# -----------------------------------------------------------------------------
# Stage 2: runner — Production image
# -----------------------------------------------------------------------------
FROM node:22-alpine AS runner
LABEL stage=runner

WORKDIR /app

ENV NODE_ENV=production

# Install:
#   - git (for gitCloneRepo)
#   - gh CLI (for gh* tools)
#   - Chromium + runtime libs (for the markdownToPdf tool via Puppeteer)
ARG GH_CLI_VERSION=2.65.0
RUN apk add --no-cache \
      git curl bash \
      chromium nss freetype freetype-dev harfbuzz ca-certificates ttf-freefont font-noto-emoji && \
    ARCH=$(uname -m | sed 's/x86_64/amd64/' | sed 's/aarch64/arm64/') && \
    curl -fsSL "https://github.com/cli/cli/releases/download/v${GH_CLI_VERSION}/gh_${GH_CLI_VERSION}_linux_${ARCH}.tar.gz" \
      | tar -xz -C /tmp && \
    mv "/tmp/gh_${GH_CLI_VERSION}_linux_${ARCH}/bin/gh" /usr/local/bin/gh && \
    chmod +x /usr/local/bin/gh && \
    rm -rf /tmp/gh_*

# Point Puppeteer at the Alpine-provided Chromium binary (skip its own download).
ENV PUPPETEER_SKIP_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium-browser

# Create non-root user
RUN addgroup --system --gid 1001 engine && \
    adduser --system --uid 1001 engine

# Copy production node_modules (hoisted root + workspace-level for non-hoisted deps)
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/packages/engine/node_modules ./packages/engine/node_modules

# Copy compiled output
COPY --from=builder /app/packages/engine/dist ./packages/engine/dist

# Copy migration SQL files (needed at startup)
COPY --from=builder /app/packages/engine/src/database/migrations ./packages/engine/migrations

# Copy package.json files (needed for ESM module resolution)
COPY --from=builder /app/package*.json ./
COPY --from=builder /app/packages/engine/package.json ./packages/engine/

# Copy startup script
COPY packages/engine/scripts/docker-start.sh ./docker-start.sh
RUN chmod +x ./docker-start.sh

# Create .repos dir for cloned repos (writable by engine user)
RUN mkdir -p /app/packages/engine/.repos

# Set ownership
RUN chown -R engine:engine /app
USER engine

EXPOSE 4000

ENV PORT=4000
ENV HOST=0.0.0.0

# Start: run migrations then start server
CMD ["./docker-start.sh"]
