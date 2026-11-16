// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Param,
  Body,
  Query,
  NotFoundException,
  BadRequestException,
} from "@nestjs/common";
import { findInstanceOrFail } from "./instance-helpers.js";
import * as scheduledTaskStore from "../../scheduled-tasks/store.js";
import { parsePagination } from "../utils/parse-pagination.js";
import * as runLogStore from "../../scheduled-tasks/run-log.store.js";
import { formatScheduleHuman } from "../../scheduled-tasks/schedule-utils.js";
import type { ScheduleConfig, RunStatus } from "../../scheduled-tasks/schema.js";
import { RequirePermission, Permission } from "../../authz/index.js";
import { isUuid } from "../../utils/uuid.js";
import { createAgentTask, runAgentTaskNow, updateAgentTask } from "../../scheduled-tasks/agent-tasks.js";
import { refusalsAsHttp } from "./refusal-to-http.js";

@Controller("api/instances")
export class InstanceScheduledTasksController {
  @RequirePermission(Permission.TASK_READ)
  @Get(":slug/scheduled-tasks")
  async list(
    @Param("slug") slug: string,
    @Query("limit") limitStr?: string,
    @Query("offset") offsetStr?: string,
    @Query("enabledOnly") enabledOnlyStr?: string,
  ) {
    const instance = await findInstanceOrFail(slug);

    // Mirror the parse/clamp pattern used by `listRuns` below.
    // `limit` is hard-capped at 500 to prevent unbounded admin payloads;
    // `offset` is non-negative. Invalid values fall back to safe defaults.
    const limit = limitStr ? Math.min(Math.max(parseInt(limitStr, 10) || 100, 1), 500) : 100;
    const offset = offsetStr ? Math.max(parseInt(offsetStr, 10) || 0, 0) : 0;
    const enabledOnly = enabledOnlyStr === "true";

    const tasks = await scheduledTaskStore.listByInstance(instance.slug, {
      limit,
      offset,
      enabledOnly,
    });
    return {
      tasks: tasks.map((t) => ({
        id: t.id,
        name: t.name,
        description: t.description,
        schedule: t.schedule,
        scheduleHuman: formatScheduleHuman(t.schedule as ScheduleConfig),
        prompt: t.prompt,
        enabled: t.enabled,
        nextRunAt: t.nextRunAt?.toISOString() ?? null,
        lastRunAt: t.lastRunAt?.toISOString() ?? null,
        lastRunStatus: t.lastRunStatus,
        lastError: t.lastError,
        lastConversationId: t.lastConversationId,
        consecutiveErrors: t.consecutiveErrors,
        totalRuns: t.totalRuns,
        deleteAfterRun: t.deleteAfterRun,
        maxRetries: t.maxRetries,
        createdBy: t.createdBy,
        createdAt: t.createdAt?.toISOString() ?? null,
        outboundChannel: t.outboundChannel ?? null,
        outboundTarget: t.outboundTarget ?? null,
        keepHistory: t.keepHistory,
        maxRunMs: t.maxRunMs ?? null,
        updatedAt: t.updatedAt?.toISOString() ?? null,
      })),
    };
  }

  @RequirePermission(Permission.TASK_READ)
  @Get(":slug/scheduled-tasks/runs")
  async listRuns(
    @Param("slug") slug: string,
    @Query("taskId") taskId?: string,
    @Query("status") status?: string,
    @Query("limit") limitStr?: string,
    @Query("offset") offsetStr?: string,
  ) {
    const instance = await findInstanceOrFail(slug);

    const { limit, offset } = parsePagination(limitStr, offsetStr);

    // Validate taskId format (must be UUID) and ownership
    if (taskId) {
      if (!isUuid(taskId)) {
        throw new BadRequestException("Invalid taskId format");
      }
      const task = await scheduledTaskStore.getById(taskId);
      if (!task || task.instanceId !== instance.slug) {
        throw new NotFoundException(`Task "${taskId}" not found`);
      }
    }

    const validStatuses: RunStatus[] = ["running", "success", "error"];
    const parsedStatus = status && validStatuses.includes(status as RunStatus) ? (status as RunStatus) : undefined;

    const { runs, total } = await runLogStore.listRuns(instance.slug, {
      taskId,
      status: parsedStatus,
      limit,
      offset,
    });

    return {
      runs: runs.map((r) => ({
        id: r.id,
        taskId: r.taskId,
        taskName: r.taskName,
        status: r.status,
        triggerType: r.triggerType,
        startedAt: r.startedAt?.toISOString() ?? null,
        completedAt: r.completedAt?.toISOString() ?? null,
        durationMs: r.durationMs,
        output: r.output,
        error: r.error,
        toolCalls: r.toolCalls,
        tokenUsage: r.tokenUsage,
        conversationId: r.conversationId,
      })),
      total,
    };
  }

