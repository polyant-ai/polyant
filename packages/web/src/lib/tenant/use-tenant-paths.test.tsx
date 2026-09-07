// SPDX-License-Identifier: AGPL-3.0-or-later

import { render, screen } from "@testing-library/react";
import { useTenantPaths } from "./use-tenant-paths";

const { mockUseParams } = vi.hoisted(() => ({ mockUseParams: vi.fn() }));

vi.mock("next/navigation", () => ({
  useParams: () => mockUseParams(),
}));

function Probe() {
  const paths = useTenantPaths();
  return <span data-testid="workspace-path">{paths.workspace("/instances")}</span>;
}

describe("useTenantPaths", () => {
  it("builds paths when both params are present", () => {
    mockUseParams.mockReturnValue({ orgSlug: "default", workspaceSlug: "general" });

    render(<Probe />);

    expect(screen.getByTestId("workspace-path")).toHaveTextContent(
      "/organizations/default/workspaces/general/instances",
    );
  });

  it("throws naming both params when neither is present", () => {
    mockUseParams.mockReturnValue({});

    expect(() => render(<Probe />)).toThrow(
      /useTenantPaths: missing required param\(s\) \[orgSlug, workspaceSlug\]/,
    );
  });

  it("throws naming only the missing param when one is present", () => {
    mockUseParams.mockReturnValue({ orgSlug: "default" });

    expect(() => render(<Probe />)).toThrow(
      /useTenantPaths: missing required param\(s\) \[workspaceSlug\]/,
    );
  });
});
