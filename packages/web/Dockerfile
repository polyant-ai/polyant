# =============================================================================
# Multi-stage Dockerfile for @polyant/web (Next.js 15)
# =============================================================================
# Based on Next.js official Docker example with standalone output. Works on
# any container platform (Render, Fly.io, Railway, Kubernetes, ECS, etc.).
#
# Build context: monorepo root (not packages/web/)
#   docker build -f packages/web/Dockerfile .
# =============================================================================

# -----------------------------------------------------------------------------
# Stage 1: deps — Install dependencies (full monorepo structure)
# -----------------------------------------------------------------------------
FROM node:22-alpine AS deps
LABEL stage=deps

RUN apk add --no-cache libc6-compat

WORKDIR /app

# Copy all package.json files to preserve monorepo workspace structure
COPY package.json package-lock.json ./
COPY packages/web/package.json ./packages/web/
# Engine package.json needed for workspace resolution (peer hoisting)
COPY packages/engine/package.json ./packages/engine/

# Install all dependencies — npm workspaces hoists shared deps to root node_modules
# Ensure workspace node_modules dir exists (may be empty after hoisting)
RUN npm ci && mkdir -p packages/web/node_modules

# -----------------------------------------------------------------------------
# Stage 2: builder — Build the Next.js application
# -----------------------------------------------------------------------------
FROM node:22-alpine AS builder
LABEL stage=builder

WORKDIR /app

# Copy full node_modules tree (root + workspaces) preserving hoisting structure
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/packages/web/node_modules ./packages/web/node_modules

# Copy root package.json (workspace resolution)
COPY package.json ./

# Copy web package source
COPY packages/web/ ./packages/web/

# Build-time env vars (Render injects these as build args).
# NEXT_PUBLIC_* are inlined into the client bundle, so they MUST be present
# at build time.
ARG NEXT_PUBLIC_API_URL
ENV NEXT_PUBLIC_API_URL=${NEXT_PUBLIC_API_URL}

# SECURITY: do NOT pass AUTH_SECRET as a build-time ARG. Auth.js reads it
# at runtime; baking it into the image via `ENV AUTH_SECRET=${AUTH_SECRET}`
# persists the value as a Docker layer that is visible via `docker history`
# / `docker inspect` to anyone with registry pull access. Inject the real
# value at runtime instead (`docker run -e AUTH_SECRET=...` or via the
# orchestrator's secret-management facility). The placeholder below only
# satisfies any presence check Auth.js performs during the Next.js build;
# it is intentionally a non-secret literal and must be overridden at
# runtime.
ENV AUTH_SECRET=build-time-placeholder-override-at-runtime

ARG AUTH_TRUST_HOST=true
ENV AUTH_TRUST_HOST=${AUTH_TRUST_HOST}

ENV NEXT_TELEMETRY_DISABLED=1

# Build Next.js (standalone output)
RUN npm run build -w @polyant/web

# -----------------------------------------------------------------------------
# Stage 3: runner — Production image
# -----------------------------------------------------------------------------
FROM node:22-alpine AS runner
LABEL stage=runner

WORKDIR /app

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1

# Create non-root user
RUN addgroup --system --gid 1001 nodejs && \
    adduser --system --uid 1001 nextjs

# Copy public assets (if any)
# COPY --from=builder /app/packages/web/public ./packages/web/public

# Set correct permissions for prerender cache
RUN mkdir -p .next && chown nextjs:nodejs .next

# Copy standalone output (server.js + .next server files).
# In a monorepo build, Next emits the standalone tree preserving the workspace
# path, so server.js lands at ./packages/web/server.js (see CMD below).
COPY --from=builder --chown=nextjs:nodejs /app/packages/web/.next/standalone ./
# Copy node_modules that standalone needs (traced deps from builder)
COPY --from=builder --chown=nextjs:nodejs /app/node_modules ./node_modules
# Static assets must sit next to server.js (packages/web/.next/static), not at root
COPY --from=builder --chown=nextjs:nodejs /app/packages/web/.next/static ./packages/web/.next/static

USER nextjs

EXPOSE 3000

ENV PORT=3000
ENV HOSTNAME="0.0.0.0"

# Next.js standalone server.js — under packages/web in a monorepo standalone output
CMD ["node", "packages/web/server.js"]
