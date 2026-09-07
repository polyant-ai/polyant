// SPDX-License-Identifier: AGPL-3.0-or-later

import { assertSafeUrl, pinnedLookup } from "./url-safety.js";

const { mockLookup } = vi.hoisted(() => ({
  mockLookup: vi.fn(),
}));

vi.mock("dns/promises", () => ({
  lookup: mockLookup,
}));

beforeEach(() => {
  mockLookup.mockReset();
  // Default: resolve to a public IP so DNS check passes
  mockLookup.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
});

// ---------------------------------------------------------------------------
// 1. Blocked protocols
// ---------------------------------------------------------------------------
describe("blocked protocols", () => {
  it("rejects ftp:// protocol", async () => {
    const url = new URL("ftp://example.com/file");
    await expect(assertSafeUrl(url)).rejects.toThrow(
      "Blocked: protocol ftp: not allowed",
    );
  });

  it("rejects file:// protocol", async () => {
    const url = new URL("file:///etc/passwd");
    await expect(assertSafeUrl(url)).rejects.toThrow(
      "Blocked: protocol file: not allowed",
    );
  });

  it("rejects data: protocol", async () => {
    const url = new URL("data:text/plain;base64,SGVsbG8=");
    await expect(assertSafeUrl(url)).rejects.toThrow(
      "Blocked: protocol data: not allowed",
    );
  });
});

// ---------------------------------------------------------------------------
// 2. Blocked hostnames
// ---------------------------------------------------------------------------
describe("blocked hostnames", () => {
  it("rejects localhost", async () => {
    const url = new URL("https://localhost/path");
    await expect(assertSafeUrl(url)).rejects.toThrow(
      'Blocked: hostname "localhost" not allowed',
    );
  });

  it("rejects metadata.google.internal", async () => {
    const url = new URL("http://metadata.google.internal/computeMetadata/v1/");
    await expect(assertSafeUrl(url)).rejects.toThrow(
      'Blocked: hostname "metadata.google.internal" not allowed',
    );
  });

  it("rejects 169.254.169.254 (cloud metadata endpoint)", async () => {
    const url = new URL("http://169.254.169.254/");
    await expect(assertSafeUrl(url)).rejects.toThrow(
      'Blocked: hostname "169.254.169.254" not allowed',
    );
  });

  it("rejects localhost regardless of case (URL normalizes to lowercase)", async () => {
    // The URL constructor lowercases hostnames, so this tests the real path
    const url = new URL("https://LOCALHOST/path");
    await expect(assertSafeUrl(url)).rejects.toThrow(
      'hostname "localhost" not allowed',
    );
  });
});

// ---------------------------------------------------------------------------
// 3. Private IPv4 addresses (direct in URL)
// ---------------------------------------------------------------------------
describe("private IPv4 addresses", () => {
  const cases: [string, string][] = [
    ["127.0.0.1", "loopback"],
    ["127.255.255.255", "loopback (high end)"],
    ["10.0.0.1", "class A private"],
    ["10.255.255.255", "class A private (high end)"],
    ["172.16.0.1", "class B private (low end)"],
    ["172.31.255.255", "class B private (high end)"],
    ["192.168.1.1", "class C private"],
    ["192.168.255.255", "class C private (high end)"],
    ["169.254.0.1", "link-local"],
    ["0.0.0.0", "unspecified address"],
  ];

  it.each(cases)("rejects %s (%s)", async (ip) => {
    const url = new URL(`http://${ip}/`);
    await expect(assertSafeUrl(url)).rejects.toThrow(
      `Blocked: private/reserved IP "${ip}"`,
    );
  });

  it("allows public IP 93.184.216.34", async () => {
    const url = new URL("http://93.184.216.34/");
    await expect(assertSafeUrl(url)).resolves.toEqual(expect.objectContaining({ address: expect.any(String) }));
  });
});

