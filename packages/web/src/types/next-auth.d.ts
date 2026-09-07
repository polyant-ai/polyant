// SPDX-License-Identifier: AGPL-3.0-or-later

import "next-auth";
import "next-auth/jwt";

declare module "next-auth" {
  interface Session {
    user: {
      id: string;
      email?: string | null;
      name?: string | null;
      image?: string | null;
      // PRESENTATION HINT ONLY. No server-side authorization decision may read
      // this — the `users.is_platform_admin` DB column is the sole authority,
      // read per request. This field only lets the client show/hide UI.
      isPlatformAdmin: boolean;
      mustChangePassword: boolean;
      orgId?: string;
    };
  }

  interface User {
    isPlatformAdmin?: boolean;
    mustChangePassword?: boolean;
  }
}

declare module "next-auth/jwt" {
  interface JWT {
    id?: string;
    isPlatformAdmin?: boolean;
    mustChangePassword?: boolean;
    orgId?: string;
  }
}
