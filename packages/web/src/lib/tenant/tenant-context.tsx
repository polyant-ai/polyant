// SPDX-License-Identifier: AGPL-3.0-or-later

"use client";

import { createContext, useCallback, useContext, useEffect, useState } from "react";
import { api, ApiError } from "@/lib/api";
import type { TenantContextPayload, TenantWorkspace } from "@/lib/api-types";

/**
 * `no-organization` is the legacy-token state: the JWT predates RBAC and
 * carries no orgId. It arrives either as `organization: null` (shadow mode) or
 * as a 403 (enforce mode — no scope to authorize against). Both have the same
 * remedy, so they are one state.
 */
export type TenantState =
  | { status: "loading" }
  | {
      status: "ready";
      organization: { slug: string; name: string };
      workspaces: TenantWorkspace[];
    }
  | { status: "no-organization" }
  | { status: "error" };

export type TenantContextValue = TenantState & { retry: () => void };

const TenantContext = createContext<TenantContextValue | null>(null);

/**
 * Module-level cache so nested navigation does not refetch. A rejected promise
 * is deliberately NOT cached — otherwise retry would replay the same failure
 * forever.
 */
let inflight: Promise<TenantContextPayload> | null = null;

function fetchTenant(): Promise<TenantContextPayload> {
  inflight ??= api.me.get().catch((err: unknown) => {
    inflight = null;
    throw err;
  });
  return inflight;
}

/** Drop the module cache. Used by tests, and by production `retry()` below. */
export function resetTenantCache(): void {
  inflight = null;
}

function toState(payload: TenantContextPayload): TenantState {
  if (!payload.organization) return { status: "no-organization" };
  return {
    status: "ready",
    organization: payload.organization,
    workspaces: payload.workspaces,
  };
}

function toErrorState(err: unknown): TenantState {
  const isLegacyToken = err instanceof ApiError && err.status === 403;
  return { status: isLegacyToken ? "no-organization" : "error" };
}

export function TenantProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<TenantState>({ status: "loading" });

  const load = useCallback(() => {
    setState({ status: "loading" });
    fetchTenant().then(
      (payload) => setState(toState(payload)),
      (err: unknown) => setState(toErrorState(err)),
    );
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const retry = useCallback(() => {
    resetTenantCache();
    load();
  }, [load]);

  return (
    <TenantContext.Provider value={{ ...state, retry }}>{children}</TenantContext.Provider>
  );
}

export function useTenant(): TenantContextValue {
  const ctx = useContext(TenantContext);
  if (!ctx) throw new Error("useTenant must be used within TenantProvider");
  return ctx;
}

/** The workspace a tenant-scoped link should default to when none is addressed. */
export function defaultWorkspaceSlug(tenant: TenantContextValue): string | null {
  if (tenant.status !== "ready") return null;
  const preferred = tenant.workspaces.find((workspace) => workspace.isDefault);
  return (preferred ?? tenant.workspaces[0])?.slug ?? null;
}
