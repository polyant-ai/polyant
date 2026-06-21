// SPDX-License-Identifier: AGPL-3.0-or-later

import { Module } from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";
import { ThrottlerModule, ThrottlerGuard } from "@nestjs/throttler";
import { OpenAIModule } from "./openai/openai.module.js";
import { AuthModule } from "../auth/auth.module.js";
import { AuthzModule } from "../authz/authz.module.js";
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
import { SkillsModule } from "../skills/skills.module.js";
import { UsersModule } from "../users/users.module.js";
import { ActivityStreamModule } from "../activity-stream/activity-stream.module.js";
import { OptoutsModule } from "./optouts/optouts.module.js";
import { MembersModule } from "./members/members.module.js";
import { OrganizationsModule } from "../organizations/organizations.module.js";

@Module({
  imports: [
    ThrottlerModule.forRoot([{
      name: "default",
      ttl: 60_000,
      limit: 30,
    }]),
    OpenAIModule,
    SkillsModule,
    UsersModule,
    AuthModule,
    // MUST be imported after AuthModule: the PermissionGuard (APP_GUARD #3)
    // reads request.user which AuthGuard (#2) populates. Registration order
    // across the module graph is the global-guard execution order.
    AuthzModule,
    ActivityStreamModule,
    OptoutsModule,
    MembersModule,
    OrganizationsModule,
  ],
  providers: [
    { provide: APP_GUARD, useClass: ThrottlerGuard },
  ],
  controllers: [
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
  ],
})
export class ServerModule {}
