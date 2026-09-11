---
paths:
  - "packages/engine/src/**/*.ts"
  - "packages/engine/scripts/**/*.{js,mjs,ts}"
---

# Engine changes

- Keep NestJS decorators and dependency injection inside `src/server/`; controllers are
  HTTP adapters and delegate immediately to domain functions or stores.
- Validate untrusted input at the boundary with the existing Zod or DTO pattern. Inside
  the domain, rely on the validated type instead of repeating defensive checks.
- Relative value imports end in `.js`. Use explicit `@Inject(...)` in NestJS constructors.
  The package ESLint rules enforce both constraints.
- Read and write instance configuration through its owning store or resolver. Do not add
  filesystem-backed assistant configuration or direct `process.env` reads.
- Preserve slug/UUID brands and fail-closed tenancy predicates.
- Tools and hooks default-export `defineTool(...)` and `defineHook(...)`. Keep schemas
  static and compatible with the registry's strict-mode tests.
- Keep sensitive values out of application logs. Log stable IDs and operational metadata;
  put unavoidable diagnostic payloads at debug level or redact them.
- Run the narrow unit test first, then engine typecheck and lint for the touched scope.
