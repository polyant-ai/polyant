// SPDX-License-Identifier: AGPL-3.0-or-later

import { act, renderHook, waitFor } from "@testing-library/react";
import { useSession } from "next-auth/react";

import { useChangelogCheck } from "./use-changelog-check";
import type { ChangelogData } from "@/lib/changelog-types";

vi.mock("next-auth/react", () => ({
  useSession: vi.fn(),
}));

const mockUseSession = vi.mocked(useSession);

const CHANGELOG_DATA: ChangelogData = {
  version: "1.1.0",
  releaseDate: "2026-08-25",
  buildDate: "2026-08-25",
  generated: "2026-08-25T00:00:00.000Z",
  source: "CHANGELOG.md",
  changelog: [
    { version: "1.1.0", date: "2026-08-25", changes: [{ category: "Added", items: ["New thing"] }] },
    { version: "1.0.0", date: "2026-08-01", changes: [{ category: "Added", items: ["First"] }] },
  ],
};

function mockSession(isPlatformAdmin: boolean | undefined) {
  mockUseSession.mockReturnValue({
    data:
      isPlatformAdmin === undefined
        ? null
        : { user: { id: "1", isPlatformAdmin, mustChangePassword: false }, expires: "" },
    status: isPlatformAdmin === undefined ? "unauthenticated" : "authenticated",
    update: vi.fn(),
  } as unknown as ReturnType<typeof useSession>);
}

describe("useChangelogCheck", () => {
  beforeEach(() => {
    localStorage.clear();
    global.fetch = vi.fn().mockResolvedValue({
      json: () => Promise.resolve(CHANGELOG_DATA),
    }) as unknown as typeof fetch;
  });

  it("stays disabled for a non-platform-admin user", async () => {
    mockSession(false);
    const { result } = renderHook(() => useChangelogCheck());

    await waitFor(() => expect(result.current.version).toBe("1.1.0"));

    expect(result.current.newVersionAvailable).toBe(false);
    expect(result.current.unseenChangelogs).toEqual([]);
  });

  it("shows all entries on first visit for a platform admin", async () => {
    mockSession(true);
    const { result } = renderHook(() => useChangelogCheck());

    await waitFor(() => expect(result.current.newVersionAvailable).toBe(true));
    expect(result.current.unseenChangelogs.map((e) => e.version)).toEqual(["1.1.0", "1.0.0"]);
  });

  it("shows nothing once the current version has been marked as seen", async () => {
    localStorage.setItem("polyant-last-seen-version", "1.1.0");
    mockSession(true);
    const { result } = renderHook(() => useChangelogCheck());

    await waitFor(() => expect(result.current.version).toBe("1.1.0"));
    expect(result.current.newVersionAvailable).toBe(false);
  });

  it("markAsSeen persists the current version and clears the flag", async () => {
    mockSession(true);
    const { result } = renderHook(() => useChangelogCheck());

    await waitFor(() => expect(result.current.newVersionAvailable).toBe(true));

    act(() => result.current.markAsSeen());

    expect(result.current.newVersionAvailable).toBe(false);
    expect(localStorage.getItem("polyant-last-seen-version")).toBe("1.1.0");
  });
});
