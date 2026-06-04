// SPDX-License-Identifier: AGPL-3.0-or-later

import type { NextRequest } from "next/server";
import { handlers } from "@/lib/auth";

// Next 16 type-checks route handlers against RouteHandlerConfig (the dynamic
// `params` is now a Promise). Auth.js v5's destructured handlers don't satisfy
// that constraint, so we wrap them in plain handlers that delegate to next-auth
// unchanged (next-auth routes internally from the request URL — no params used).
export function GET(req: NextRequest) {
  return handlers.GET(req);
}

export function POST(req: NextRequest) {
  return handlers.POST(req);
}
