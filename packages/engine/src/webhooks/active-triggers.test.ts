// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { registerTrigger, getActiveTrigger } from './active-triggers.js';

const DAY_MS = 24 * 60 * 60 * 1000;

describe('active-triggers', () => {
  beforeEach(() => {
    vi.useFakeTimers();
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
    registerTrigger('inst-1', 'telegram', 'chat-expiring', 'conv-abc');

    // Still valid just before expiry
    vi.advanceTimersByTime(DAY_MS - 1);
    expect(getActiveTrigger('inst-1', 'telegram', 'chat-expiring')).toBe('conv-abc');

    // Expired at exactly the TTL
    vi.advanceTimersByTime(1);
    expect(getActiveTrigger('inst-1', 'telegram', 'chat-expiring')).toBeNull();
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
});
