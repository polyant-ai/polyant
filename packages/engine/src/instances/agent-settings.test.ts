// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The fallback, in both directions. What can go wrong here is not arithmetic:
 * it is a null read as a zero, which would mean "no debounce" where the agent
 * meant "I have no opinion".
 */

import { describe, it, expect } from "vitest";
import { config } from "../config.js";
import {
  resolveDatetimeSettings,
  resolveDedupSimilarityThreshold,
  resolveMessageTimings,
  UNSET_AGENT_SETTINGS,
} from "./agent-settings.js";

describe("agent settings resolution", () => {
  it("should_use_the_deployment_default_for_an_agent_that_declares_nothing", () => {
    expect(resolveDatetimeSettings(UNSET_AGENT_SETTINGS)).toEqual({
      timezone: config.datetime.timezone,
      locale: config.datetime.locale,
    });
    expect(resolveDedupSimilarityThreshold(UNSET_AGENT_SETTINGS)).toBe(
      config.memory.dedupSimilarityThreshold,
    );
    expect(resolveMessageTimings(UNSET_AGENT_SETTINGS)).toEqual({
      softDebounceMs: config.coordinator.softDebounceMs,
      typingDelayMs: config.coordinator.typingDelayMs,
      maxRestarts: config.coordinator.maxRestarts,
    });
  });

  it("should_use_the_agents_own_value_where_it_declares_one", () => {
    const row = {
      ...UNSET_AGENT_SETTINGS,
      datetimeTimezone: "Asia/Tokyo",
      datetimeLocale: "ja-JP",
      dedupSimilarityThreshold: 0.75,
      messageSoftDebounceMs: 500,
      messageTypingDelayMs: 250,
      messageMaxRestarts: 1,
    };

    expect(resolveDatetimeSettings(row)).toEqual({ timezone: "Asia/Tokyo", locale: "ja-JP" });
    expect(resolveDedupSimilarityThreshold(row)).toBe(0.75);
    expect(resolveMessageTimings(row)).toEqual({
      softDebounceMs: 500,
      typingDelayMs: 250,
      maxRestarts: 1,
    });
  });

  it("should_keep_a_declared_zero_rather_than_reading_it_as_unset", () => {
    // The trap: `??` is what makes this correct and `||` is what would break it.
    // Zero is a legitimate answer for all three timings — no debounce, no typing
    // delay, no restart — and for the threshold it means "every memory is a
    // duplicate", which is a choice someone can make.
    const row = {
      ...UNSET_AGENT_SETTINGS,
      dedupSimilarityThreshold: 0,
      messageSoftDebounceMs: 0,
      messageTypingDelayMs: 0,
      messageMaxRestarts: 0,
    };

    expect(resolveDedupSimilarityThreshold(row)).toBe(0);
    expect(resolveMessageTimings(row)).toEqual({
      softDebounceMs: 0,
      typingDelayMs: 0,
      maxRestarts: 0,
    });
  });

  it("should_resolve_each_of_the_six_independently", () => {
    // A half-declared row is the ordinary case: an operator sets a time zone and
    // leaves the rest alone.
    const row = { ...UNSET_AGENT_SETTINGS, datetimeTimezone: "Asia/Tokyo", messageMaxRestarts: 7 };

    expect(resolveDatetimeSettings(row).timezone).toBe("Asia/Tokyo");
    expect(resolveDatetimeSettings(row).locale).toBe(config.datetime.locale);
    expect(resolveMessageTimings(row).maxRestarts).toBe(7);
    expect(resolveMessageTimings(row).softDebounceMs).toBe(config.coordinator.softDebounceMs);
  });
});
