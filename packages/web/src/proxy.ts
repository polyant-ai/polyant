// SPDX-License-Identifier: AGPL-3.0-or-later

import NextAuth from "next-auth";
import { authConfig } from "@/lib/auth.config";

export default NextAuth(authConfig).auth;

export const config = {
  // Mirrors the former middleware.ts matcher (Next 16 renamed middleware→proxy):
  // exclude `api` and `v1` (the OpenAI-compatible completion API, rewritten to the
  // engine in next.config.ts) so proxied API routes are NOT gated by the web
  // session — the engine authenticates `/v1` with per-instance API keys. Static
  // assets and any path with a file extension are excluded too.
  matcher: [
    "/((?!api|v1|_next/static|_next/image|favicon.ico|.*\\.).*)",
  ],
};
