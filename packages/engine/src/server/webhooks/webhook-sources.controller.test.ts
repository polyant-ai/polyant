// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The Room event-source webhook token is bearer-equivalent — its holder can
 * inject arbitrary events into the agent — so it must never appear in the
 * ROOM_READ list response, mirroring the WhatsApp channel's apiKey
 * `webhookSecret`, which v1.0.1 likewise withheld from CHANNEL_READ and
 * exposed only via a dedicated ROOM_WRITE reveal endpoint (see
 * `instance-channels.controller.ts` -> `whatsappWebhookUrl`).
 */

import "reflect-metadata";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NotFoundException } from "@nestjs/common";
import { REQUIRE_PERMISSION_KEY } from "../../authz/decorators/require-permission.decorator.js";
import { Permission } from "../../authz/index.js";

const {
  mockListEventSourcesWithDefinitions,
  mockGetEventSourceWebhookToken,
  mockResolveInstanceId,
} = vi.hoisted(() => ({
  mockListEventSourcesWithDefinitions: vi.fn(),
  mockGetEventSourceWebhookToken: vi.fn(),
  mockResolveInstanceId: vi.fn(),
}));

vi.mock("../../webhooks/webhook-sources.store.js", async () => {
  const actual = await vi.importActual<typeof import("../../webhooks/webhook-sources.store.js")>(
    "../../webhooks/webhook-sources.store.js",
  );
  return {
    ...actual,
    listEventSourcesWithDefinitions: mockListEventSourcesWithDefinitions,
    getEventSourceWebhookToken: mockGetEventSourceWebhookToken,
  };
});

vi.mock("../../instances/resolve-instance-id.js", () => ({
  resolveInstanceId: mockResolveInstanceId,
}));

import { EventSourcesController } from "./webhook-sources.controller.js";

function metadataOf(key: string, handler: keyof EventSourcesController): unknown {
  const proto = EventSourcesController.prototype as unknown as Record<string, unknown>;
  return Reflect.getMetadata(key, proto[handler] as object);
}

describe("EventSourcesController", () => {
  let controller: EventSourcesController;

  beforeEach(() => {
    vi.clearAllMocks();
    controller = new EventSourcesController();
    mockResolveInstanceId.mockResolvedValue("uuid-1");
  });

  describe("GET /event-sources — list under ROOM_READ", () => {
    it("does not carry a webhookUrl on any list item", async () => {
      mockListEventSourcesWithDefinitions.mockResolvedValue([
        {
          id: "src-1",
          instanceId: "uuid-1",
          name: "Source 1",
          sourceType: "webhook",
          config: {},
          enabled: true,
          webhookToken: "super-secret-token",
          createdAt: null,
          definitions: [],
        },
      ]);

      const result = await controller.list("acme");

      expect(result[0]).not.toHaveProperty("webhookUrl");
    });

    it("does not carry the raw webhookToken on any list item", async () => {
      mockListEventSourcesWithDefinitions.mockResolvedValue([
        {
          id: "src-1",
          instanceId: "uuid-1",
          name: "Source 1",
          sourceType: "webhook",
          config: {},
          enabled: true,
          webhookToken: "super-secret-token",
          createdAt: null,
          definitions: [],
        },
      ]);

      const result = await controller.list("acme");

      expect(result[0]).not.toHaveProperty("webhookToken");
      expect(JSON.stringify(result)).not.toContain("super-secret-token");
    });

    it("declares ROOM_READ on the list route", () => {
      expect(metadataOf(REQUIRE_PERMISSION_KEY, "list")).toBe(Permission.ROOM_READ);
    });
  });

  describe("GET /event-sources/:id/webhook-url — reveal under ROOM_WRITE", () => {
    it("declares ROOM_WRITE, not ROOM_READ, on the reveal route", () => {
      expect(metadataOf(REQUIRE_PERMISSION_KEY, "webhookUrl")).toBe(Permission.ROOM_WRITE);
      expect(metadataOf(REQUIRE_PERMISSION_KEY, "webhookUrl")).not.toBe(Permission.ROOM_READ);
    });

    it("returns the assembled webhook URL when the source is found", async () => {
      mockGetEventSourceWebhookToken.mockResolvedValue("super-secret-token");

      const result = await controller.webhookUrl("acme", "src-1");

      expect(result.webhookUrl).toContain("super-secret-token");
    });

    it("throws NotFoundException when the source does not belong to this instance", async () => {
      mockGetEventSourceWebhookToken.mockResolvedValue(null);

      await expect(controller.webhookUrl("acme", "src-1")).rejects.toBeInstanceOf(NotFoundException);
    });

    it("throws NotFoundException when the instance itself does not exist", async () => {
      mockResolveInstanceId.mockResolvedValue(undefined);

      await expect(controller.webhookUrl("unknown", "src-1")).rejects.toBeInstanceOf(NotFoundException);
    });
  });
});
