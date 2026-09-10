// SPDX-License-Identifier: AGPL-3.0-or-later

"use client";

import { useState } from "react";
import { useSearchParams } from "next/navigation";
import { signIn } from "next-auth/react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useI18n } from "@/lib/i18n/context";

/**
 * Accept only same-origin relative paths as a post-login destination.
 *
 * SECURITY: prevents an open-redirect phishing primitive on `/login`
 * (`/login?callbackUrl=https://evil.com`). We require a leading `/` AND
 * forbid `//…` (protocol-relative URLs) and backslashes (Windows-style
 * paths some browsers normalise to `//host`). Anything else collapses
 * to `/` so the user lands on the dashboard.
 */
function safeRelativeCallback(raw: string | null): string {
  if (!raw) return "/";
  if (!raw.startsWith("/")) return "/";
  if (raw.startsWith("//") || raw.startsWith("/\\")) return "/";
  return raw;
}

export function LoginFormClient() {
  const { t } = useI18n();
  const params = useSearchParams();
  const callbackUrl = safeRelativeCallback(params.get("callbackUrl"));

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleCredentials(e: React.FormEvent) {
    e.preventDefault();
    if (!email.trim() || !password) return;
    setError(null);
    setSubmitting(true);
    try {
      const res = await signIn("credentials", {
        email: email.trim(),
        password,
        redirect: false,
      });
      if (res?.error) {
        setError(t("login.invalidCredentials"));
      } else if (res?.ok) {
        // Hard reload so the middleware sees the new cookie and applies any
        // mustChangePassword redirect on the next request.
        window.location.assign(callbackUrl || "/");
      }
    } catch {
      setError(t("login.invalidCredentials"));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="flex w-full max-w-sm flex-col items-center gap-6">
      <div className="text-center">
        <h1 className="text-3xl font-semibold tracking-tight">{t("login.title")}</h1>
        <p className="mt-2 text-muted-foreground">{t("login.subtitle")}</p>
      </div>

      <form onSubmit={handleCredentials} className="flex w-full flex-col gap-3">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="email">{t("login.email")}</Label>
          <Input
            id="email"
            type="email"
            autoComplete="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@example.com"
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="password">{t("login.password")}</Label>
          <Input
            id="password"
            type="password"
            autoComplete="current-password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </div>
        {error && (
          <p className="text-sm text-destructive" role="alert">
            {error}
          </p>
        )}
        <Button type="submit" className="w-full" disabled={submitting}>
          {submitting ? t("login.signingIn") : t("login.signIn")}
        </Button>
      </form>
    </div>
  );
}
