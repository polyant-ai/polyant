// SPDX-License-Identifier: AGPL-3.0-or-later

import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

// ── Mocks ────────────────────────────────────────────────────────────

const mockMembersList = vi.fn();
const mockMembersRemove = vi.fn();
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
      remove: (...args: unknown[]) => mockMembersRemove(...args),
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

    expect(await screen.findByRole("alert")).toHaveTextContent("members.loadFailed");
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

  it("lists each member with the name over the email, and the email alone when there is no name", async () => {
    mockMembersList.mockResolvedValue({
      members: [
        { userId: "u1", email: "ada@example.com", name: "Ada", roleKey: "owner" },
        { userId: "u2", email: "bob@example.com", name: null, roleKey: "viewer" },
      ],
    });

    render(<MembersPage />);

    const named = (await screen.findByText("ada@example.com")).closest("tr")!;
    expect(within(named).getByText("Ada")).toBeInTheDocument();
    const unnamed = screen.getByText("bob@example.com").closest("tr")!;
    expect(within(unnamed).getAllByText("bob@example.com")).toHaveLength(1);
  });

  it("filters the members on name, email and role as typed", async () => {
    const user = userEvent.setup();
    mockMembersList.mockResolvedValue({
      members: [
        { userId: "u1", email: "ada@example.com", name: "Ada", roleKey: "owner" },
        { userId: "u2", email: "bob@example.com", name: "Bob", roleKey: "viewer" },
      ],
    });

    render(<MembersPage />);
    const search = await screen.findByRole("searchbox", { name: "common.search" });

    await user.type(search, "bob");
    expect(screen.getByText("bob@example.com")).toBeInTheDocument();
    expect(screen.queryByText("ada@example.com")).not.toBeInTheDocument();

    await user.clear(search);
    await user.type(search, "role.owner");
    expect(screen.getByText("ada@example.com")).toBeInTheDocument();
    expect(screen.queryByText("bob@example.com")).not.toBeInTheDocument();

    await user.clear(search);
    await user.type(search, "nobody");
    expect(screen.getByText("common.noResults")).toBeInTheDocument();
  });

  it("has no remove or role control on the rows: the row opens the member's drawer", async () => {
    const user = userEvent.setup();
    mockMembersList.mockResolvedValue({
      members: [
        { userId: "u1", email: "ada@example.com", name: "Ada", roleKey: "admin" },
        { userId: "u2", email: "bob@example.com", name: "Bob", roleKey: "viewer" },
      ],
    });

    render(<MembersPage />);
    const row = (await screen.findByText("bob@example.com")).closest("tr")!;
    expect(within(row).queryByText("members.remove.button")).not.toBeInTheDocument();
    expect(within(row).queryByRole("combobox")).not.toBeInTheDocument();

    await user.click(row);
    const drawer = await screen.findByRole("dialog");
    expect(within(drawer).getByRole("heading", { name: "Bob" })).toBeInTheDocument();
    expect(within(drawer).getByRole("combobox")).toBeEnabled();
    expect(within(drawer).getByText("members.remove.button")).toBeInTheDocument();
  });

  // Leaving is not member management: the engine refuses it, and a session that
  // outlived its membership shows an organization that is gone at the next
  // reload. The drawer says so rather than offering a button that only 403s.
  it("offers no remove action in the caller's own drawer", async () => {
    const user = userEvent.setup();
    mockMembersList.mockResolvedValue({
      members: [
        { userId: "u1", email: "ada@example.com", name: "Ada", roleKey: "admin" },
        { userId: "u2", email: "bob@example.com", name: "Bob", roleKey: "viewer" },
      ],
    });

    render(<MembersPage />);

    await user.click((await screen.findByText("ada@example.com")).closest("tr")!);
    const own = await screen.findByRole("dialog");
    expect(within(own).queryByText("members.remove.button")).not.toBeInTheDocument();
    expect(within(own).getByText("members.remove.self")).toBeInTheDocument();
  });

  it("locks the role and the removal of the last Owner", async () => {
    const user = userEvent.setup();
    mockMembersList.mockResolvedValue({
      members: [
        { userId: "u1", email: "ada@example.com", name: "Ada", roleKey: "owner" },
        { userId: "u2", email: "bob@example.com", name: "Bob", roleKey: "viewer" },
      ],
    });

    render(<MembersPage />);

    await user.click((await screen.findByText("bob@example.com")).closest("tr")!);
    expect(within(await screen.findByRole("dialog")).getByRole("combobox")).toBeEnabled();
    await user.click(screen.getAllByRole("button", { name: "common.close" })[0]);
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());

    // Ada is the only Owner but also the caller: her drawer has no remove button at all,
    // and her role select is locked.
    await user.click(screen.getByText("ada@example.com").closest("tr")!);
    expect(within(await screen.findByRole("dialog")).getByRole("combobox")).toBeDisabled();
  });

  it("removes nothing until the removal is confirmed, and nothing on cancel", async () => {
    const user = userEvent.setup();
    mockMembersList.mockResolvedValue({
      members: [
        { userId: "u1", email: "ada@example.com", name: "Ada", roleKey: "admin" },
        { userId: "u2", email: "bob@example.com", name: "Bob", roleKey: "viewer" },
      ],
    });

    render(<MembersPage />);
    await user.click((await screen.findByText("bob@example.com")).closest("tr")!);
    const drawer = await screen.findByRole("dialog");
    await user.click(within(drawer).getByText("members.remove.button"));
    const confirm = await screen.findByRole("alertdialog");
    expect(mockMembersRemove).not.toHaveBeenCalled();
    await user.click(within(confirm).getByRole("button", { name: "common.cancel" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument());
    expect(mockMembersRemove).not.toHaveBeenCalled();
  });

  it("takes a removed member off the screen before the new list arrives", async () => {
    const user = userEvent.setup();
    mockMembersList
      .mockResolvedValueOnce({
        members: [
          { userId: "u1", email: "ada@example.com", name: "Ada", roleKey: "admin" },
          { userId: "u2", email: "bob@example.com", name: "Bob", roleKey: "viewer" },
        ],
      })
      .mockReturnValue(new Promise(() => {}));
    mockMembersRemove.mockResolvedValue({ removed: true });

    render(<MembersPage />);

    await user.click((await screen.findByText("bob@example.com")).closest("tr")!);
    const drawer = await screen.findByRole("dialog");
    await user.click(within(drawer).getByText("members.remove.button"));
    await user.click(await screen.findByRole("button", { name: "members.remove.confirm" }));

    await waitFor(() => expect(screen.queryByText("bob@example.com")).not.toBeInTheDocument());
    expect(mockMembersRemove).toHaveBeenCalledWith("u2", "acme");
    expect(screen.getByText("ada@example.com")).toBeInTheDocument();
  });

  it("lists the members by name, falling back to the email, in alphabetical order", async () => {
    mockMembersList.mockResolvedValue({
      members: [
        { userId: "u1", email: "zed@example.com", name: "Zed", roleKey: "owner" },
        { userId: "u2", email: "carla@example.com", name: null, roleKey: "viewer" },
        { userId: "u3", email: "ada@example.com", name: "Ada", roleKey: "admin" },
      ],
    });
    render(<MembersPage />);
    await screen.findByText("Zed");
    const names = screen.getAllByRole("row").slice(1).map((row) => within(row).getAllByRole("button")[0].textContent);
    expect(names).toEqual(["Ada", "carla@example.com", "Zed"]);
  });

  it("gives the drawer a line of description: the email, or the role when there is no name", async () => {
    const user = userEvent.setup();
    mockMembersList.mockResolvedValue({
      members: [
        { userId: "u1", email: "ada@example.com", name: "Ada", roleKey: "owner" },
        { userId: "u2", email: "bob@example.com", name: null, roleKey: "viewer" },
      ],
    });
    render(<MembersPage />);
    await user.click((await screen.findByText("bob@example.com")).closest("tr")!);
    const drawer = await screen.findByRole("dialog");
    // The title is the email, so the line under it says the role instead of repeating it.
    expect(drawer.querySelector("[data-slot=sheet-description]")).toHaveTextContent("role.viewer");
  });
});
