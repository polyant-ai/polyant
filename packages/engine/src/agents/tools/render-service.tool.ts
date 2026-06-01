// SPDX-License-Identifier: AGPL-3.0-or-later

import { z } from "zod";
import { registerTool, type ToolContext } from "./registry.js";
import { errMsg } from "../../utils/error.js";
import { renderFetch } from "./render-fetch.js";

// ---------------------------------------------------------------------------
// Render API response types (verified from live API)
// ---------------------------------------------------------------------------

interface RenderServiceWrapper {
  cursor: string;
  service: {
    id: string;
    name: string;
    type: string;
    slug: string;
    suspended: string;
    suspenders: string[];
    serviceDetails: {
      region?: string;
      plan?: string;
      url?: string;
      runtime?: string;
      schedule?: string;
    };
    dashboardUrl: string;
    ownerId: string;
    updatedAt: string;
    createdAt: string;
  };
}

interface RenderLogEntry {
  id: string;
  labels: Array<{ name: string; value: string }>;
  message: string;
  timestamp: string;
}

interface RenderLogsResponse {
  hasMore: boolean;
  logs: RenderLogEntry[];
  nextStartTime?: string;
  nextEndTime?: string;
}

interface RenderDeployWrapper {
  cursor: string;
  deploy: {
    id: string;
    status: string;
    trigger: string;
    commit?: {
      id?: string;
      message?: string;
      createdAt?: string;
    };
    createdAt: string;
    updatedAt: string;
    startedAt?: string;
    finishedAt?: string;
  };
}

// ---------------------------------------------------------------------------
// Action handlers
// ---------------------------------------------------------------------------

function labelValue(labels: Array<{ name: string; value: string }>, key: string): string | null {
  return labels.find((l) => l.name === key)?.value ?? null;
}

/** Normalize any valid ISO timestamp to UTC (suffix Z). Avoids +02:00 offsets breaking URL encoding. */
function toUTC(ts: string | null | undefined): string | null {
  if (!ts) return null;
  const d = new Date(ts);
  return isNaN(d.getTime()) ? null : d.toISOString();
}

async function handleList(apiKey: string, opts: { ownerId: string | null; environmentId: string | null }) {
  const params: Record<string, string | string[]> = { limit: "100" };
  if (opts.ownerId) params.ownerId = opts.ownerId;
  if (opts.environmentId) params.environmentId = opts.environmentId;

  const data = await renderFetch<RenderServiceWrapper[]>("/services", params, apiKey);

  return {
    services: data.map((item) => ({
      id: item.service.id,
      name: item.service.name,
      type: item.service.type,
      slug: item.service.slug,
      region: item.service.serviceDetails?.region ?? null,
      plan: item.service.serviceDetails?.plan ?? null,
      url: item.service.serviceDetails?.url ?? null,
      dashboardUrl: item.service.dashboardUrl,
      status: item.service.suspended === "not_suspended" ? "active" : "suspended",
      updatedAt: item.service.updatedAt,
    })),
  };
}

const DEFAULT_LOG_CAP = 1000;
const LOG_PAGE_SIZE = 100;
const MAX_PAGES = 15;

