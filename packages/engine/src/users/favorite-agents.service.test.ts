// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The favorite-agents methods of UsersService: the agent id from the URL is
 * checked before any query, and each store outcome becomes the HTTP answer the
 * panel reads (404 for an agent that does not exist, 400 past the limit).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { BadRequestException, NotFoundException } from "@nestjs/common";

const store = vi.hoisted(() => ({
  addFavoriteAgent: vi.fn(),
  listFavoriteAgentIds: vi.fn(),
  removeFavoriteAgent: vi.fn(),
}));
vi.mock("./favorite-agents.store.js", () => ({ ...store, FAVORITE_AGENTS_LIMIT: 100 }));

import { UsersService } from "./users.service.js";

const actor = { userId: "11111111-1111-4111-8111-111111111111" };
const AGENT = "22222222-2222-4222-8222-222222222222";

describe("UsersService favorite agents", () => {
  const service = new UsersService();

  beforeEach(() => {
    vi.clearAllMocks();
    store.listFavoriteAgentIds.mockResolvedValue([AGENT]);
  });

  it("refuses an agent id that is not a UUID before touching the store", async () => {
    await expect(service.addOwnFavoriteAgent(actor, "support-bot")).rejects.toBeInstanceOf(BadRequestException);
    await expect(service.removeOwnFavoriteAgent(actor, "1; DROP TABLE")).rejects.toBeInstanceOf(BadRequestException);
    expect(store.addFavoriteAgent).not.toHaveBeenCalled();
    expect(store.removeFavoriteAgent).not.toHaveBeenCalled();
  });

  it("writes the caller's own row and answers with the list after it", async () => {
    store.addFavoriteAgent.mockResolvedValue("added");
    await expect(service.addOwnFavoriteAgent(actor, AGENT.toUpperCase())).resolves.toEqual([AGENT]);
    expect(store.addFavoriteAgent).toHaveBeenCalledWith(actor.userId, AGENT);
  });

  it("treats a second star on the same agent as success", async () => {
    store.addFavoriteAgent.mockResolvedValue("already");
    await expect(service.addOwnFavoriteAgent(actor, AGENT)).resolves.toEqual([AGENT]);
  });

  it("answers not found for an agent that does not exist", async () => {
    store.addFavoriteAgent.mockResolvedValue("unknown-agent");
    await expect(service.addOwnFavoriteAgent(actor, AGENT)).rejects.toBeInstanceOf(NotFoundException);
  });

  it("answers a bad request naming the limit once it is reached", async () => {
    store.addFavoriteAgent.mockResolvedValue("limit");
    await expect(service.addOwnFavoriteAgent(actor, AGENT)).rejects.toThrow(/at most 100/);
  });

  it("removes and answers with the remaining list", async () => {
    store.listFavoriteAgentIds.mockResolvedValue([]);
    await expect(service.removeOwnFavoriteAgent(actor, AGENT)).resolves.toEqual([]);
    expect(store.removeFavoriteAgent).toHaveBeenCalledWith(actor.userId, AGENT);
  });
});
