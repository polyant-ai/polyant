---
paths:
  - "packages/web/src/**/*.{ts,tsx,css,json}"
---

# Web changes

- Route every engine request through `src/lib/api.ts`; do not call the engine with a bare
  component-level `fetch`.
- Resolve workspace and route shape through `src/lib/tenant/`. Do not duplicate URL parsing
  or tenant fallbacks in pages and components.
- Relative imports under `src` are extensionless. The package ESLint rule enforces this.
- Prefer Server Components. Add `"use client"` only for state, effects, event handlers, or
  browser-only APIs.
- Reuse the source-owned components in `src/components/ui/` and tokens in `app/globals.css`.
  Use semantic tokens; do not add raw theme colors to feature components.
- Add user-facing copy to every supported locale and use the existing i18n helper.
- Preserve keyboard access, labels, focus states, and semantic HTML.
- Run the narrow test first, then web typecheck, lint, and build when routing or bundling
  changes.
