// SPDX-License-Identifier: AGPL-3.0-or-later

import { isIP } from "node:net";
import fc from "fast-check";

/*
  SSRF guard properties. The verdict each test expects comes from the range
  table below, written from the IANA special-purpose registries, never from
  the module under test. The only stub is the DNS boundary: an IP literal
  "resolves" to itself (what getaddrinfo does), a name resolves to whatever
  the property generated.
*/

const { mockLookup } = vi.hoisted(() => ({ mockLookup: vi.fn() }));
vi.mock("dns/promises", () => ({ lookup: mockLookup }));

import { assertSafeUrl, isBlockedHost } from "./url-safety.js";

// ---------------------------------------------------------------------------
// The independent oracle
// ---------------------------------------------------------------------------

/** IPv4 ranges that must never be reached: [first octets as a number, prefix length]. */
const BLOCKED_V4: ReadonlyArray<readonly [string, number]> = [
  ["127.0.0.0", 8], // loopback
  ["10.0.0.0", 8], // RFC 1918
  ["172.16.0.0", 12], // RFC 1918
  ["192.168.0.0", 16], // RFC 1918
  ["169.254.0.0", 16], // link-local, cloud metadata (169.254.169.254)
  ["100.64.0.0", 10], // RFC 6598 shared address space
  ["192.0.0.0", 24], // IETF protocol assignments
  ["192.0.2.0", 24], // TEST-NET-1
  ["198.51.100.0", 24], // TEST-NET-2
  ["203.0.113.0", 24], // TEST-NET-3
  ["198.18.0.0", 15], // benchmarking
  ["240.0.0.0", 4], // reserved, broadcast
  ["0.0.0.0", 32], // unspecified (reaches the local host)
];

/**
 * Left out of both the blocked and the public generators, because the guard
 * takes no position on them and neither answer is a security property:
 * 0.0.0.0/8 other than 0.0.0.0 ("this network", not routable) and
 * 224.0.0.0/4 (multicast, which TCP cannot connect to).
 */
const UNCLASSIFIED_V4: ReadonlyArray<readonly [string, number]> = [
  ["0.0.0.0", 8],
  ["224.0.0.0", 4],
];

function v4ToInt(dotted: string): number {
  return dotted.split(".").reduce((n, octet) => n * 256 + Number(octet), 0);
}

function inRange(n: number, [base, prefix]: readonly [string, number]): boolean {
  const size = 2 ** (32 - prefix);
  const start = v4ToInt(base);
  return n >= start && n < start + size;
}

