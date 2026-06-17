// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Auth.js configuration — Edge-compatible (no Node.js modules).
 * Used by middleware.ts which runs in Edge Runtime.
 * The full auth.ts re-exports this config with the Drizzle DB adapter added.
 */
import type { NextAuthConfig } from "next-auth";
import type { Provider } from "@auth/core/providers";
import Google from "next-auth/providers/google";
import Credentials from "next-auth/providers/credentials";

const ENGINE_URL = process.env.INTERNAL_ENGINE_URL ?? "http://localhost:4000";

/**
 * Build the providers list dynamically so that Google is included ONLY when
 * both `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` are set. Previously the
 * code used `process.env.GOOGLE_CLIENT_ID!` (non-null assertion), which made
 * the provider construct with `undefined` at runtime in OSS deploys that
 * intentionally rely on credentials login only — the Google sign-in button
 * would then crash on click. Skipping the provider entirely is safer and
 * mirrors what the login page already does (`signIn("google", ...)` returns
 * "OAuthAccountNotLinked"-style failure gracefully if Google isn't loaded).
 */
function buildProviders(): Provider[] {
  const providers: Provider[] = [];

  const googleId = process.env.GOOGLE_CLIENT_ID;
  const googleSecret = process.env.GOOGLE_CLIENT_SECRET;
  if (googleId && googleSecret) {
    providers.push(
      Google({
        clientId: googleId,
        clientSecret: googleSecret,
        authorization: { params: { prompt: "select_account" } },
      }),
    );
  } else {
    console.warn(
      "[auth] GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET not set — Google sign-in is disabled. " +
        "Set both to enable it, or leave empty to rely on email/password only.",
    );
  }

  providers.push(
    Credentials({
      name: "Email e Password",
      credentials: {
        email: { label: "Email", type: "email" },
        password: { label: "Password", type: "password" },
      },
      async authorize(creds) {
        const email = String(creds?.email ?? "").trim().toLowerCase();
        const password = String(creds?.password ?? "");
        if (!email || !password) return null;
        const user = await verifyCredentials(email, password);
        if (!user) return null;
        return {
          id: user.id,
          email: user.email,
          name: user.name ?? undefined,
          image: user.image ?? undefined,
          // Carry role + mustChangePassword in the user object so the jwt
          // callback below can persist them in the token.
          role: user.role,
          mustChangePassword: user.mustChangePassword,
        };
      },
    }),
  );

  return providers;
}

/** Exposed so UI can show/hide the Google sign-in button. */
export const isGoogleAuthEnabled =
  !!process.env.GOOGLE_CLIENT_ID && !!process.env.GOOGLE_CLIENT_SECRET;

interface CredentialsUser {
  id: string;
  email: string;
  name: string | null;
  image: string | null;
  role: "superadmin" | "user";
  mustChangePassword: boolean;
}

async function verifyCredentials(
  email: string,
  password: string,
): Promise<CredentialsUser | null> {
  const internalSecret = process.env.AUTH_INTERNAL_SECRET;
  if (!internalSecret) {
    // Fail closed: without the shared secret the engine endpoint is disabled,
    // and we can't verify credentials. Returning null surfaces as "credenziali
    // non valide" to the user — admins fix it via env config.
    console.error("[auth] AUTH_INTERNAL_SECRET is not set — credentials login disabled");
    return null;
  }

  try {
    const res = await fetch(`${ENGINE_URL}/api/auth/credentials/verify`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-internal-auth": internalSecret,
      },
      body: JSON.stringify({ email, password }),
    });

    if (!res.ok) return null;
    const body = (await res.json()) as { user: CredentialsUser | null };
    return body.user ?? null;
  } catch (err) {
    console.error("[auth] credentials verify failed", err);
    return null;
  }
}

