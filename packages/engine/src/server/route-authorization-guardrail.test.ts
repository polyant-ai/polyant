// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from "vitest";
import { PATH_METADATA, METHOD_METADATA } from "@nestjs/common/constants";
import { IS_PUBLIC_KEY } from "../auth/decorators/public.decorator.js";
import { REQUIRE_PERMISSION_KEY } from "../authz/decorators/require-permission.decorator.js";

import { HealthController } from "./health/health.controller.js";
import { MemoriesController } from "./memories/memories.controller.js";
import { InstancesController } from "./instances/instances.controller.js";
import { InstancePromptsController } from "./instances/instance-prompts.controller.js";
import { InstanceToolsController } from "./instances/instance-tools.controller.js";
import { InstanceSkillsController } from "./instances/instance-skills.controller.js";
import { InstanceSecretsController } from "./instances/instance-secrets.controller.js";
import { InstanceChannelsController } from "./instances/instance-channels.controller.js";
import { ConversationsController } from "./conversations/conversations.controller.js";
import { AnalyticsController } from "./analytics/analytics.controller.js";
import { ToolsController } from "./tools/tools.controller.js";
import { InstanceKnowledgeController } from "./instances/instance-knowledge.controller.js";
import { InstanceScheduledTasksController } from "./instances/instance-scheduled-tasks.controller.js";
import { WebhookController } from "./webhooks/webhook.controller.js";
import { TwilioWebhookController } from "./channels/twilio-webhook.controller.js";
import { RoomController } from "./room/room.controller.js";
import { InstanceHooksController } from "./hooks/instance-hooks.controller.js";
import { EventSourcesController } from "./webhooks/webhook-sources.controller.js";
import { WebhookBacklogController } from "./webhooks/webhook-backlog.controller.js";
import { AuditController } from "./audit/audit.controller.js";
import { InstanceExportController } from "./instances/instance-export.controller.js";
import { AttachmentsController } from "./attachments/attachments.controller.js";
import { OptoutsController } from "./optouts/optouts.controller.js";
import { OpenAIController } from "./openai/openai.controller.js";
import { InstanceChatStreamController } from "./openai/instance-chat-stream.controller.js";
import { MembersController } from "./members/members.controller.js";

/**
 * The authoritative list of every controller registered in the NestJS server.
 * Kept in sync with `ServerModule`, `OptoutsModule`, and `OpenAIModule`; a
 * missing entry would let an undeclared handler slip past the guardrail.
 */
const ALL_CONTROLLERS = [
  HealthController,
  MemoriesController,
  InstancesController,
  InstancePromptsController,
  InstanceToolsController,
  InstanceSkillsController,
  InstanceSecretsController,
  InstanceChannelsController,
  ConversationsController,
  AnalyticsController,
  ToolsController,
  InstanceKnowledgeController,
  InstanceScheduledTasksController,
  WebhookController,
  TwilioWebhookController,
  RoomController,
  InstanceHooksController,
  EventSourcesController,
  WebhookBacklogController,
  AuditController,
  InstanceExportController,
  AttachmentsController,
  OptoutsController,
  OpenAIController,
  InstanceChatStreamController,
  MembersController,
] as const;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ControllerClass = new (...args: any[]) => object;

interface RouteHandler {
  readonly controller: ControllerClass;
  readonly handler: string;
}

function describeHandler({ controller, handler }: RouteHandler): string {
  return `${controller.name}.${handler}`;
}

/**
 * A method is an HTTP route handler when the routing decorators (`@Get`,
 * `@Post`, ...) have stamped both the path and the HTTP method metadata onto
 * it — that is the same signal NestJS uses to bind a route.
 */
function isRouteHandler(target: object): boolean {
  return (
    Reflect.hasMetadata(PATH_METADATA, target) &&
    Reflect.hasMetadata(METHOD_METADATA, target)
  );
}

function collectRouteHandlers(controller: ControllerClass): RouteHandler[] {
  const prototype = controller.prototype as Record<string, unknown>;
  return Object.getOwnPropertyNames(prototype)
    .filter((name) => name !== "constructor")
    .filter((name) => typeof prototype[name] === "function")
    .filter((name) => isRouteHandler(prototype[name] as object))
    .map((name) => ({ controller, handler: name }));
}

/** Reads metadata from the handler first, then the controller class. */
function readMetadata(
  controller: ControllerClass,
  handler: string,
  key: string,
): unknown {
  const prototype = controller.prototype as Record<string, unknown>;
  const handlerValue = Reflect.getMetadata(key, prototype[handler] as object);
  if (handlerValue !== undefined) return handlerValue;
  return Reflect.getMetadata(key, controller);
}

function isPublic(controller: ControllerClass, handler: string): boolean {
  return readMetadata(controller, handler, IS_PUBLIC_KEY) === true;
}

function hasRequiredPermission(
  controller: ControllerClass,
  handler: string,
): boolean {
  return readMetadata(controller, handler, REQUIRE_PERMISSION_KEY) !== undefined;
}

describe("route authorization guardrail", () => {
  const handlers = ALL_CONTROLLERS.flatMap((controller) =>
    collectRouteHandlers(controller),
  );

  it("should_discover_route_handlers_across_all_controllers", () => {
    // Sanity check: the introspection must actually find routes, otherwise the
    // guardrail below would vacuously pass.
    expect(handlers.length).toBeGreaterThan(0);
  });

  it("should_declare_authorization_on_every_handler", () => {
    const undeclared = handlers
      .filter(
        ({ controller, handler }) =>
          !isPublic(controller, handler) &&
          !hasRequiredPermission(controller, handler),
      )
      .map(describeHandler);

    expect(undeclared).toEqual([]);
  });

  it("should_not_declare_both_public_and_required_permission", () => {
    const conflicting = handlers
      .filter(
        ({ controller, handler }) =>
          isPublic(controller, handler) &&
          hasRequiredPermission(controller, handler),
      )
      .map(describeHandler);

    expect(conflicting).toEqual([]);
  });
});
