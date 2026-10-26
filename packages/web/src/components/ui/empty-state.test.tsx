// SPDX-License-Identifier: AGPL-3.0-or-later

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Brain } from "lucide-react";
import { describe, expect, it, vi } from "vitest";
import { renderWithProviders } from "@/test-utils";
import { PageHeader } from "@/components/layout/page-header";
import { EmptyState } from "./empty-state";
import { LoadFailed } from "./load-failed";

describe("EmptyState", () => {
  it("shows the title, the explanation and the action", () => {
    render(<EmptyState icon={Brain} title="Nothing yet" description="Add one" action={<button>Add</button>} />);
    expect(screen.getByRole("heading", { name: "Nothing yet" })).toBeInTheDocument();
    expect(screen.getByText("Add one")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add" })).toBeInTheDocument();
  });
});

describe("LoadFailed", () => {
  it("says the read failed and offers a retry", async () => {
    const retry = vi.fn();
    renderWithProviders(<LoadFailed onRetry={retry} />);
    expect(screen.getByRole("alert")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button"));
    expect(retry).toHaveBeenCalledTimes(1);
  });
});

describe("PageHeader", () => {
  it("renders the title once, with its subtitle and actions", () => {
    render(<PageHeader title="Skills" subtitle="Catalogue" actions={<button>New</button>} />);
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
    expect(screen.getByText("Catalogue")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "New" })).toBeInTheDocument();
  });
});
