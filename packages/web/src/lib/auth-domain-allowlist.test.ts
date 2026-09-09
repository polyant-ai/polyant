// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from "vitest";
import { isEmailDomainAllowed } from "./auth-domain-allowlist";

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