// ---------------------------------------------------------------------------
// 4. Private IPv6 addresses
// ---------------------------------------------------------------------------
describe("private IPv6 addresses", () => {
  // Note: URL constructor wraps IPv6 in brackets (e.g. [::1]), so the regex
  // patterns in isPrivateIP don't match url.hostname directly. The protection
  // for IPv6 comes from DNS resolution catching the resolved address.

  it("rejects IPv6 loopback when DNS resolves to ::1", async () => {
    mockLookup.mockResolvedValue([{ address: "::1", family: 6 }]);
    const url = new URL("http://evil.example.com/");
    await expect(assertSafeUrl(url)).rejects.toThrow(
      'resolves to private IP ::1',
    );
  });

  it("rejects IPv6 unique local when DNS resolves to fd00::1", async () => {
    mockLookup.mockResolvedValue([{ address: "fd00::1", family: 6 }]);
    const url = new URL("http://evil.example.com/");
    await expect(assertSafeUrl(url)).rejects.toThrow(
      "resolves to private IP fd00::1",
    );
  });

  it("rejects IPv6 link-local when DNS resolves to fe80::1", async () => {
    mockLookup.mockResolvedValue([{ address: "fe80::1", family: 6 }]);
    const url = new URL("http://evil.example.com/");
    await expect(assertSafeUrl(url)).rejects.toThrow(
      "resolves to private IP fe80::1",
    );
  });
});

// ---------------------------------------------------------------------------
// 5. Public URL passes
// ---------------------------------------------------------------------------
describe("public URLs", () => {
  it("allows https://example.com", async () => {
    mockLookup.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
    const url = new URL("https://example.com");
    await expect(assertSafeUrl(url)).resolves.toEqual(expect.objectContaining({ address: expect.any(String) }));
  });

  it("allows http://example.com", async () => {
    mockLookup.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
    const url = new URL("http://example.com");
    await expect(assertSafeUrl(url)).resolves.toEqual(expect.objectContaining({ address: expect.any(String) }));
  });

  it("allows https://example.com with path and query", async () => {
    mockLookup.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
    const url = new URL("https://example.com/path?query=1#hash");
    await expect(assertSafeUrl(url)).resolves.toEqual(expect.objectContaining({ address: expect.any(String) }));
  });
});

// ---------------------------------------------------------------------------
// 6. DNS resolves to private IP (DNS rebinding / SSRF)
// ---------------------------------------------------------------------------
describe("DNS resolves to private IP", () => {
  it("rejects hostname that resolves to 127.0.0.1", async () => {
    mockLookup.mockResolvedValue([{ address: "127.0.0.1", family: 4 }]);
    const url = new URL("https://evil.com/steal");
    await expect(assertSafeUrl(url)).rejects.toThrow(
      'Blocked: "evil.com" resolves to private IP 127.0.0.1',
    );
  });

  it("rejects hostname that resolves to 10.0.0.1", async () => {
    mockLookup.mockResolvedValue([{ address: "10.0.0.1", family: 4 }]);
    const url = new URL("https://sneaky.example.com/");
    await expect(assertSafeUrl(url)).rejects.toThrow(
      'Blocked: "sneaky.example.com" resolves to private IP 10.0.0.1',
    );
  });

  it("rejects hostname that resolves to 192.168.1.1", async () => {
    mockLookup.mockResolvedValue([{ address: "192.168.1.1", family: 4 }]);
    const url = new URL("https://internal.corp.com/admin");
    await expect(assertSafeUrl(url)).rejects.toThrow(
      'Blocked: "internal.corp.com" resolves to private IP 192.168.1.1',
    );
  });

  it("rejects hostname that resolves to 169.254.169.254 (cloud metadata)", async () => {
    mockLookup.mockResolvedValue([{ address: "169.254.169.254", family: 4 }]);
    const url = new URL("https://metadata-alias.example.com/");
    await expect(assertSafeUrl(url)).rejects.toThrow(
      'Blocked: "metadata-alias.example.com" resolves to private IP 169.254.169.254',
    );
  });
});

