---
description: "Enforce performance standards: queries, caching, bundle optimization"
globs: ["**/*.ts", "**/*.tsx", "**/*.js", "**/*.jsx"]
alwaysApply: true
---

# Performance Rules

## MUST (violations block PR)

### Database
- Never write N+1 queries: load relations in batch (Drizzle's `with` / a join), never one query per row
- Queries inside loops → refactor into a single query with `WHERE IN`
- Every foreign key MUST have an index
- Pagination is mandatory for endpoints returning lists (never `SELECT *` without LIMIT)

### API
- Response payloads MUST include only the necessary fields — use DTO/schema, never return the whole entity
- Endpoints performing long operations (>5s) MUST be asynchronous (job queue, webhook callback)
- Never make external API calls in a sequential loop — use batch/parallel

### Frontend
- Images MUST be optimized (next/image, WebP, lazy loading)
- JavaScript bundles MUST use code splitting per route (dynamic import)
- Never import an entire library when a single module is enough (`import { debounce } from 'lodash/debounce'`)

## SHOULD (warnings)

- Cache data that rarely changes (configuration, lookup tables, user permissions)
- Configure database connection pooling (not single connections)
- Monitoring: track slow queries (>100ms), slow endpoints (>500ms)
- gzip/brotli compression for API responses >1KB
- Prefetch/preload critical above-the-fold resources
