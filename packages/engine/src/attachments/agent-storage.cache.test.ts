// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { asInstanceSlug } from "../instances/identifiers.js";

const secrets = vi.hoisted(() => ({ current: {} as Record<string, string>, reads: vi.fn() }));
vi.mock("../instances/secrets.store.js", () => ({
  getAllSecrets: async (slug: string) => {
    secrets.reads(slug);
    return secrets.current;
  },
}));
const log = vi.hoisted(() => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }));
vi.mock("../utils/create-logger.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../utils/create-logger.js")>()),
  createLogger: () => log,
}));

const { isAgentStorageConfigured, invalidateAgentS3 } = await import("./agent-storage.js");

const configured = {
  s3_bucket_name: "bucket",
  aws_region: "eu-west-1",
  aws_access_key_id: "AKIA-old",
  aws_secret_access_key: "secret-old",
};

describe("agent storage resolution cache", () => {
  let agent = 0;
  let slug = asInstanceSlug("agent-0");

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    secrets.reads.mockClear();
    log.warn.mockClear();
    // Each test its own agent: the cache is module state.
    slug = asInstanceSlug(`agent-${++agent}`);
  });

  afterEach(() => {
    invalidateAgentS3(slug);
    vi.useRealTimers();
  });

  it("reads the secrets again once the cached client is old, so keys rotated elsewhere take effect", async () => {
    secrets.current = configured;
    expect(await isAgentStorageConfigured(slug)).toBe(true);
    expect(await isAgentStorageConfigured(slug)).toBe(true);
    expect(secrets.reads).toHaveBeenCalledOnce();

    // Another replica removed the storage keys; this one only learns by reading again.
    secrets.current = {};
    vi.setSystemTime(Date.now() + 10 * 60_000);

    expect(await isAgentStorageConfigured(slug)).toBe(false);
    expect(secrets.reads).toHaveBeenCalledTimes(2);
  });

  it("remembers an agent without storage instead of reading its secrets and warning per attachment", async () => {
    secrets.current = {};
    for (let i = 0; i < 5; i++) expect(await isAgentStorageConfigured(slug)).toBe(false);

    expect(secrets.reads).toHaveBeenCalledOnce();
    expect(log.warn).toHaveBeenCalledOnce();
  });

  it("forgets the cached answer as soon as the agent's secrets change here", async () => {
    secrets.current = {};
    expect(await isAgentStorageConfigured(slug)).toBe(false);

    secrets.current = configured;
    invalidateAgentS3(slug);

    expect(await isAgentStorageConfigured(slug)).toBe(true);
  });
});
