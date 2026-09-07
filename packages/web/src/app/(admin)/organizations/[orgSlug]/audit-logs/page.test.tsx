// SPDX-License-Identifier: AGPL-3.0-or-later

import { render, screen, waitFor } from "@testing-library/react";

// ── Mocks ────────────────────────────────────────────────────────────

const mockInstancesList = vi.fn();
const mockAuditList = vi.fn();
const mockAuditStats = vi.fn();
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
    instances: { list: (...args: unknown[]) => mockInstancesList(...args) },
    auditLogs: {
      list: (...args: unknown[]) => mockAuditList(...args),
      stats: (...args: unknown[]) => mockAuditStats(...args),
    },
  },
  getUserErrorMessage: (_err: unknown, fallback: string) => fallback,
  isForbidden: (err: unknown) => err instanceof ApiError && err.status === 403,
}));

vi.mock("@/lib/i18n/context", () => ({
  useI18n: () => ({ t: (key: string) => key, locale: "en", setLocale: vi.fn() }),
}));

vi.mock("@/lib/format", () => ({
  formatDateTime: () => "2026-08-06 10:00",
  truncate: (s: string) => s,
}));

vi.mock("@/hooks/use-pagination", () => ({
  usePagination: () => ({
    page: 1,
    setPage: vi.fn(),
    search: "",
    setSearch: vi.fn(),
    debouncedSearch: "",
    totalPages: 1,
    setTotal: vi.fn(),
    offset: 0,
    reset: vi.fn(),
  }),
}));

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: (...args: unknown[]) => mockToastError(...args) },
}));

import AuditLogsPage from "./page";

const FORBIDDEN = () => new ApiError(403, "Missing permission: audit_log:read");

describe("AuditLogsPage — a role that may not read the audit log is told so", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Listing agents is `agent:read`, which every role holds — so this succeeds
    // even for the caller the audit endpoints refuse. Keeping it truthful is the
    // point: the page must key off the AUDIT refusal, not off a blanket failure.
    mockInstancesList.mockResolvedValue({ instances: [] });
  });

  it("replaces the page body with the explanation, and raises no error toast", async () => {
    mockAuditStats.mockRejectedValue(FORBIDDEN());
    mockAuditList.mockRejectedValue(FORBIDDEN());

    render(<AuditLogsPage />);

    await waitFor(() => {
      expect(screen.getByText("permission.required.title")).toBeInTheDocument();
    });
    expect(screen.getByText("permission.required.auditLogs")).toBeInTheDocument();
    expect(mockToastError).not.toHaveBeenCalled();
  });

  // A search box over a table that can never fill is the misleading half of the
  // dead-end: it invites the reader to conclude their query is wrong.
  it("offers no filters or search once the log is known to be unreadable", async () => {
    mockAuditStats.mockRejectedValue(FORBIDDEN());
    mockAuditList.mockRejectedValue(FORBIDDEN());

    render(<AuditLogsPage />);

    await waitFor(() => {
      expect(screen.getByText("permission.required.title")).toBeInTheDocument();
    });
    expect(screen.queryByPlaceholderText("auditLog.searchPlaceholder")).not.toBeInTheDocument();
    expect(screen.queryByText("auditLog.empty.title")).not.toBeInTheDocument();
  });

  it("still reports a genuine failure as an error", async () => {
    mockAuditStats.mockRejectedValue(new ApiError(500, "boom"));
    mockAuditList.mockRejectedValue(new ApiError(500, "boom"));

    render(<AuditLogsPage />);

    await waitFor(() => expect(mockToastError).toHaveBeenCalledWith("common.loadFailed"));
    expect(screen.queryByText("permission.required.title")).not.toBeInTheDocument();
  });

  it("renders the log when the caller is allowed", async () => {
    mockAuditStats.mockResolvedValue({ totalEntries: 2, errorCount: 0, errorRate: 0, byTool: [] });
    mockAuditList.mockResolvedValue({
      items: [
        {
          id: "a1",
          instanceId: "bot-1",
          toolName: "webSearch",
          action: "call",
          details: { query: "polyant" },
          durationMs: 120,
          success: true,
          createdAt: "2026-08-06T10:00:00Z",
        },
      ],
      total: 1,
    });

    render(<AuditLogsPage />);

    await waitFor(() => expect(screen.getByText("webSearch")).toBeInTheDocument());
    expect(screen.queryByText("permission.required.title")).not.toBeInTheDocument();
  });
});
