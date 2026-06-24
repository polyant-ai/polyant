// SPDX-License-Identifier: AGPL-3.0-or-later

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isEmailDomainAllowed, parseAllowedDomains } from "./auth-domain-allowlist";

const ENV_KEYS = ["AUTH_ALLOWED_DOMAIN", "AUTH_ALLOWED_DOMAINS"] as const;

describe("parseAllowedDomains", () => {
  let saved: Record<string, string | undefined>;

  beforeEach(() => {
    saved = {};
    for (const key of ENV_KEYS) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });

  it("should_return_empty_list_when_no_env_set", () => {
    expect(parseAllowedDomains()).toEqual([]);
  });

  it("should_parse_singular_AUTH_ALLOWED_DOMAIN", () => {
    process.env.AUTH_ALLOWED_DOMAIN = "acme.com";
    expect(parseAllowedDomains()).toEqual(["acme.com"]);
  });

  it("should_parse_plural_comma_separated_AUTH_ALLOWED_DOMAINS", () => {
    process.env.AUTH_ALLOWED_DOMAINS = "acme.com, partner.io";
    expect(parseAllowedDomains()).toEqual(["acme.com", "partner.io"]);
  });

  it("should_merge_and_dedupe_both_env_vars_lowercased", () => {
    process.env.AUTH_ALLOWED_DOMAIN = "Acme.com";
    process.env.AUTH_ALLOWED_DOMAINS = "acme.com,Partner.io";
    expect(parseAllowedDomains()).toEqual(["acme.com", "partner.io"]);
  });

  it("should_ignore_blank_entries", () => {
    process.env.AUTH_ALLOWED_DOMAINS = " , ,acme.com, ";
    expect(parseAllowedDomains()).toEqual(["acme.com"]);
  });
});

describe("isEmailDomainAllowed", () => {
  it("should_allow_any_email_when_allowlist_empty", () => {
    expect(isEmailDomainAllowed("anyone@anywhere.com", [])).toBe(true);
  });

  it("should_allow_email_matching_configured_domain", () => {
    expect(isEmailDomainAllowed("jane@acme.com", ["acme.com"])).toBe(true);
  });

  it("should_reject_email_not_matching_configured_domain", () => {
    expect(isEmailDomainAllowed("jane@other.com", ["acme.com"])).toBe(false);
  });

  it("should_be_case_insensitive_on_email", () => {
    expect(isEmailDomainAllowed("Jane@ACME.com", ["acme.com"])).toBe(true);
  });

  it("should_match_against_any_domain_in_a_multi_domain_list", () => {
    expect(isEmailDomainAllowed("jane@partner.io", ["acme.com", "partner.io"])).toBe(true);
  });

  it("should_reject_when_email_missing_and_allowlist_present", () => {
    expect(isEmailDomainAllowed(undefined, ["acme.com"])).toBe(false);
    expect(isEmailDomainAllowed("", ["acme.com"])).toBe(false);
  });

  it("should_not_be_fooled_by_domain_as_substring_suffix", () => {
    // "evilacme.com" ends with "acme.com" textually but is a different domain.
    expect(isEmailDomainAllowed("jane@evilacme.com", ["acme.com"])).toBe(false);
  });

  it("should_not_match_when_domain_is_a_prefix", () => {
    expect(isEmailDomainAllowed("jane@acme.com.evil.io", ["acme.com"])).toBe(false);
  });
});