const octets = (n: number) => [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
const dotted = (n: number) => octets(n).join(".");
const hex16 = (n: number) => n.toString(16);

/** A blocked IPv4 address, drawn uniformly from inside one table range. */
const BLOCKED_V4_ADDRESS = fc
  .constantFrom(...BLOCKED_V4)
  .chain(([base, prefix]) => fc.nat(2 ** (32 - prefix) - 1).map((offset) => v4ToInt(base) + offset));

const PUBLIC_V4_ADDRESS = fc
  .nat(0xffffffff)
  .filter((n) => ![...BLOCKED_V4, ...UNCLASSIFIED_V4].some((range) => inRange(n, range)));

/** Ways one IPv4 address can be written in a URL host. Each must name the same address. */
const V4_SPELLINGS: ReadonlyArray<(n: number) => string> = [
  (n) => dotted(n),
  (n) => String(n), // single decimal integer
  (n) => `0x${n.toString(16)}`, // single hex integer
  (n) => `0X${n.toString(16).toUpperCase()}`,
  (n) => octets(n).map((o) => `0${o.toString(8)}`).join("."), // dotted octal
  (n) => octets(n).map((o) => `0x${o.toString(16)}`).join("."), // dotted hex
  (n) => `${n >>> 24}.${n & 0xffffff}`, // a.b-c-d
  (n) => `${n >>> 24}.${(n >>> 16) & 255}.${n & 0xffff}`, // a.b.c-d
  (n) => `${dotted(n)}.`, // trailing dot
  (n) => [...dotted(n)].map((ch) => (ch === "." ? "." : `%3${ch}`)).join(""), // percent-encoded digits
  (n) => [...dotted(n)].map((ch) => (ch === "." ? "。" : String.fromCharCode(0xff10 + Number(ch)))).join(""), // full-width
];

/** IPv4-mapped IPv6 spellings of the same IPv4 address, bracketed for a URL. */
const MAPPED_SPELLINGS: ReadonlyArray<(n: number) => string> = [
  (n) => `[::ffff:${dotted(n)}]`,
  (n) => `[::FFFF:${hex16(n >>> 16).toUpperCase()}:${hex16(n & 0xffff).toUpperCase()}]`,
  (n) => `[0:0:0:0:0:ffff:${dotted(n)}]`,
  (n) => `[0000:0000:0000:0000:0000:ffff:${hex16(n >>> 16)}:${hex16(n & 0xffff)}]`,
];

/** Ways to dress a host in a URL without changing which host is contacted. */
const URL_WRAPPERS: ReadonlyArray<(host: string) => string> = [
  (h) => `http://${h}/`,
  (h) => `https://${h}:8443/path?q=1`,
  (h) => `http://good.example.com@${h}/`, // userinfo that looks like the host
  (h) => `HTTP://user:pass@${h}:80/#frag`,
];

/** A random IPv6 address inside a prefix, written out as eight full hextets. */
function v6InPrefix(prefixHextets: readonly number[], prefixMask: number) {
  // Never mutate the generated array: fast-check shrinks from it.
  return fc.array(fc.integer({ min: 0, max: 0xffff }), { minLength: 8, maxLength: 8 }).map(([first, ...rest]) => {
    const head = (prefixHextets[0]! & prefixMask) | (first! & ~prefixMask & 0xffff);
    return [head, ...rest].map((g) => g.toString(16)).join(":");
  });
}

const BLOCKED_V6_ADDRESS = fc.oneof(
  fc.constantFrom("::1", "0:0:0:0:0:0:0:1", "::", "0:0:0:0:0:0:0:0"),
  v6InPrefix([0xfc00], 0xfe00), // unique local fc00::/7 (includes fd00:ec2::254, the AWS IPv6 IMDS)
);
const LINK_LOCAL_V6_ADDRESS = v6InPrefix([0xfe80], 0xffc0); // fe80::/10
const PUBLIC_V6_ADDRESS = v6InPrefix([0x2000], 0xe000); // global unicast 2000::/3

/** The compressed form a resolver answers with (RFC 5952), via the WHATWG URL parser. */
const canonicalV6 = (address: string) => new URL(`http://[${address}]/`).hostname.slice(1, -1);

function stubDnsLikeTheResolver(namesResolveTo: string[] = ["93.184.216.34"]) {
  mockLookup.mockReset();
  mockLookup.mockImplementation(async (host: string) => {
    const literal = host.replace(/^\[|\]$/g, "");
    const family = isIP(literal);
    if (family) return [{ address: literal, family }];
    return namesResolveTo.map((address) => ({ address, family: isIP(address) }));
  });
}

async function verdict(url: string): Promise<"refused" | "allowed"> {
  try {
    await assertSafeUrl(new URL(url));
    return "allowed";
  } catch (error) {
    expect((error as Error).message).toMatch(/^Blocked:/);
    return "refused";
  }
}

beforeEach(() => stubDnsLikeTheResolver());

// ---------------------------------------------------------------------------
// Properties
// ---------------------------------------------------------------------------

describe("url-safety (property)", () => {
  it("spells each address the way the test intends (guards the generators themselves)", () => {
    fc.assert(
      fc.property(fc.nat(0xffffffff), fc.constantFrom(...V4_SPELLINGS), (n, spell) => {
        expect(new URL(`http://${spell(n)}/`).hostname).toBe(dotted(n));
      }),
      { numRuns: 300 },
    );
  });

  it("refuses every private, loopback, link-local and metadata IPv4 address however the URL writes it", async () => {
    // Catches: a range dropped from the denylist, an off-by-one in a range
    // regex, a check that runs on the raw string instead of the parsed host.
    await fc.assert(
      fc.asyncProperty(
        BLOCKED_V4_ADDRESS,
        fc.constantFrom(...V4_SPELLINGS, ...MAPPED_SPELLINGS),
        fc.constantFrom(...URL_WRAPPERS),
        async (n, spell, wrap) => {
          expect(await verdict(wrap(spell(n)))).toBe("refused");
        },
      ),
      { numRuns: 600 },
    );
  });

  it("refuses IPv6 loopback, unspecified and unique-local addresses, in URLs and in DNS answers", async () => {
    await fc.assert(
      fc.asyncProperty(BLOCKED_V6_ADDRESS, fc.constantFrom(...URL_WRAPPERS), async (address, wrap) => {
        expect(await verdict(wrap(`[${address}]`))).toBe("refused");
        expect(isBlockedHost(address)).toBe(true);
        expect(isBlockedHost(address.toUpperCase())).toBe(true);
      }),
      { numRuns: 300 },
    );
  });

  // fe80::/10 spans fe80–febf; the guard once matched only the literal prefix
  // "fe80:", so http://[fe81::]/ was allowed.
  it("refuses every IPv6 link-local address (fe80::/10), not only those starting fe80:", async () => {
    await fc.assert(
      fc.asyncProperty(LINK_LOCAL_V6_ADDRESS, async (address) => {
        expect(await verdict(`http://[${address}]/`)).toBe("refused");
      }),
      { numRuns: 200 },
    );
  });

  it("accepts public IPv4 addresses in every spelling, and pins the address it validated", async () => {
    // Catches an over-broad range (a /8 typed for a /12) that would break
    // every legitimate fetch to that space.
    await fc.assert(
      fc.asyncProperty(PUBLIC_V4_ADDRESS, fc.constantFrom(...V4_SPELLINGS), fc.constantFrom(...URL_WRAPPERS), async (n, spell, wrap) => {
        const resolved = await assertSafeUrl(new URL(wrap(spell(n))));
        expect(resolved).toEqual({ address: dotted(n), family: 4 });
      }),
      { numRuns: 400 },
    );
  });

  it("does not treat public IPv6 or IPv4-mapped public addresses as blocked", () => {
    fc.assert(
      fc.property(PUBLIC_V6_ADDRESS, PUBLIC_V4_ADDRESS, (v6, v4) => {
        expect(isBlockedHost(v6)).toBe(false);
        expect(isBlockedHost(`[${v6}]`)).toBe(false);
        expect(isBlockedHost(`::ffff:${dotted(v4)}`)).toBe(false);
        expect(isBlockedHost(`::ffff:${hex16(v4 >>> 16)}:${hex16(v4 & 0xffff)}`)).toBe(false);
      }),
      { numRuns: 400 },
    );
  });

  it("refuses a name when ANY address it resolves to is blocked, and allows it when all are public", async () => {
    // Catches: checking only the first DNS answer (a rebinding attacker puts
    // the public one first), or only the IPv4 answers.
    const answer = fc.oneof(
      BLOCKED_V4_ADDRESS.map((n) => ({ address: dotted(n), blocked: true })),
      BLOCKED_V4_ADDRESS.map((n) => ({ address: `::ffff:${dotted(n)}`, blocked: true })),
      BLOCKED_V6_ADDRESS.map((a) => ({ address: canonicalV6(a), blocked: true })),
      PUBLIC_V4_ADDRESS.map((n) => ({ address: dotted(n), blocked: false })),
      PUBLIC_V6_ADDRESS.map((a) => ({ address: canonicalV6(a), blocked: false })),
    );
    const name = fc.stringMatching(/^[a-z][a-z0-9-]{0,20}\.(com|net|example)$/);
    await fc.assert(
      fc.asyncProperty(name, fc.array(answer, { minLength: 1, maxLength: 5 }), async (host, answers) => {
        stubDnsLikeTheResolver(answers.map((a) => a.address));
        const expected = answers.some((a) => a.blocked) ? "refused" : "allowed";
        expect(await verdict(`https://${host}/`)).toBe(expected);
      }),
      { numRuns: 400 },
    );
  });
});
