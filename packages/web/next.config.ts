// SPDX-License-Identifier: AGPL-3.0-or-later

import path from "node:path";

import type { NextConfig } from "next";

const ENGINE_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";

const nextConfig: NextConfig = {
  output: "standalone",
  // Build output directory. Overridable via NEXT_DIST_DIR so the E2E harness can
  // build+start into an isolated `.next-e2e` dir and coexist with a running
  // `next dev` (which holds `.next`). Defaults to the standard `.next`.
  distDir: process.env.NEXT_DIST_DIR ?? ".next",
  // Pin the Turbopack workspace root to the monorepo root. In the Docker build
  // the builder stage copies the hoisted node_modules to /app/node_modules but
  // not the lockfile, so Next 16's automatic root inference fails to resolve
  // `next/package.json` and aborts. This config lives at packages/web/, so the
  // monorepo root is two levels up.
  turbopack: {
    root: path.join(import.meta.dirname, "..", ".."),
  },
  async rewrites() {
    return [
      // Proxy engine API calls — forwards cookies (including Auth.js session token)
      { source: "/api/instances/:path*", destination: `${ENGINE_URL}/api/instances/:path*` },
      { source: "/api/organizations/:path*", destination: `${ENGINE_URL}/api/organizations/:path*` },
      { source: "/api/conversations/:path*", destination: `${ENGINE_URL}/api/conversations/:path*` },
      { source: "/api/analytics/:path*", destination: `${ENGINE_URL}/api/analytics/:path*` },
      { source: "/api/skills/:path*", destination: `${ENGINE_URL}/api/skills/:path*` },
      { source: "/api/tools/:path*", destination: `${ENGINE_URL}/api/tools/:path*` },
      { source: "/api/tools", destination: `${ENGINE_URL}/api/tools` },
      { source: "/api/attachments/:path*", destination: `${ENGINE_URL}/api/attachments/:path*` },
      { source: "/api/audit-logs/:path*", destination: `${ENGINE_URL}/api/audit-logs/:path*` },
      { source: "/api/users/:path*", destination: `${ENGINE_URL}/api/users/:path*` },
      { source: "/api/users", destination: `${ENGINE_URL}/api/users` },
      { source: "/api/me/:path*", destination: `${ENGINE_URL}/api/me/:path*` },
      { source: "/api/activity-stream/:path*", destination: `${ENGINE_URL}/api/activity-stream/:path*` },
      { source: "/memories/:path*", destination: `${ENGINE_URL}/memories/:path*` },
      { source: "/health", destination: `${ENGINE_URL}/health` },
      { source: "/v1/:path*", destination: `${ENGINE_URL}/v1/:path*` },
    ];
  },
  async headers() {
    const isProd = process.env.NODE_ENV === "production";

    // Baseline headers — safe in every environment.
    const baseHeaders = [
      { key: "X-Content-Type-Options", value: "nosniff" },
      { key: "X-Frame-Options", value: "DENY" },
      { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
    ];

    // HSTS + CSP are production-only:
    // - HSTS on localhost http:// is a no-op anyway, and on a misconfigured
    //   dev https setup it would lock the browser to https for two years.
    // - CSP `script-src 'self'` breaks Next.js dev hot-reload (inline scripts
    //   without nonce). In production Next.js still emits inline scripts for
    //   hydration, so we need `'unsafe-inline'` to keep the app working;
    //   tightening this to a strict nonce-based policy is a separate task.
    const prodHeaders = isProd
      ? [
          { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains; preload" },
          {
            key: "Content-Security-Policy",
            value:
              "default-src 'self'; " +
              "script-src 'self' 'unsafe-inline' 'unsafe-eval'; " +
              "style-src 'self' 'unsafe-inline'; " +
              "img-src 'self' https: data:; " +
              "font-src 'self' data:; " +
              "connect-src 'self' https:; " +
              "frame-ancestors 'none'",
          },
        ]
      : [];

    return [
      {
        source: "/(.*)",
        headers: [...baseHeaders, ...prodHeaders],
      },
    ];
  },
};

export default nextConfig;
