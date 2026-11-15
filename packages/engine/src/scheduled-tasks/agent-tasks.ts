// SPDX-License-Identifier: AGPL-3.0-or-later

import { AgentRequestRefusedError } from "../instances/agent-refusal.js";
import type { InstanceSlug } from "../instances/identifiers.js";
import { createLogger } from "../utils/create-logger.js";
import type { ScheduleConfig } from "./schema.js";
import { parseRelativeDuration, parseSchedule } from "./schedule-utils.js";
import { schedulerService } from "./scheduler.service.js";
import * as scheduledTaskStore from "./store.js";

const log = createLogger();

/** Floor for an API-provided run deadline. Below a second no run can complete. */
const MIN_MAX_RUN_MS = 1_000;

/**
 * Validate an API-provided `maxRunMs`.
 *
 * The value drives the reaper, so a zero or negative deadline would make every run of that
 * task reapable the instant it starts — a task that can never succeed, failing with
 * `orphaned` forever. Rejected rather than clamped: a silently corrected deadline is a
 * deadline nobody can reason about from the outside.
 */
function assertMaxRunMs(value: number | null | undefined): number | null | undefined {
  if (value === undefined || value === null) return value;
  if (!Number.isInteger(value) || value < MIN_MAX_RUN_MS) {
    throw new AgentRequestRefusedError(
      `Field 'maxRunMs' must be an integer of at least ${MIN_MAX_RUN_MS} ms (or null to use the server default)`,
      "invalid",
    );
  }
  return value;
}

/**
 * Validate an API-provided schedule with the rule every writer shares, and resolve a
 * relative one-shot ("+20m") to its timestamp. An interval below the minimum, or zero,
 * would otherwise be stored and computed on every tick.
 */
function assertSchedule(raw: unknown): ScheduleConfig {
  const parsed = parseSchedule(raw);
  if ("error" in parsed) throw new AgentRequestRefusedError(parsed.error, "invalid");
  const { schedule } = parsed;
  if (schedule.type === "one-shot" && schedule.runAt.startsWith("+")) {
    return { ...schedule, runAt: parseRelativeDuration(schedule.runAt).toISOString() };
  }
  return schedule;
}

/** The fields a caller may set on an agent's scheduled task. `schedule` is validated here. */
export interface AgentTaskFields {
  name?: string;
  description?: string;
  prompt?: string;
  schedule?: unknown;
  enabled?: boolean;
  deleteAfterRun?: boolean;
  maxRetries?: number;
  outboundChannel?: string | null;
  outboundTarget?: string | null;
  keepHistory?: boolean;
  maxRunMs?: number | null;
}

async function agentTaskOrRefuse(agentSlug: InstanceSlug, id: string) {
  const task = await scheduledTaskStore.getById(id);
  if (!task || task.instanceId !== agentSlug) {
    throw new AgentRequestRefusedError(`Scheduled task "${id}" not found`, "not_found");
  }
  return task;
}

/** Create a scheduled task for an agent. `createdBy` records which surface asked. */
export async function createAgentTask(agentSlug: InstanceSlug, fields: AgentTaskFields & { createdBy: string }) {
  if (!fields.name || !fields.prompt || !fields.schedule) {
    throw new AgentRequestRefusedError("Fields 'name', 'prompt', and 'schedule' are required", "invalid");
  }
  return scheduledTaskStore.create({
    instanceId: agentSlug,
    name: fields.name,
    prompt: fields.prompt,
    schedule: assertSchedule(fields.schedule),
    description: fields.description,
    deleteAfterRun: fields.deleteAfterRun,
    maxRetries: fields.maxRetries,
    createdBy: fields.createdBy,
    keepHistory: fields.keepHistory,
    outboundChannel: fields.outboundChannel,
    outboundTarget: fields.outboundTarget,
    enabled: fields.enabled,
    maxRunMs: assertMaxRunMs(fields.maxRunMs),
  });
}

/** Change an agent's scheduled task; only the fields given change. */
export async function updateAgentTask(agentSlug: InstanceSlug, id: string, fields: AgentTaskFields) {
  await agentTaskOrRefuse(agentSlug, id);
  const updated = await scheduledTaskStore.update(id, {
    ...fields,
    schedule: fields.schedule === undefined ? undefined : assertSchedule(fields.schedule),
    maxRunMs: assertMaxRunMs(fields.maxRunMs),
  });
  if (!updated) throw new AgentRequestRefusedError(`Scheduled task "${id}" not found`, "not_found");
  return updated;
}

/** Start one run of an agent's scheduled task now, in the background; returns the task. */
export async function runAgentTaskNow(agentSlug: InstanceSlug, id: string) {
  const task = await agentTaskOrRefuse(agentSlug, id);
  schedulerService.runNow(task).catch((err) =>
    log.error("scheduled-tasks", `RunNow: task "${task.name}" failed`, err),
  );
  return task;
}