async function handleLogs(
  apiKey: string,
  ownerId: string,
  resourceIds: string[],
  opts: { startTime: string | null; endTime: string | null; lastHours: number | null; level: string[] | null; text: string | null; limit: number | null },
) {
  const cap = Math.min(opts.limit ?? DEFAULT_LOG_CAP, DEFAULT_LOG_CAP);

  const now = new Date();
  let effectiveStart: string;
  let effectiveEnd: string;

  if (opts.lastHours && opts.lastHours > 0) {
    // lastHours takes precedence: from N hours ago to now
    effectiveEnd = now.toISOString();
    effectiveStart = new Date(now.getTime() - opts.lastHours * 60 * 60 * 1000).toISOString();
  } else if (opts.startTime || opts.endTime) {
    // Explicit timestamps (normalized to UTC)
    const yesterdayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 1));
    const yesterdayEnd = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) - 1);
    effectiveStart = toUTC(opts.startTime) ?? yesterdayStart.toISOString();
    effectiveEnd = toUTC(opts.endTime) ?? yesterdayEnd.toISOString();
  } else {
    // Default: yesterday full day (midnight-to-midnight UTC)
    effectiveStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 1)).toISOString();
    effectiveEnd = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) - 1).toISOString();
  }
  let startTime = effectiveStart;
  let endTime = effectiveEnd;

  const allEntries: Array<{
    id: string;
    timestamp: string;
    level: string | null;
    type: string | null;
    resource: string | null;
    message: string;
  }> = [];
  let truncated = false;
  let pagesFetched = 0;

  for (let page = 0; page < MAX_PAGES; page++) {
    const params: Record<string, string | string[]> = {
      ownerId,
      resource: resourceIds,
      startTime,
      endTime,
      limit: String(LOG_PAGE_SIZE),
      direction: "backward",
    };
    if (opts.level?.length) params.level = opts.level;
    if (opts.text) params.text = opts.text;

    let data: RenderLogsResponse;
    try {
      data = await renderFetch<RenderLogsResponse>("/logs", params, apiKey);
      pagesFetched++;
    } catch (err) {
      // If a page fails (e.g. malformed response), return what we accumulated so far
      if (allEntries.length > 0) {
        truncated = true;
        break;
      }
      throw err;
    }

    for (const entry of data.logs ?? []) {
      allEntries.push({
        id: entry.id,
        timestamp: entry.timestamp,
        level: labelValue(entry.labels, "level"),
        type: labelValue(entry.labels, "type"),
        resource: labelValue(entry.labels, "resource"),
        message: entry.message,
      });

      if (allEntries.length >= cap) {
        truncated = true;
        break;
      }
    }

    if (truncated) break;
    if (!data.hasMore) break;
    if (!data.nextStartTime || !data.nextEndTime) {
      truncated = true;
      break;
    }
    startTime = data.nextStartTime;
    endTime = data.nextEndTime;
  }

  return {
    entries: allEntries,
    totalFetched: allEntries.length,
    truncated,
    timeWindow: { start: effectiveStart, end: effectiveEnd },
    pagesFetched,
  };
}

async function handleDeploys(
  apiKey: string,
  serviceId: string,
  opts: { startTime: string | null; endTime: string | null; lastHours: number | null },
) {
  const now = new Date();
  let createdAfter: string;
  let createdBefore: string | null = null;

  if (opts.lastHours && opts.lastHours > 0) {
    createdAfter = new Date(now.getTime() - opts.lastHours * 60 * 60 * 1000).toISOString();
  } else {
    const yesterdayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 1));
    createdAfter = toUTC(opts.startTime) ?? yesterdayStart.toISOString();
    createdBefore = toUTC(opts.endTime);
  }

  const params: Record<string, string | string[]> = { limit: "50" };
  params.createdAfter = createdAfter;
  if (createdBefore) params.createdBefore = createdBefore;

  const data = await renderFetch<RenderDeployWrapper[]>(
    `/services/${serviceId}/deploys`,
    params,
    apiKey,
  );

  const deploys = data.map((item) => ({
    id: item.deploy.id,
    status: item.deploy.status,
    trigger: item.deploy.trigger,
    commitMessage: item.deploy.commit?.message ?? null,
    commitId: item.deploy.commit?.id ?? null,
    createdAt: item.deploy.createdAt,
    startedAt: item.deploy.startedAt ?? null,
    finishedAt: item.deploy.finishedAt ?? null,
  }));

  return { deploys };
}

// ---------------------------------------------------------------------------
// Tool registration
// ---------------------------------------------------------------------------