export const authConfig = {
  providers: buildProviders(),
  session: {
    strategy: "jwt",
    // 24h (was the Auth.js 30d default). A shorter TTL bounds the window in
    // which a stale identity claim (e.g. revoked membership / platform-admin)
    // survives in the JWT, since JWT sessions have no immediate server-side
    // revocation.
    maxAge: 24 * 60 * 60,
  },
  pages: {
    signIn: "/login",
  },
  callbacks: {
    signIn({ account, profile }) {
      // Optional domain allowlist: set AUTH_ALLOWED_DOMAINS to a comma-separated
      // list (e.g. "mycompany.com,partner.com") to restrict Google sign-in to
      // users whose email ends with one of those domains. Leave unset to allow
      // any Google account. Credentials login bypasses this check.
      if (account?.provider === "google") {
        const allowList = (process.env.AUTH_ALLOWED_DOMAINS ?? "")
          .split(",")
          .map((d) => d.trim().toLowerCase())
          .filter(Boolean);
        if (allowList.length > 0) {
          const email = (profile?.email ?? "").toLowerCase();
          const allowed = allowList.some((domain) => email.endsWith(`@${domain}`));
          if (!allowed) return false;
        }
      }
      return true;
    },
    jwt({ token, user, trigger, session }) {
      // `user` is only present on the first call (right after sign-in).
      // We snapshot id, role, mustChangePassword into the token so subsequent
      // requests don't need a DB lookup. The token is encrypted (JWE) and
      // re-issued on every request, so it stays in sync as long as we don't
      // need immediate revocation (documented JWT trade-off).
      if (user) {
        token.id = (user as { id?: string }).id ?? token.id;
        const u = user as Partial<CredentialsUser>;
        if (u.role) token.role = u.role;
        if (typeof u.mustChangePassword === "boolean") {
          token.mustChangePassword = u.mustChangePassword;
        }
      }
      // Allow the client to refresh fields after a self-mutation
      // (e.g. /settings/password) via `useSession().update({...})`.
      //
      // SECURITY: never accept `role` from the client update patch. Role
      // changes must only land via a DB read on the next sign-in cycle.
      // Trusting client-supplied roles here let any authenticated user
      // become superadmin by POSTing {role: "superadmin"} to
      // `/api/auth/session` (which Auth.js v5 exposes by default).
      if (trigger === "update" && session && typeof session === "object") {
        const patch = session as { mustChangePassword?: boolean };
        if (typeof patch.mustChangePassword === "boolean") {
          token.mustChangePassword = patch.mustChangePassword;
        }
      }
      // For Google logins (no role on the user object) default to "user" —
      // a superadmin can promote them later from /users.
      if (!token.role) token.role = "user";
      if (typeof token.mustChangePassword !== "boolean") {
        token.mustChangePassword = false;
      }
      return token;
    },
    session({ session, token }) {
      if (session.user) {
        if (token.id) session.user.id = token.id as string;
        (session.user as { role?: string }).role = (token.role as string) ?? "user";
        (session.user as { mustChangePassword?: boolean }).mustChangePassword =
          token.mustChangePassword === true;
        // Surface the resolved org so server components / API proxying can read
        // it. Stamped into the token by the Node-side jwt callback (auth.ts).
        session.user.orgId = token.orgId;
      }
      return session;
    },
    authorized({ auth, request: { nextUrl } }) {
      const isLoggedIn = !!auth?.user;
      const isLoginPage = nextUrl.pathname === "/login";
      const isAuthApi = nextUrl.pathname.startsWith("/api/auth");
      const isForcedChangePage = nextUrl.pathname === "/password-change";

      if (isAuthApi) return true;

      if (isLoginPage) {
        if (isLoggedIn) return Response.redirect(new URL("/", nextUrl));
        return true;
      }

      if (!isLoggedIn) {
        const loginUrl = new URL("/login", nextUrl);
        loginUrl.searchParams.set("callbackUrl", nextUrl.pathname);
        return Response.redirect(loginUrl);
      }

      // Forced password change: if the JWT carries mustChangePassword, lock
      // the user into the dedicated full-screen page (no sidebar, no other
      // routes accessible) until they rotate the credential.
      const mustChange = (auth?.user as { mustChangePassword?: boolean } | undefined)
        ?.mustChangePassword === true;
      if (mustChange && !isForcedChangePage) {
        return Response.redirect(new URL("/password-change", nextUrl));
      }
      // Conversely, once the user no longer needs to rotate, /password-change
      // is no longer relevant — bounce them back to the home page.
      if (!mustChange && isForcedChangePage) {
        return Response.redirect(new URL("/", nextUrl));
      }

      return true;
    },
  },
  trustHost: process.env.AUTH_TRUST_HOST === "true",
} satisfies NextAuthConfig;
