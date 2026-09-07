# ADR-0002: Canonical Tenant Boundaries

- **Status**: Accepted
- **Date**: 2026-08-05
- **Deciders**: @freegenie, @paolovalletta-exelab
- **Related**: PR #245

## Context

The admin panel originally exposed flat routes such as `/instances`,
`/conversations`, and `/members`. Tenant-scoped routes were added alongside
temporary client-side redirects from those paths. That compatibility layer made
two URL schemes valid, preserved code with no product value, and obscured which
tenant context a resource belonged to.

The product currently has one provisioned organization and workspace, but the
data model and authorization boundary are tenant-scoped. A URL alone is not a
security boundary: requests that address an agent must also be checked against
the tenant context resolved by the engine.

## Decision

Use one canonical admin URL hierarchy:

- `/organizations/:orgSlug` for organization pages, including members and
  audit logs.
- `/organizations/:orgSlug/workspaces/:workspaceSlug/...` for workspace pages,
  including instances, conversations, activity, memory, and playground.
- Flat deployment pages (`/settings`, `/skills`) remain deployment-scoped.

Remove the flat admin route stubs and `LegacyTenantRedirect`; old bookmarks now
return a normal 404 rather than redirecting. The sign-in callback continues to
preserve the complete canonical path and query string.

The web proxy sends the selected workspace slug with requests that address an
agent. The engine validates that slug against the agent's actual workspace and
denies a malformed or mismatched context. Membership remains explicit: sign-in
only resolves an existing membership and never creates one.

## Consequences

- Navigation, deep links, and documentation have one stable representation of
  tenant context.
- Removing redirects reduces client-side routing code and eliminates a second,
  untested compatibility path.
- Existing flat bookmarks intentionally stop working and must be replaced with
  canonical links.
- The URL improves clarity, while backend validation remains the authority for
  tenant isolation.

## Alternatives Considered

### Keep permanent redirects (rejected)

They retain two public URL contracts and force every future route change to
maintain legacy behavior. The product is pre-release, so a clean break is less
costly than carrying that surface indefinitely.

### Treat the workspace segment as visual only (rejected)

That makes a tenant-looking URL misleading and allows a client-selected context
to disagree with the addressed resource. The engine must validate the context
where it has authoritative data.
