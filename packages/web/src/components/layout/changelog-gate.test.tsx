// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The changelog dialog used to open on top of the first-access wizard and tours
 * (a Platform Admin on a fresh install has both pending). It now waits.
 */

import { render, screen } from "@testing-library/react";

const h = vi.hoisted(() => ({ busy: { value: false } }));

vi.mock("@/hooks/use-changelog-check", () => ({
  useChangelogCheck: () => ({
    version: "1.2.0",
    newVersionAvailable: true,
    unseenChangelogs: [],
    markAsSeen: () => {},
  }),
}));
vi.mock("@/lib/onboarding/onboarding-context", () => ({ useOnboardingBusy: () => h.busy.value }));

import { I18nProvider } from "@/lib/i18n/context";
import { ChangelogUpdateModal } from "./changelog-update-modal";

const mount = () =>
  render(
    <I18nProvider initialLocale="en">
      <ChangelogUpdateModal />
    </I18nProvider>,
  );

describe("changelog dialog and first-access guidance", () => {
  it("opens when no guidance is on screen", () => {
    h.busy.value = false;
    mount();
    expect(screen.getByRole("dialog", { name: "What's new in this version" })).toBeInTheDocument();
  });

  it("stays closed while the wizard or a tour is open or pending", () => {
    h.busy.value = true;
    mount();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
});
