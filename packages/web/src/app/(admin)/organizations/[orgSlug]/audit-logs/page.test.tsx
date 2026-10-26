// SPDX-License-Identifier: AGPL-3.0-or-later

import { render } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const replace = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ replace }) }));

let tenant: unknown;
vi.mock("@/lib/tenant/tenant-context", async () => {
  const actual = await vi.importActual<typeof import("@/lib/tenant/tenant-context")>("@/lib/tenant/tenant-context");
  return { ...actual, useTenant: () => tenant };
});

import AuditLogsRedirectPage from "./page";

describe("audit-logs redirect", () => {
  beforeEach(() => replace.mockClear());

  it("opens the Monitor of the default workspace, narrowed to tool calls", () => {
    tenant = {
      status: "ready",
      organization: { slug: "acme" },
      workspaces: [
        { slug: "side", isDefault: false },
        { slug: "main", isDefault: true },
      ],
    };
    render(<AuditLogsRedirectPage />);
    expect(replace).toHaveBeenCalledWith("/organizations/acme/workspaces/main/monitor?group=agents&type=tool_call");
  });

  it("goes nowhere while the tenancy is still loading", () => {
    tenant = { status: "loading" };
    render(<AuditLogsRedirectPage />);
    expect(replace).not.toHaveBeenCalled();
  });
});
