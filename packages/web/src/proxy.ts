// SPDX-License-Identifier: AGPL-3.0-or-later

import NextAuth from "next-auth";
import { authConfig } from "@/lib/auth.config";

export default NextAuth(authConfig).auth;

export const config = {
  // Mirrors the former middleware.ts matcher (Next 16 renamed middleware→proxy):
  // exclude `api` (and `/v1` completion) so proxied/API routes are NOT gated by
  // the web session, plus static assets and any path with a file extension.
  matcher: [
    "/((?!api|_next/static|_next/image|favicon.ico|.*\\.).*)",
  ],
};
