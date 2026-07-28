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

  it("should_reject_normalized_decimal_ipv4_in_prod", () => {
    expect(() => assertSafeMcpUrl("https://2130706433/mcp", prodEnv)).toThrow();
  });

  it("should_reject_ipv4_mapped_ipv6_metadata_and_loopback_in_prod", () => {
    // new URL().hostname normalizes these to the hex form "[::ffff:a9fe:a9fe]" /
    // "[::ffff:7f00:1]" — the embedded IPv4 (169.254.169.254 / 127.0.0.1) must
    // still be caught.
    expect(() => assertSafeMcpUrl("https://[::ffff:169.254.169.254]/mcp", prodEnv)).toThrow();
    expect(() => assertSafeMcpUrl("https://[::ffff:127.0.0.1]/mcp", prodEnv)).toThrow();
  });

  it("should_reject_unspecified_addresses_in_prod", () => {
    expect(() => assertSafeMcpUrl("https://0.0.0.0/mcp", prodEnv)).toThrow();
    expect(() => assertSafeMcpUrl("https://[::]/mcp", prodEnv)).toThrow();
  });

  it("should_reject_the_full_fc00_7_ula_range_in_prod", () => {
    // The old regex only matched the literal "fc00:" prefix, missing the rest
    // of the fc00::/7 block (fc01-fcff, and all of fd00-fdff).
    expect(() => assertSafeMcpUrl("https://[fd00::1]/mcp", prodEnv)).toThrow();
  });

  it("should_reject_a_trailing_dot_fqdn_in_prod", () => {
    // "localhost." is the FQDN-root form and resolves like "localhost", so the
    // denylist has to normalize the trailing dot away before matching.
    expect(() => assertSafeMcpUrl("https://localhost./mcp", prodEnv)).toThrow();
  });

  it("should_reject_non_http_scheme", () => {
    expect(() => assertSafeMcpUrl("file:///etc/passwd")).toThrow();
  });
});
