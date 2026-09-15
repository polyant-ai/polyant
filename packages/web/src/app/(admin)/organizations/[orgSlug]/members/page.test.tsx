// SPDX-License-Identifier: AGPL-3.0-or-later

import { render, screen, waitFor, within } from "@testing-library/react";

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

// The page has to know WHICH member the caller is: the remove action is the
// one control whose target may be the caller itself.
vi.mock("next-auth/react", () => ({
  useSession: () => ({ data: { user: { id: "u1" } } }),
}));

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

  // Leaving is not member management: the engine refuses it, and a session that
  // outlived its membership shows an organization that is gone at the next
  // reload. The row says so rather than offering a button that only 403s.
  it("offers no remove action on the caller's own row", async () => {
    mockMembersList.mockResolvedValue({
      members: [
        { userId: "u1", email: "ada@example.com", name: "Ada", roleKey: "admin" },
        { userId: "u2", email: "bob@example.com", name: "Bob", roleKey: "viewer" },
      ],
    });

    render(<MembersPage />);

    const ownRow = (await screen.findByText("ada@example.com")).closest("tr")!;
    expect(within(ownRow).queryByText("members.remove.button")).not.toBeInTheDocument();
    expect(within(ownRow).getByText("members.remove.self")).toBeInTheDocument();

    const otherRow = screen.getByText("bob@example.com").closest("tr")!;
    expect(within(otherRow).getByText("members.remove.button")).toBeInTheDocument();
  });
});