  @RequirePermission(Permission.TASK_READ)
  @Get(":slug/scheduled-tasks/:id")
  async getOne(@Param("slug") slug: string, @Param("id") id: string) {
    const instance = await findInstanceOrFail(slug);

    const task = await scheduledTaskStore.getById(id);
    if (!task || task.instanceId !== instance.slug) {
      throw new NotFoundException(`Scheduled task "${id}" not found`);
    }

    return {
      task: {
        ...task,
        scheduleHuman: formatScheduleHuman(task.schedule as ScheduleConfig),
        nextRunAt: task.nextRunAt?.toISOString() ?? null,
        lastRunAt: task.lastRunAt?.toISOString() ?? null,
        createdAt: task.createdAt?.toISOString() ?? null,
        updatedAt: task.updatedAt?.toISOString() ?? null,
      },
    };
  }

  @RequirePermission(Permission.TASK_WRITE)
  @Post(":slug/scheduled-tasks")
  async create(
    @Param("slug") slug: string,
    @Body()
    body: {
      name: string;
      prompt: string;
      schedule: ScheduleConfig;
      description?: string;
      deleteAfterRun?: boolean;
      maxRetries?: number;
      outboundChannel?: string | null;
      outboundTarget?: string | null;
      keepHistory?: boolean;
      enabled?: boolean;
      maxRunMs?: number | null;
    },
  ) {
    const instance = await findInstanceOrFail(slug);

    const task = await refusalsAsHttp(() => createAgentTask(instance.slug, { ...body, createdBy: "api" }));

    return {
      task: {
        id: task.id,
        name: task.name,
        schedule: task.schedule,
        scheduleHuman: formatScheduleHuman(task.schedule as ScheduleConfig),
        enabled: task.enabled,
        outboundChannel: task.outboundChannel ?? null,
        outboundTarget: task.outboundTarget ?? null,
        keepHistory: task.keepHistory,
        maxRunMs: task.maxRunMs ?? null,
        nextRunAt: task.nextRunAt?.toISOString() ?? null,
        createdAt: task.createdAt?.toISOString() ?? null,
      },
    };
  }

  @RequirePermission(Permission.TASK_WRITE)
  @Patch(":slug/scheduled-tasks/:id")
  async update(
    @Param("slug") slug: string,
    @Param("id") id: string,
    @Body()
    body: {
      name?: string;
      description?: string;
      prompt?: string;
      schedule?: ScheduleConfig;
      enabled?: boolean;
      deleteAfterRun?: boolean;
      maxRetries?: number;
      outboundChannel?: string | null;
      outboundTarget?: string | null;
      keepHistory?: boolean;
      maxRunMs?: number | null;
    },
  ) {
    const instance = await findInstanceOrFail(slug);

    const updated = await refusalsAsHttp(() => updateAgentTask(instance.slug, id, body));

    return {
      task: {
        id: updated.id,
        name: updated.name,
        schedule: updated.schedule,
        scheduleHuman: formatScheduleHuman(updated.schedule as ScheduleConfig),
        enabled: updated.enabled,
        nextRunAt: updated.nextRunAt?.toISOString() ?? null,
        lastRunStatus: updated.lastRunStatus,
        outboundChannel: updated.outboundChannel ?? null,
        outboundTarget: updated.outboundTarget ?? null,
        keepHistory: updated.keepHistory,
        maxRunMs: updated.maxRunMs ?? null,
        updatedAt: updated.updatedAt?.toISOString() ?? null,
      },
    };
  }

  @RequirePermission(Permission.TASK_WRITE)
  @Delete(":slug/scheduled-tasks/:id")
  async remove(@Param("slug") slug: string, @Param("id") id: string) {
    const instance = await findInstanceOrFail(slug);

    const existing = await scheduledTaskStore.getById(id);
    if (!existing || existing.instanceId !== instance.slug) {
      throw new NotFoundException(`Scheduled task "${id}" not found`);
    }

    await scheduledTaskStore.remove(id);

    return { deleted: true };
  }

  @RequirePermission(Permission.TASK_WRITE)
  @Post(":slug/scheduled-tasks/:id/run")
  async runNow(@Param("slug") slug: string, @Param("id") id: string) {
    const instance = await findInstanceOrFail(slug);

    const task = await refusalsAsHttp(() => runAgentTaskNow(instance.slug, id));

    return {
      message: `Task "${task.name}" execution started.`,
    };
  }

}
