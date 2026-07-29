// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Pins the wiring the whole tenant boundary hangs off. Every other tenant test
 * exercises `TenantProvider` and `TenantScopeGuard` in isolation, so deleting
 * either one from the layouts left the suite green while the admin panel either
 * threw "useTenant must be used within TenantProvider" everywhere or served a
 * foreign tenant's URL as if it were yours.
 *
 * These assert on the element tree the layouts return rather than rendering it:
 * the layouts are async server components, and the wiring is a structural fact.
 */

import { describe, it, expect, vi } from "vitest";
import type { ReactElement, ReactNode } from "react";

vi.mock("next/headers", () => ({
  cookies: () => Promise.resolve({ get: () => undefined }),
}));

vi.mock("@/lib/auth", () => ({
  auth: () => Promise.resolve({ user: { name: "Owner", email: "owner@test" } }),
}));

// The surrounding shell is irrelevant here and drags in the whole UI kit. What
// must stay REAL are TenantProvider and TenantScopeGuard — the assertions
// compare against those exact symbols.
vi.mock("@/components/layout/app-sidebar", () => ({ AppSidebar: () => null }));
vi.mock("@/components/layout/header", () => ({ Header: () => null }));
vi.mock("@/components/layout/tenant-unavailable", () => ({
  TenantUnavailable: () => null,
}));
vi.mock("@/lib/activity-stream/provider", () => ({
  ActivityStreamProvider: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("@/components/ui/sidebar", () => ({
  SidebarProvider: ({ children }: { children: ReactNode }) => children,
  SidebarInset: ({ children }: { children: ReactNode }) => children,
}));

import AdminLayout from "./layout";
import OrganizationLayout from "./organizations/[orgSlug]/layout";
import WorkspaceLayout from "./organizations/[orgSlug]/workspaces/[workspaceSlug]/layout";
import { TenantProvider } from "@/lib/tenant/tenant-context";
import { TenantScopeGuard } from "@/components/layout/tenant-scope-guard";

/** Depth-first search for a component type anywhere in an element tree. */
function findByType(node: ReactNode, type: unknown): ReactElement | null {
  if (!node || typeof node !== "object") return null;

  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findByType(child, type);
      if (found) return found;
    }
    return null;
  }

  const element = node as ReactElement<{ children?: ReactNode }>;
  if (element.type === type) return element;
  return findByType(element.props?.children, type);
}

describe("admin layout", () => {
  it("wraps the admin subtree in TenantProvider", async () => {
    const tree = await AdminLayout({ children: <div>page</div> });

    expect(findByType(tree, TenantProvider)).not.toBeNull();
  });
});

describe("organization layout", () => {
  it("guards the subtree with the URL's org slug", async () => {
    const tree = await OrganizationLayout({
      children: <div>page</div>,
      params: Promise.resolve({ orgSlug: "acme" }),
    });

    const guard = findByType(tree, TenantScopeGuard);
    expect(guard).not.toBeNull();
    expect(guard!.props).toMatchObject({ orgSlug: "acme" });
  });

  it("passes no workspace slug — an org route must not require one", async () => {
    const tree = await OrganizationLayout({
      children: <div>page</div>,
      params: Promise.resolve({ orgSlug: "acme" }),
    });

    const guard = findByType(tree, TenantScopeGuard) as ReactElement<{
      workspaceSlug?: string;
    }>;
    expect(guard.props.workspaceSlug).toBeUndefined();
  });
});

describe("workspace layout", () => {
  it("guards the subtree with both URL slugs", async () => {
    const tree = await WorkspaceLayout({
      children: <div>page</div>,
      params: Promise.resolve({ orgSlug: "acme", workspaceSlug: "general" }),
    });

    const guard = findByType(tree, TenantScopeGuard);
    expect(guard).not.toBeNull();
    expect(guard!.props).toMatchObject({ orgSlug: "acme", workspaceSlug: "general" });
  });
});
