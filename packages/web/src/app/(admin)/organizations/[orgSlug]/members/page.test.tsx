// SPDX-License-Identifier: AGPL-3.0-or-later

import { render, screen, waitFor } from "@testing-library/react";

// ── Mocks ────────────────────────────────────────────────────────────

const mockMembersList = vi.fn();
const mockToastError = vi.fn();

class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

vi.mock("@/lib/api", () => ({
  api: {
    members: {
      list: (...args: unknown[]) => mockMembersList(...args),
      assign: vi.fn(),
      remove: vi.fn(),
    },
  },
  getUserErrorMessage: (_err: unknown, fallback: string) => fallback,
  // The real predicate, not a stub: the page's whole behaviour hinges on it, so
  // a `vi.fn(() => true)` would assert the mock rather than the branch.
  isForbidden: (err: unknown) => err instanceof ApiError && err.status === 403,
  MEMBER_ROLES: ["owner", "admin", "member", "viewer"],
}));

vi.mock("@/lib/i18n/context", () => ({
  useI18n: () => ({ t: (key: string) => key, locale: "en", setLocale: vi.fn() }),
}));

vi.mock("next/navigation", () => ({ useParams: () => ({ orgSlug: "acme" }) }));

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: (...args: unknown[]) => mockToastError(...args) },
}));

import MembersPage from "./page";

describe("MembersPage — a role that may not manage members is told so", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // The dead-end this replaces: `org.member:manage` is admin+, the entry is
  // offered to every role (the panel cannot know the caller's), and the refusal
  // used to become a generic "failed to load" toast over an empty table —
  // indistinguishable from an organization with no members.
  it("renders the permission explanation, and no error toast, on a 403", async () => {
    mockMembersList.mockRejectedValue(new ApiError(403, "Missing permission: org.member:manage"));

    render(<MembersPage />);

    await waitFor(() => {
      expect(screen.getByText("permission.required.title")).toBeInTheDocument();
    });
    expect(screen.getByText("permission.required.members")).toBeInTheDocument();
    expect(mockToastError).not.toHaveBeenCalled();
  });

  it("still reports a genuine failure as an error", async () => {
    mockMembersList.mockRejectedValue(new ApiError(500, "boom"));

    render(<MembersPage />);

    await waitFor(() => expect(mockToastError).toHaveBeenCalledWith("members.loadFailed"));
    expect(screen.queryByText("permission.required.title")).not.toBeInTheDocument();
  });

  it("renders the member table when the caller is allowed", async () => {
    mockMembersList.mockResolvedValue({
      members: [
        { userId: "u1", email: "ada@example.com", name: "Ada", roleKey: "owner" },
        { userId: "u2", email: "bob@example.com", name: "Bob", roleKey: "viewer" },
      ],
    });

    render(<MembersPage />);

    await waitFor(() => expect(screen.getByText("ada@example.com")).toBeInTheDocument());
    expect(screen.getByText("bob@example.com")).toBeInTheDocument();
    expect(screen.queryByText("permission.required.title")).not.toBeInTheDocument();
  });
});
