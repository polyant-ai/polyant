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
      role: "superadmin" | "user";
      mustChangePassword: boolean;
      orgId?: string;
    };
  }

  interface User {
    role?: "superadmin" | "user";
    mustChangePassword?: boolean;
  }
}

declare module "next-auth/jwt" {
  interface JWT {
    id?: string;
    role?: "superadmin" | "user";
    mustChangePassword?: boolean;
    orgId?: string;
  }
}
