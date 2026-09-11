---
name: frontend-design-system
description: Use when changing pages, components, navigation, copy, interaction, accessibility, or styling under packages/web.
---

# Frontend design system

Extend the UI already present in `packages/web`; do not recreate its design tokens or tenant
resolution in feature code.

## Before editing

1. Read `CLAUDE.md` and `.claude/rules/web.md`.
2. Inspect the target page, its closest sibling, `app/globals.css`, and the relevant
   components under `src/components/ui/`.
3. Trace data access through `src/lib/api.ts` and route/workspace resolution through
   `src/lib/tenant/`.

## Implementation

- Prefer an existing UI primitive. `components/ui/` is source-owned shadcn code; edit it
  only when the shared primitive itself needs to change.
- Use semantic Tailwind tokens from `globals.css`. Preserve the established neutral palette,
  spacing, radii, and accent usage instead of adding raw feature colors.
- Prefer Server Components. Use `"use client"` only for browser APIs or interaction state.
- Put reusable feature components near their route; move them to shared components only
  after real reuse.
- Add all user-visible copy through the existing i18n system in every supported locale.
- Preserve semantic HTML, labels, keyboard operation, focus visibility, and readable states.
- Use `request<T>()` for engine calls. A bare engine fetch can silently use another workspace.

## Verify

Run the narrow component or page test first, then:

```bash
npm run typecheck -w @polyant/web
npm run lint -w @polyant/web
```

Run `npm run build:web` when changing routes, imports, server/client boundaries, configuration,
or anything only the Next.js build validates. Report any check that could not run.