registerTool({
  name: "renderService",
  description:
    "Interacts with Render.com services.\n" +
    "- action 'list': lists services. Filter by environmentId (Render project) or ownerId (workspace).\n" +
    "- action 'logs': fetches logs for one or more services with filters for level, text and time window. Available levels: error, warning, info.\n" +
    "- action 'deploys': lists recent deploys for a service with status and commit details.\n" +
    "Time window: default = the whole of yesterday (00:00-23:59 UTC). Pass null for startTime/endTime to use the default. Timestamps are converted to UTC automatically.\n" +
    "Requires the 'render_api_key' secret configured on the instance.",
  category: "devops",
  requiredSecrets: ["render_api_key"],
  inputExamples: [
    {
      label: "List the services of a project",
      input: {
        action: "list",
        environmentId: "evm-xxx",
        ownerId: null,
        resourceIds: null,
        serviceId: null,
        lastHours: null,
        startTime: null,
        endTime: null,
        level: null,
        text: null,
        limit: null,
      },
    },
    {
      label: "Logs for the last 3 hours",
      input: {
        action: "logs",
        ownerId: "own-xxx",
        resourceIds: ["srv-xxx"],
        serviceId: null,
        lastHours: 3,
        startTime: null,
        endTime: null,
        level: null,
        text: null,
        limit: null,
      },
    },
    {
      label: "Recent deploys",
      input: {
        action: "deploys",
        ownerId: null,
        resourceIds: null,
        serviceId: "srv-xxx",
        lastHours: null,
        startTime: null,
        endTime: null,
        level: null,
        text: null,
        limit: null,
      },
    },
  ],
  create: (ctx: ToolContext) => ({
    parameters: z.object({
      action: z
        .enum(["list", "logs", "deploys"])
        .describe("'list' to list services, 'logs' to fetch logs, 'deploys' for recent deploys"),
      environmentId: z
        .string()
        .nullable()
        .describe("Render environment ID to filter the services of a project (only for 'list')"),
      ownerId: z
        .string()
        .nullable()
        .describe("Render workspace ID (required for 'logs', optional for 'list')"),
      resourceIds: z
        .array(z.string())
        .nullable()
        .describe("Render service IDs to monitor (required for 'logs')"),
      serviceId: z
        .string()
        .nullable()
        .describe("Single service ID (required for 'deploys')"),
      lastHours: z
        .number()
        .nullable()
        .describe("Time window in hours from now (e.g. 3 = last 3 hours). When provided, takes precedence over startTime/endTime. Pass null for the default (whole of yesterday)."),
      startTime: z
        .string()
        .nullable()
        .describe("Start of the time window, ISO 8601 UTC. Pass null for the default (yesterday 00:00 UTC). Ignored when lastHours is provided."),
      endTime: z
        .string()
        .nullable()
        .describe("End of the time window, ISO 8601 UTC. Pass null for the default (yesterday 23:59:59 UTC). Ignored when lastHours is provided."),
      level: z
        .array(z.string())
        .nullable()
        .describe("Log level filter: 'error', 'warning', 'info' (only for 'logs')"),
      text: z
        .string()
        .nullable()
        .describe("Text filter on logs (only for 'logs')"),
      limit: z
        .number()
        .nullable()
        .describe("Max log entries to fetch (default: 1000, max: 1000, only for 'logs')"),
    }),
    execute: async (params: {
      action: "list" | "logs" | "deploys";
      environmentId?: string | null;
      ownerId?: string | null;
      resourceIds?: string[] | null;
      serviceId?: string | null;
      lastHours?: number | null;
      startTime?: string | null;
      endTime?: string | null;
      level?: string[] | null;
      text?: string | null;
      limit?: number | null;
    }) => {
      const apiKey = ctx.secrets?.render_api_key;
      if (!apiKey) {
        return { error: "Render API key (render_api_key) not configured for this instance." };
      }

      try {
        if (params.action === "list") {
          const result = await handleList(apiKey, { ownerId: params.ownerId ?? null, environmentId: params.environmentId ?? null });
          ctx.audit.log({
            action: "devops.renderService.list",
            details: { serviceCount: result.services.length },
            success: true,
          });
          return result;
        }

        if (params.action === "logs") {
          if (!params.ownerId) return { error: "ownerId is required for action 'logs'." };
          if (!params.resourceIds?.length) return { error: "resourceIds is required for action 'logs' (at least one service ID)." };

          const result = await handleLogs(apiKey, params.ownerId, params.resourceIds, {
            lastHours: params.lastHours ?? null,
            startTime: params.startTime ?? null,
            endTime: params.endTime ?? null,
            level: params.level ?? null,
            text: params.text ?? null,
            limit: params.limit ?? null,
          });
          ctx.audit.log({
            action: "devops.renderService.logs",
            details: { resourceIds: params.resourceIds, entryCount: result.totalFetched, truncated: result.truncated },
            success: true,
          });
          return result;
        }

        if (params.action === "deploys") {
          if (!params.serviceId) return { error: "serviceId is required for action 'deploys'." };

          const result = await handleDeploys(apiKey, params.serviceId, {
            lastHours: params.lastHours ?? null,
            startTime: params.startTime ?? null,
            endTime: params.endTime ?? null,
          });
          ctx.audit.log({
            action: "devops.renderService.deploys",
            details: { serviceId: params.serviceId, deployCount: result.deploys.length },
            success: true,
          });
          return result;
        }

        return { error: `Unknown action: ${params.action}` };
      } catch (err) {
        const message = errMsg(err);
        ctx.audit.log({
          action: `devops.renderService.${params.action}`,
          success: false,
          error: message,
        });
        return { error: message };
      }
    },
  }),
});