// ---------------------------------------------------------------------------
// 7. DNS failure (ENOTFOUND) → blocked
// ---------------------------------------------------------------------------
describe("DNS failure", () => {
  it("blocks when DNS lookup throws ENOTFOUND", async () => {
    const err = new Error("getaddrinfo ENOTFOUND nonexistent.example.com");
    (err as NodeJS.ErrnoException).code = "ENOTFOUND";
    mockLookup.mockRejectedValue(err);

    const url = new URL("https://nonexistent.example.com/");
    await expect(assertSafeUrl(url)).rejects.toThrow(
      'Blocked: unable to resolve hostname "nonexistent.example.com"',
    );
  });

  it("blocks when DNS lookup throws a generic error", async () => {
    mockLookup.mockRejectedValue(new Error("DNS server timeout"));
    const url = new URL("https://flaky-dns.example.com/");
    await expect(assertSafeUrl(url)).rejects.toThrow(
      'Blocked: unable to resolve hostname "flaky-dns.example.com"',
    );
  });

  it("keeps the underlying DNS error as `cause` on the Blocked error", async () => {
    // The caller sees a deliberately generic "Blocked:" message (it must not
    // leak resolver internals), but the operator needs the real reason in the
    // logs. Without a `cause` the original error is lost at the throw site.
    const dnsError = new Error("getaddrinfo EAI_AGAIN slow-dns.example.com");
    (dnsError as NodeJS.ErrnoException).code = "EAI_AGAIN";
    mockLookup.mockRejectedValue(dnsError);

    await expect(assertSafeUrl(new URL("https://slow-dns.example.com/"))).rejects.toMatchObject({
      message: 'Blocked: unable to resolve hostname "slow-dns.example.com"',
      cause: dnsError,
    });
  });

  it("re-throws Blocked errors even within DNS catch block", async () => {
    // Simulate: the hostname itself is fine, but after DNS lookup we detect
    // a private IP. The "Blocked:" error should propagate, not be swallowed.
    mockLookup.mockResolvedValue([{ address: "10.0.0.1", family: 4 }]);
    const url = new URL("https://rebind.example.com/");
    await expect(assertSafeUrl(url)).rejects.toThrow("Blocked:");
  });
});

// ---------------------------------------------------------------------------
// 8. HTTPS valid (happy path)
// ---------------------------------------------------------------------------
describe("HTTPS valid", () => {
  it("passes for a normal HTTPS URL with public DNS resolution", async () => {
    mockLookup.mockResolvedValue([{ address: "151.101.1.140", family: 4 }]);
    const url = new URL("https://www.reddit.com/");
    await expect(assertSafeUrl(url)).resolves.toEqual(expect.objectContaining({ address: expect.any(String) }));
  });

  it("passes for HTTPS URL with port", async () => {
    mockLookup.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
    const url = new URL("https://example.com:8443/api");
    await expect(assertSafeUrl(url)).resolves.toEqual(expect.objectContaining({ address: expect.any(String) }));
  });

  it("calls dns lookup with the hostname", async () => {
    mockLookup.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
    const url = new URL("https://mysite.org/page");
    await assertSafeUrl(url);
    expect(mockLookup).toHaveBeenCalledWith("mysite.org", { all: true, verbatim: true });
  });

  it("rejects direct IPv6 loopback literals", async () => {
    const url = new URL("http://[::1]/");
    await expect(assertSafeUrl(url)).rejects.toThrow(
      'Blocked: private/reserved IP "[::1]"',
    );
  });
});

// ---------------------------------------------------------------------------
// Edge cases: IP ranges that should NOT be blocked
// ---------------------------------------------------------------------------
describe("non-private IPs that should pass", () => {
  const publicIPs = [
    "8.8.8.8",
    "1.1.1.1",
    "172.15.255.255", // just below 172.16.x.x range
    "172.32.0.1",     // just above 172.31.x.x range
    "192.169.0.1",    // not 192.168.x.x
    "11.0.0.1",       // not 10.x.x.x
    "100.63.255.255", // just below 100.64.0.0/10 (RFC 6598 CGNAT)
    "100.128.0.0",    // just above 100.64.0.0/10
    "192.0.1.0",      // between 192.0.0.0/24 (RFC 6890) and 192.0.2.0/24 (TEST-NET-1)
    "192.0.3.0",      // just above 192.0.2.0/24
    "198.17.255.255", // just below 198.18.0.0/15 (RFC 2544)
    "198.20.0.0",     // just above 198.18.0.0/15
    "239.255.255.255",// just below 240.0.0.0/4 (RFC 1112 Class E)
  ];

  it.each(publicIPs)("allows %s as direct IP", async (ip) => {
    mockLookup.mockResolvedValue([{ address: ip, family: 4 }]);
    const url = new URL(`http://${ip}/`);
    await expect(assertSafeUrl(url)).resolves.toEqual(expect.objectContaining({ address: expect.any(String) }));
  });
});

