// SPDX-License-Identifier: AGPL-3.0-or-later

"use client";

import { createContext, useContext, type ReactNode } from "react";
import { createPortal } from "react-dom";

const Slot = createContext<HTMLElement | null>(null);

/** The element beside the section's title where its actions are drawn; the agent page provides it. */
export const SectionActionsSlot = Slot.Provider;

/**
 * A section's own buttons (enable, add, copy all), drawn to the right of the
 * section's title by the page — one place and one size for every section,
 * instead of each section laying out its own row above its content. Outside
 * the agent page (a test, another host) they render in place.
 */
export function SectionActions({ children }: { children: ReactNode }) {
  const slot = useContext(Slot);
  if (!slot) return <div className="mb-6 flex flex-wrap justify-end gap-2">{children}</div>;
  return createPortal(children, slot);
}
