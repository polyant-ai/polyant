import type { PersistedUserRole } from "@/lib/user-role";

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
      role: PersistedUserRole;
      mustChangePassword: boolean;
      orgId?: string;
    };
  }

  interface User {
    role?: PersistedUserRole;
    mustChangePassword?: boolean;
  }
}

declare module "next-auth/jwt" {
  interface JWT {
    id?: string;
    role?: PersistedUserRole;
    mustChangePassword?: boolean;
    orgId?: string;
  }
}
