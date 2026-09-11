// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { MessageCoordinator } from "./message-coordinator.js";
import type { IncomingMessage, OutgoingMessage } from "./types.js";
import { asInstanceSlug } from "../instances/identifiers.js";

function makeMsg(overrides: Partial<IncomingMessage> = {}): IncomingMessage {
  return {
    channelType: "whatsapp",
    channelId: "+390000000001",
    instanceId: asInstanceSlug("my-instance"),
    userName: "Alice",
    text: "hello",
    metadata: {},
    ...overrides,
  };
}

describe("MessageCoordinator", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("flushes a single fragment after softDebounceMs", async () => {
    const handler = vi.fn().mockResolvedValue({ text: "hi" });
    const sendOutbound = vi.fn().mockResolvedValue(undefined);
    const sendTyping = vi.fn().mockResolvedValue(undefined);

    const c = new MessageCoordinator({
      resolveTimings: async () => ({ softDebounceMs: 2000, typingDelayMs: 1500, maxRestarts: 3 }),
      handler,
      sendOutbound,
      sendTyping,
    });

    const r = await c.onMessage(makeMsg({ text: "ciao" }));
    expect(r).toEqual({ text: "" });
    expect(handler).not.toHaveBeenCalled();

    // Typing fires at 1500
    await vi.advanceTimersByTimeAsync(1499);
    expect(sendTyping).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(sendTyping).toHaveBeenCalledTimes(1);
    expect(sendTyping).toHaveBeenCalledWith("my-instance", "whatsapp", "+390000000001", undefined);

    // Pipeline fires at 2000 total
    await vi.advanceTimersByTimeAsync(500);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler.mock.calls[0][0].text).toBe("ciao");
    // Pass a signal of type AbortSignal
    expect(handler.mock.calls[0][1]).toBeInstanceOf(AbortSignal);
    expect(handler.mock.calls[0][1].aborted).toBe(false);

    // sendOutbound fires after handler
    await vi.runAllTimersAsync();
    expect(sendOutbound).toHaveBeenCalledWith("my-instance", "whatsapp", "+390000000001", "hi");
  });

  it("concatenates fragments arriving within the soft-debounce window", async () => {
    const handler = vi.fn().mockResolvedValue({ text: "benvenuto!" });
    const sendOutbound = vi.fn().mockResolvedValue(undefined);

    const c = new MessageCoordinator({
      resolveTimings: async () => ({ softDebounceMs: 2000, typingDelayMs: 1500, maxRestarts: 3 }),
      handler,
      sendOutbound,
    });

    await c.onMessage(makeMsg({ text: "a1" }));
    await vi.advanceTimersByTimeAsync(500);
    await c.onMessage(makeMsg({ text: "a2" }));
    await vi.advanceTimersByTimeAsync(500);
    await c.onMessage(makeMsg({ text: "a3" }));

    // Still buffering — no flush yet
    expect(handler).not.toHaveBeenCalled();

    // After 2s of inactivity from the last fragment
    await vi.advanceTimersByTimeAsync(2000);
    await vi.runAllTimersAsync();

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler.mock.calls[0][0].text).toBe("a1\na2\na3");
    expect(sendOutbound).toHaveBeenCalledWith("my-instance", "whatsapp", "+390000000001", "benvenuto!");
  });

  it("does not fire typing if pipeline completes before typingDelayMs", async () => {
    // softDebounce < typingDelay: pipeline starts before typing fires
    const handler = vi.fn().mockResolvedValue({ text: "fast" });
    const sendOutbound = vi.fn().mockResolvedValue(undefined);
    const sendTyping = vi.fn().mockResolvedValue(undefined);

    const c = new MessageCoordinator({
      resolveTimings: async () => ({ softDebounceMs: 500, typingDelayMs: 1500, maxRestarts: 3 }),
      handler,
      sendOutbound,
      sendTyping,
    });

    await c.onMessage(makeMsg({ text: "x" }));
    await vi.advanceTimersByTimeAsync(500);
    await vi.runAllTimersAsync();

    expect(handler).toHaveBeenCalledTimes(1);
    expect(sendTyping).not.toHaveBeenCalled();
  });

  it("aborts the in-flight pipeline when a new fragment arrives, then restarts with concatenation", async () => {
    let abortedSignals = 0;
    const handler = vi.fn<(m: IncomingMessage, signal: AbortSignal) => Promise<OutgoingMessage>>(
      async (_msg, signal) => {
        // Simulate a slow pipeline that respects AbortSignal.
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => resolve(), 5000);
          signal.addEventListener("abort", () => {
            clearTimeout(timer);
            abortedSignals++;
            const err = new Error("aborted");
            err.name = "AbortError";
            reject(err);
          });
        });
        return { text: "late-response" };
      },
    );
    const sendOutbound = vi.fn().mockResolvedValue(undefined);

    const c = new MessageCoordinator({
      resolveTimings: async () => ({ softDebounceMs: 2000, typingDelayMs: 1500, maxRestarts: 3 }),
      handler,
      sendOutbound,
    });

    // t=0: first fragment
    await c.onMessage(makeMsg({ text: "first" }));
    // t=2000: pipeline starts (handler running, 5s to complete)
    await vi.advanceTimersByTimeAsync(2000);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler.mock.calls[0][0].text).toBe("first");

    // t=2500: new fragment arrives mid-pipeline → abort + restart
    await vi.advanceTimersByTimeAsync(500);
    await c.onMessage(makeMsg({ text: "second" }));
    // Settle the abort microtask chain
    await vi.advanceTimersByTimeAsync(0);
    expect(abortedSignals).toBe(1);

    // t=4500: pipeline timer re-armed from t=2500 → fires at t=2500+2000=4500
    await vi.advanceTimersByTimeAsync(2000);
    expect(handler).toHaveBeenCalledTimes(2);
    expect(handler.mock.calls[1][0].text).toBe("first\nsecond");

    // Let the 2nd run complete (5s simulated work)
    await vi.advanceTimersByTimeAsync(5000);
    await vi.runAllTimersAsync();
    expect(sendOutbound).toHaveBeenCalledTimes(1);
    expect(sendOutbound).toHaveBeenCalledWith("my-instance", "whatsapp", "+390000000001", "late-response");
  });

  it("stops cancelling after maxRestarts, accumulating fragments for a follow-up flush", async () => {
    let handlerCalls = 0;
    const handler = vi.fn<(m: IncomingMessage, signal: AbortSignal) => Promise<OutgoingMessage>>(
      async (_msg, signal) => {
        handlerCalls++;
        // Slow pipeline: 5s, respects abort
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => resolve(), 5000);
          signal.addEventListener("abort", () => {
            clearTimeout(timer);
            const err = new Error("aborted");
            err.name = "AbortError";
            reject(err);
          });
        });
        return { text: `run-${handlerCalls}` };
      },
    );
    const sendOutbound = vi.fn().mockResolvedValue(undefined);

    const c = new MessageCoordinator({
      resolveTimings: async () => ({ softDebounceMs: 1000, typingDelayMs: 500, maxRestarts: 2 }),
      handler,
      sendOutbound,
    });

    // First pipeline run starts at t=1000
    await c.onMessage(makeMsg({ text: "f1" }));
    await vi.advanceTimersByTimeAsync(1000);
    expect(handler).toHaveBeenCalledTimes(1);

    // Restart 1 — aborts 1st run
    await c.onMessage(makeMsg({ text: "f2" }));
    await vi.advanceTimersByTimeAsync(0); // settle abort
    await vi.advanceTimersByTimeAsync(1000);
    expect(handler).toHaveBeenCalledTimes(2);

    // Restart 2 — aborts 2nd run (restartCount reaches cap of 2)
    await c.onMessage(makeMsg({ text: "f3" }));
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(1000);
    expect(handler).toHaveBeenCalledTimes(3);

    // f4 arrives mid-3rd-run: should NOT abort (cap reached), just accumulate
    await c.onMessage(makeMsg({ text: "f4" }));
    await vi.advanceTimersByTimeAsync(100);
    // Still 3 — no 4th call yet
    expect(handler).toHaveBeenCalledTimes(3);

    // Let the 3rd run complete (it started at t=3000, takes 5s → t=8000)
    await vi.runAllTimersAsync();
    // Should have done 3rd run + a 4th run with just "f4"
    expect(handler).toHaveBeenCalledTimes(4);
    expect(handler.mock.calls[3][0].text).toBe("f4");
  });

  it("passes the latest inbound messageSid to sendTyping", async () => {
    const handler = vi.fn().mockResolvedValue({ text: "ok" });
    const sendOutbound = vi.fn().mockResolvedValue(undefined);
    const sendTyping = vi.fn().mockResolvedValue(undefined);

    const c = new MessageCoordinator({
      resolveTimings: async () => ({ softDebounceMs: 3000, typingDelayMs: 1500, maxRestarts: 3 }),
      handler,
      sendOutbound,
      sendTyping,
    });

    await c.onMessage(makeMsg({ text: "first", metadata: { messageSid: "SM1" } }));
    await vi.advanceTimersByTimeAsync(500);
    await c.onMessage(makeMsg({ text: "second", metadata: { messageSid: "SM2" } }));
    // Typing timer re-armed — now scheduled at t=500+1500=2000
    await vi.advanceTimersByTimeAsync(1500);
    expect(sendTyping).toHaveBeenCalledTimes(1);
    expect(sendTyping).toHaveBeenCalledWith("my-instance", "whatsapp", "+390000000001", "SM2");
  });

  it("does not send outbound when the pipeline is aborted mid-handler", async () => {
    const handler = vi.fn<(m: IncomingMessage, signal: AbortSignal) => Promise<OutgoingMessage>>(
      async (_msg, signal) => {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => resolve(), 5000);
          signal.addEventListener("abort", () => {
            clearTimeout(timer);
            const err = new Error("aborted");
            err.name = "AbortError";
            reject(err);
          });
        });
        return { text: "zombie" };
      },
    );
    const sendOutbound = vi.fn().mockResolvedValue(undefined);

    const c = new MessageCoordinator({
      resolveTimings: async () => ({ softDebounceMs: 1000, typingDelayMs: 1500, maxRestarts: 3 }),
      handler,
      sendOutbound,
    });

    await c.onMessage(makeMsg({ text: "a" }));
    await vi.advanceTimersByTimeAsync(1000);
    expect(handler).toHaveBeenCalledTimes(1);

    // New fragment triggers abort+restart; the 1st handler's final return must NOT be delivered
    await c.onMessage(makeMsg({ text: "b" }));
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(1000);
    // 2nd run starts; let it complete
    await vi.runAllTimersAsync();

    expect(sendOutbound).toHaveBeenCalledTimes(1);
    expect(sendOutbound.mock.calls[0][3]).toBe("zombie"); // only the 2nd run delivered
  });

  it("keeps per-conversation state independent", async () => {
    const handler = vi.fn().mockResolvedValue({ text: "ok" });
    const sendOutbound = vi.fn().mockResolvedValue(undefined);

    const c = new MessageCoordinator({
      resolveTimings: async () => ({ softDebounceMs: 2000, typingDelayMs: 1500, maxRestarts: 3 }),
      handler,
      sendOutbound,
    });

    const paolo = makeMsg({ channelId: "+393000000001" });
    const marco = makeMsg({ channelId: "+393000000002" });

    await c.onMessage({ ...paolo, text: "p1" });
    await c.onMessage({ ...marco, text: "m1" });
    await vi.advanceTimersByTimeAsync(500);
    await c.onMessage({ ...paolo, text: "p2" });

    await vi.advanceTimersByTimeAsync(2000);
    await vi.runAllTimersAsync();

    expect(handler).toHaveBeenCalledTimes(2);
    const texts = handler.mock.calls.map((c) => c[0].text);
    expect(texts).toContain("p1\np2");
    expect(texts).toContain("m1");
  });

  it("shutdown aborts in-flight pipelines and clears state", async () => {
    let aborted = false;
    const handler = vi.fn<(m: IncomingMessage, signal: AbortSignal) => Promise<OutgoingMessage>>(
      async (_msg, signal) => {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => resolve(), 10_000);
          signal.addEventListener("abort", () => {
            clearTimeout(timer);
            aborted = true;
            const err = new Error("aborted");
            err.name = "AbortError";
            reject(err);
          });
        });
        return { text: "never" };
      },
    );
    const sendOutbound = vi.fn().mockResolvedValue(undefined);

    const c = new MessageCoordinator({
      resolveTimings: async () => ({ softDebounceMs: 1000, typingDelayMs: 500, maxRestarts: 3 }),
      handler,
      sendOutbound,
    });

    await c.onMessage(makeMsg({ text: "x" }));
    await vi.advanceTimersByTimeAsync(1000);
    expect(handler).toHaveBeenCalledTimes(1);

    c.shutdown();
    await vi.advanceTimersByTimeAsync(0);
    expect(aborted).toBe(true);
    expect(sendOutbound).not.toHaveBeenCalled();
  });

  /**
   * The constructor no longer validates the timings, because they no longer
   * arrive as numbers: both sources that produce them are already constrained —
   * Zod refuses a negative env var at boot, and the migration's CHECK refuses a
   * negative column. What is worth pinning instead is that the resolution is per
   * BURST and per agent, which is the behaviour that replaced the three fixed
   * numbers.
   */
  it("resolves the timings once per burst, from the agent the message names", async () => {
    const handler = vi.fn().mockResolvedValue({ text: "ok" });
    const sendOutbound = vi.fn().mockResolvedValue(undefined);
    const resolveTimings = vi.fn(async (msg: { instanceId: string }) =>
      msg.instanceId === "fast-agent"
        ? { softDebounceMs: 100, typingDelayMs: 0, maxRestarts: 3 }
        : { softDebounceMs: 5000, typingDelayMs: 0, maxRestarts: 3 },
    );

    const c = new MessageCoordinator({ resolveTimings, handler, sendOutbound });

    await c.onMessage(makeMsg({ text: "a", instanceId: asInstanceSlug("fast-agent") }));
    await c.onMessage(
      makeMsg({ text: "b", instanceId: asInstanceSlug("slow-agent"), channelId: "+390000000002" }),
    );

    // The fast agent's window has passed; the slow one's has not.
    await vi.advanceTimersByTimeAsync(100);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler.mock.calls[0][0].instanceId).toBe("fast-agent");

    await vi.advanceTimersByTimeAsync(4900);
    expect(handler).toHaveBeenCalledTimes(2);
    expect(handler.mock.calls[1][0].instanceId).toBe("slow-agent");
  });

  it("asks the resolver once per burst, not once per fragment", async () => {
    const handler = vi.fn().mockResolvedValue({ text: "ok" });
    const sendOutbound = vi.fn().mockResolvedValue(undefined);
    const resolveTimings = vi.fn(async () => ({
      softDebounceMs: 1000,
      typingDelayMs: 0,
      maxRestarts: 3,
    }));

    const c = new MessageCoordinator({ resolveTimings, handler, sendOutbound });

    await c.onMessage(makeMsg({ text: "one" }));
    await c.onMessage(makeMsg({ text: "two" }));
    await c.onMessage(makeMsg({ text: "three" }));

    // A burst belongs to one conversation and therefore to one agent: asking
    // again per fragment would let the window change mid-burst.
    expect(resolveTimings).toHaveBeenCalledTimes(1);
  });

  /**
   * The window pinned here is the timings read. It is a DB round-trip in
   * production (`findInstanceBySlug`), and two fragments of one conversation
   * arrive as two concurrent webhook requests, so both used to see no state,
   * both installed one, and the second `states.set` discarded the first
   * fragment.
   *
   * Invoking the two calls WITHOUT an intervening `await` is the whole test:
   * every other case in this file awaits each fragment in turn, which is
   * exactly why the overwrite went unseen.
   */
  it("keeps both fragments when the second arrives while the burst state is being installed", async () => {
    const handler = vi.fn().mockResolvedValue({ text: "ok" });
    const sendOutbound = vi.fn().mockResolvedValue(undefined);
    let releaseTimings: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      releaseTimings = resolve;
    });
    const resolveTimings = vi.fn(async () => {
      await gate;
      return { softDebounceMs: 1000, typingDelayMs: 0, maxRestarts: 3 };
    });

    const c = new MessageCoordinator({ resolveTimings, handler, sendOutbound });

    const first = c.onMessage(makeMsg({ text: "first" }));
    const second = c.onMessage(makeMsg({ text: "second" }));
    releaseTimings();
    await Promise.all([first, second]);

    // One burst, not two: the second fragment waited for the state to be
    // installed and then appended to it.
    expect(resolveTimings).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1000);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler.mock.calls[0][0].text).toBe("first\nsecond");
  });

  /**
   * A failed timings read belongs to the fragment that owns it. The one that was
   * merely waiting behind it must not inherit the error — it starts the burst
   * itself instead.
   */
  it("does not fail a waiting fragment when the first fragment's timings read rejects", async () => {
    const handler = vi.fn().mockResolvedValue({ text: "ok" });
    const sendOutbound = vi.fn().mockResolvedValue(undefined);
    let releaseTimings: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      releaseTimings = resolve;
    });
    const resolveTimings = vi.fn(async () => {
      if (resolveTimings.mock.calls.length === 1) {
        await gate;
        throw new Error("agent lookup failed");
      }
      return { softDebounceMs: 1000, typingDelayMs: 0, maxRestarts: 3 };
    });

    const c = new MessageCoordinator({ resolveTimings, handler, sendOutbound });

    const first = c.onMessage(makeMsg({ text: "first" }));
    const second = c.onMessage(makeMsg({ text: "second" }));
    releaseTimings();

    await expect(first).rejects.toThrow("agent lookup failed");
    await expect(second).resolves.toEqual({ text: "" });

    await vi.advanceTimersByTimeAsync(1000);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler.mock.calls[0][0].text).toBe("second");
  });
});
