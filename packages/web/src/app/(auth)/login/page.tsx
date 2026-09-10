// SPDX-License-Identifier: AGPL-3.0-or-later

import { Suspense } from "react";
import { LoginFormClient } from "./login-form-client";

/**
 * Server entry for the login page.
 *
 * It used to be `force-dynamic` so that a flag read from the server environment
 * (`GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`, injected at container start and
 * absent during the Docker build) was not baked into a prerendered page. This
 * edition offers no federated provider, so there is no such flag and no reason
 * to opt out of prerendering.
 */
export default function LoginPage() {
  return (
    <Suspense fallback={null}>
      <LoginFormClient />
    </Suspense>
  );
}