// ---------------------------------------------------------------------------
// 9. Extended SSRF ranges (#82) — RFC 6598, 5737, 2544, 1112, 6890
// ---------------------------------------------------------------------------
describe("extended SSRF ranges (#82)", () => {
  const blockedRanges: [string, string][] = [
    // RFC 6598 — Shared Address Space (CGNAT) 100.64.0.0/10
    ["100.64.0.1", "RFC 6598 CGNAT low"],
    ["100.127.255.255", "RFC 6598 CGNAT high"],
    ["100.100.100.100", "RFC 6598 CGNAT mid"],
    // RFC 6890 — IETF Protocol Assignments 192.0.0.0/24
    ["192.0.0.1", "RFC 6890"],
    ["192.0.0.255", "RFC 6890 high"],
    // RFC 5737 — TEST-NET documentation ranges
    ["192.0.2.1", "RFC 5737 TEST-NET-1"],
    ["198.51.100.1", "RFC 5737 TEST-NET-2"],
    ["203.0.113.1", "RFC 5737 TEST-NET-3"],
    ["203.0.113.254", "RFC 5737 TEST-NET-3 high"],
    // RFC 2544 — Benchmarking 198.18.0.0/15
    ["198.18.0.1", "RFC 2544 benchmarking low"],
    ["198.19.255.255", "RFC 2544 benchmarking high"],
    // RFC 1112 — Class E / reserved 240.0.0.0/4 (includes 255.255.255.255)
    ["240.0.0.1", "RFC 1112 Class E low"],
    ["250.100.50.25", "RFC 1112 Class E mid"],
    ["255.255.255.255", "broadcast"],
  ];

  it.each(blockedRanges)("rejects direct literal %s (%s)", async (ip) => {
    const url = new URL(`http://${ip}/`);
    await expect(assertSafeUrl(url)).rejects.toThrow(
      `Blocked: private/reserved IP "${ip}"`,
    );
  });

  it.each(blockedRanges)("rejects hostname that resolves to %s (%s)", async (ip) => {
    mockLookup.mockResolvedValue([{ address: ip, family: 4 }]);
    const url = new URL("https://rebind.example.com/");
    await expect(assertSafeUrl(url)).rejects.toThrow(
      `resolves to private IP ${ip}`,
    );
  });

  it("rejects metadata.azure.com hostname (Azure IMDS public-facing)", async () => {
    const url = new URL("https://metadata.azure.com/metadata/instance");
    await expect(assertSafeUrl(url)).rejects.toThrow(
      'Blocked: hostname "metadata.azure.com" not allowed',
    );
  });
});

// ---------------------------------------------------------------------------
// 11. pinnedLookup callback signature (regression for undici v6+ "Invalid IP
//     address: undefined")
// ---------------------------------------------------------------------------
describe("pinnedLookup callback shapes", () => {
  const resolved = { address: "203.0.113.10", family: 4 as const };

  it("returns array form when options.all is true (undici v6+ default)", () => {
    const lookup = pinnedLookup(resolved);
    const cb = vi.fn();
    lookup("example.com", { all: true }, cb);
    expect(cb).toHaveBeenCalledTimes(1);
    expect(cb).toHaveBeenCalledWith(null, [{ address: "203.0.113.10", family: 4 }]);
  });

  it("returns single-arg form when options.all is false/undefined", () => {
    const lookup = pinnedLookup(resolved);
    const cb = vi.fn();
    lookup("example.com", {}, cb);
    expect(cb).toHaveBeenCalledTimes(1);
    expect(cb).toHaveBeenCalledWith(null, "203.0.113.10", 4);
  });

  it("preserves IPv6 family in array form", () => {
    const v6 = { address: "2606:4700:4700::1111", family: 6 as const };
    const lookup = pinnedLookup(v6);
    const cb = vi.fn();
    lookup("example.com", { all: true }, cb);
    expect(cb).toHaveBeenCalledWith(null, [{ address: "2606:4700:4700::1111", family: 6 }]);
  });
});
