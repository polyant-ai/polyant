// SPDX-License-Identifier: AGPL-3.0-or-later

import { createParamDecorator, type ExecutionContext } from "@nestjs/common";

/** The header `packages/web`'s `request()` derives from the URL being rendered. */
export const WORKSPACE_SLUG_HEADER = "x-workspace-slug";

/** Slug shape, mirroring the workspaces table: lowercase, digits, dashes. */
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

/**
 * The workspace the caller is ADDRESSING, from `X-Workspace-Slug`.
 *
 * The tenant-scoped admin URLs carry a workspace segment, and `packages/web`
 * sends it on every request. Nothing read it back, so the segment was decorative:
 * an agent created from `/workspaces/sandbox/instances` landed in the
 * organization's DEFAULT workspace and the browser was then pushed to a
 * `/workspaces/sandbox/...` URL that misattributed it — the URL people bookmark
 * and share.
 *
 * CALLER-CONTROLLED, and treated as such. This only says which workspace the
 * caller is pointing at; every consumer must still verify it belongs to the
 * caller's own organization (`resolveWorkspaceIdForPrincipal` does). Deriving it
 * from the URL rather than from a cookie or a stored "active workspace" is
 * deliberate: a caller cannot forget to pass it or pass a stale one, and there is
 * no second notion of "current workspace" for a link and a request to disagree
 * about.
 *
 * Returns `undefined` for a missing or malformed value, which every consumer
 * reads as "not addressed" and falls back to the organization default. Validating
 * the shape here keeps a junk header out of a query rather than relying on the
 * driver's parameterisation alone.
 */
/**
 * The parsing rule, exported so it can be tested directly. A param decorator's
 * body is only reachable through Nest's private factory metadata, and a test that
 * digs for it asserts on Nest internals instead of on this logic.
 */
export function parseWorkspaceSlugHeader(raw: unknown): string | undefined {
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return SLUG_RE.test(trimmed) ? trimmed : undefined;
}

export const WorkspaceSlug = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): string | undefined =>
    parseWorkspaceSlugHeader(
      ctx.switchToHttp().getRequest<{ headers?: Record<string, unknown> }>().headers?.[
        WORKSPACE_SLUG_HEADER
      ],
    ),
);
