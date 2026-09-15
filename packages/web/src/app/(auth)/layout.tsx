// SPDX-License-Identifier: AGPL-3.0-or-later

import { LangToggle } from "@/components/layout/lang-toggle";

/**
 * The language switcher lives in the app header, which these pages never render:
 * without it, anyone who is not signed in yet is stuck on `DEFAULT_LOCALE`. It
 * writes the same `locale` key the panel reads, so the choice carries over once
 * they are signed in.
 */
export default function AuthLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="relative flex min-h-svh items-center justify-center">
      <div className="absolute right-4 top-4">
        <LangToggle />
      </div>
      {children}
    </div>
  );
}
