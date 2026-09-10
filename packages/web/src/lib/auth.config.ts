// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Auth.js configuration — Edge-compatible (no Node.js modules).
 * Used by middleware.ts which runs in Edge Runtime.
 * The full auth.ts re-exports this config with the Drizzle DB adapter added.
 */
import type { NextAuthConfig } from "next-auth";
import type { Provider } from "@auth/core/providers";
import Credentials from "next-auth/providers/credentials";
import { federatedProviders } from "./auth-providers";

const ENGINE_URL = process.env.INTERNAL_ENGINE_URL ?? "http://localhost:4000";

/**
 * The providers this build offers: whatever federated providers the edition
 * supplies (none here — see `auth-providers.ts`) plus email and password.
 *
 * The federated half is a seam on purpose. It used to be a Google provider
 * built inline from `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`, guarded so a
 * half-configured deployment did not construct it with `undefined` and crash on
 * the first click. Single sign-on is an enterprise capability now, so the guard
 * has nothing left to guard and this file no longer names a provider it cannot
 * offer.
 */
function buildProviders(): Provider[] {
  return [
    ...federatedProviders(),
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
          // Carry isPlatformAdmin + mustChangePassword in the user object so
          // the jwt callback below can persist them in the token.
          isPlatformAdmin: user.isPlatformAdmin,
          mustChangePassword: user.mustChangePassword,
        };
      },
    }),
  ];
}

interface CredentialsUser {
  id: string;
  email: string;
  name: string | null;
  image: string | null;
  isPlatformAdmin: boolean;
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
    // NOTE: the per-org sign-in domain allowlist (RBAC Stream 8) lives in the
    // Node `auth.ts` `signIn` callback, NOT here. This Edge config runs in the
    // Edge Runtime (middleware) where reading allowlist env + onboarding logic
    // belongs in the Node runtime. `auth.ts` overrides `signIn` with the
    // authoritative check; this file intentionally omits it.
    jwt({ token, user, trigger, session }) {
      // `user` is only present on the first call (right after sign-in).
      // We snapshot id, isPlatformAdmin, mustChangePassword into the token so
      // subsequent requests don't need a DB lookup. The token is encrypted
      // (JWE) and re-issued on every request, so it stays in sync as long as
      // we don't need immediate revocation (documented JWT trade-off).
      if (user) {
        token.id = (user as { id?: string }).id ?? token.id;
        const u = user as Partial<CredentialsUser>;
        if (typeof u.isPlatformAdmin === "boolean") token.isPlatformAdmin = u.isPlatformAdmin;
        if (typeof u.mustChangePassword === "boolean") {
          token.mustChangePassword = u.mustChangePassword;
        }
      }
      // Allow the client to refresh fields after a self-mutation
      // (e.g. /settings/password) via `useSession().update({...})`.
      //
      // SECURITY: never accept `isPlatformAdmin` from the client update patch.
      // Platform-admin standing must only land via a DB read on the next
      // sign-in cycle. Trusting a client-supplied flag here let any
      // authenticated user become a platform admin by POSTing
      // {isPlatformAdmin: true} to `/api/auth/session` (which Auth.js v5
      // exposes by default).
      if (trigger === "update" && session && typeof session === "object") {
        const patch = session as { mustChangePassword?: boolean };
        if (typeof patch.mustChangePassword === "boolean") {
          token.mustChangePassword = patch.mustChangePassword;
        }
      }
      // Default to false when the user object carries no standing — a platform
      // admin can promote them later from /users.
      if (typeof token.isPlatformAdmin !== "boolean") token.isPlatformAdmin = false;
      if (typeof token.mustChangePassword !== "boolean") {
        token.mustChangePassword = false;
      }
      return token;
    },
    session({ session, token }) {
      if (session.user) {
        if (token.id) session.user.id = token.id as string;
        // PRESENTATION HINT ONLY — see the Session.user.isPlatformAdmin doc
        // comment in next-auth.d.ts. No server-side authorization decision
        // may read this; the DB flag is the sole authority.
        session.user.isPlatformAdmin = token.isPlatformAdmin === true;
        session.user.mustChangePassword = token.mustChangePassword === true;
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
        // Carry the query string, not just the path: a bookmarked tenant-scoped
        // deep link must survive the sign-in round trip unchanged.
        loginUrl.searchParams.set("callbackUrl", nextUrl.pathname + nextUrl.search);
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
