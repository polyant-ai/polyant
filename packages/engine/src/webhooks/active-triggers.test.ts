// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { registerTrigger, getActiveTrigger, clearExpiredTriggers, activeTriggerCount } from './active-triggers.js';

describe('active-triggers', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    // Clear all triggers by advancing time far beyond any TTL and cleaning up
    vi.setSystemTime(new Date('2099-01-01T00:00:00Z'));
    clearExpiredTriggers();
    vi.setSystemTime(new Date('2026-04-15T12:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('should return conversationId after registering a trigger', () => {
    registerTrigger('inst-1', 'telegram', 'chat-42', 'conv-abc');

    const result = getActiveTrigger('inst-1', 'telegram', 'chat-42');
    expect(result).toBe('conv-abc');
  });

  it('should return null for an unknown key', () => {
    const result = getActiveTrigger('inst-unknown', 'slack', 'chan-99');
    expect(result).toBeNull();
  });

  it('should return null when trigger has expired', () => {
    const ttlMs = 5000;
    registerTrigger('inst-1', 'telegram', 'chat-42', 'conv-abc', ttlMs);

    // Still valid just before expiry
    vi.advanceTimersByTime(4999);
    expect(getActiveTrigger('inst-1', 'telegram', 'chat-42')).toBe('conv-abc');

    // Expired at exactly ttlMs
    vi.advanceTimersByTime(1);
    expect(getActiveTrigger('inst-1', 'telegram', 'chat-42')).toBeNull();
  });

  it('should overwrite an existing trigger for the same key', () => {
    registerTrigger('inst-1', 'telegram', 'chat-42', 'conv-first');
    registerTrigger('inst-1', 'telegram', 'chat-42', 'conv-second');

    const result = getActiveTrigger('inst-1', 'telegram', 'chat-42');
    expect(result).toBe('conv-second');
  });

  it('should store multiple independent triggers', () => {
    registerTrigger('inst-1', 'telegram', 'chat-1', 'conv-a');
    registerTrigger('inst-1', 'slack', 'chan-2', 'conv-b');
    registerTrigger('inst-2', 'telegram', 'chat-1', 'conv-c');

    expect(getActiveTrigger('inst-1', 'telegram', 'chat-1')).toBe('conv-a');
    expect(getActiveTrigger('inst-1', 'slack', 'chan-2')).toBe('conv-b');
    expect(getActiveTrigger('inst-2', 'telegram', 'chat-1')).toBe('conv-c');
  });

  it('should sweep expired entries on its own when a new trigger is registered', () => {
    registerTrigger('inst-1', 'telegram', 'never-replies', 'conv-a', 1000);
    vi.advanceTimersByTime(2000);

    registerTrigger('inst-1', 'telegram', 'chat-2', 'conv-b');

    expect(activeTriggerCount()).toBe(1);
  });

  it('should remove only expired entries when clearExpiredTriggers is called', () => {
    registerTrigger('inst-1', 'telegram', 'chat-1', 'conv-short', 1000);
    registerTrigger('inst-1', 'slack', 'chan-2', 'conv-long', 10_000);

    vi.advanceTimersByTime(2000);
    clearExpiredTriggers();

    // Short-lived trigger was cleaned up
    expect(getActiveTrigger('inst-1', 'telegram', 'chat-1')).toBeNull();
    // Long-lived trigger is still active
    expect(getActiveTrigger('inst-1', 'slack', 'chan-2')).toBe('conv-long');
  });
});
