// SPDX-License-Identifier: AGPL-3.0-or-later

import { render, type RenderOptions } from "@testing-library/react";
import { type ReactElement } from "react";
import { I18nProvider } from "@/lib/i18n/context";

function AllProviders({ children }: { children: React.ReactNode }) {
  return <I18nProvider initialLocale="it">{children}</I18nProvider>;
}

/** Render with all app providers (I18n, etc.). */
export function renderWithProviders(
  ui: ReactElement,
  options?: Omit<RenderOptions, "wrapper">,
) {
  return render(ui, { wrapper: AllProviders, ...options });
}

export { render } from "@testing-library/react";
export { default as userEvent } from "@testing-library/user-event";
