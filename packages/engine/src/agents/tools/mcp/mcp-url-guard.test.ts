// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect } from "vitest";
import { assertSafeMcpUrl } from "./mcp-url-guard.js";

// No config.js mock needed: assertSafeMcpUrl takes an injectable `env` param
// (same testable pattern as getCorsOptions/getLogLevels in server/main.ts),
// so prod-mode is exercised by passing a fake env instead of a config double.
const prodEnv = { NODE_ENV: "production" } as NodeJS.ProcessEnv;

describe("assertSafeMcpUrl", () => {
  it("should_reject_private_host_in_prod", () => {
    expect(() => assertSafeMcpUrl("https://10.0.0.5/mcp", prodEnv)).toThrow();
    expect(() => assertSafeMcpUrl("http://localhost:4000/mcp", prodEnv)).toThrow();
    expect(() => assertSafeMcpUrl("https://192.168.1.9/mcp", prodEnv)).toThrow();
  });

  it("should_allow_public_https", () => {
    expect(() => assertSafeMcpUrl("https://mcp.example.com/sse", prodEnv)).not.toThrow();
  });

  it("should_reject_bracketed_ipv6_private_host_in_prod", () => {
    expect(() => assertSafeMcpUrl("https://[::1]/mcp", prodEnv)).toThrow();
    expect(() => assertSafeMcpUrl("https://[fe80::1]/mcp", prodEnv)).toThrow();
    expect(() => assertSafeMcpUrl("https://[fc00::1]/mcp", prodEnv)).toThrow();
  });

  it("should_reject_non_http_scheme", () => {
    expect(() => assertSafeMcpUrl("file:///etc/passwd")).toThrow();
  });
});
