// SPDX-License-Identifier: AGPL-3.0-or-later

import { beforeEach, expect, it, vi } from "vitest";
import { asInstanceUuid } from "../instances/identifiers.js";

const { mockReturning } = vi.hoisted(() => ({ mockReturning: vi.fn() }));

vi.mock("../database/client.js", () => ({
  db: {
    update: () => ({ set: () => ({ where: () => ({ returning: mockReturning }) }) }),
  },
}));
vi.mock("../crypto/index.js", () => ({ generateToken: () => "new-token" }));

import { rotateWebhookToken } from "./webhook-sources.store.js";

beforeEach(() => mockReturning.mockReset());

it("does not return a fresh token when no event source was updated", async () => {
  mockReturning.mockResolvedValue([]);

  const token = await rotateWebhookToken("missing", asInstanceUuid("11111111-1111-1111-1111-111111111111"));

  expect(token).toBeNull();
});

it("returns the token persisted by the update", async () => {
  mockReturning.mockResolvedValue([{ webhookToken: "new-token" }]);

  const token = await rotateWebhookToken("source-1", asInstanceUuid("11111111-1111-1111-1111-111111111111"));

  expect(token).toBe("new-token");
});
