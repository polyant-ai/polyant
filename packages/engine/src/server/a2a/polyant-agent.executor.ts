// SPDX-License-Identifier: AGPL-3.0-or-later

import { randomUUID } from "node:crypto";

import { AgentEvent, type AgentExecutor, type RequestContext, type ExecutionEventBus } from "@a2a-js/sdk/server";
import { TaskState, Role, type Task, type TaskStatus, type Message, type Part } from "@a2a-js/sdk";

import type { IncomingMessage, StreamMessageHandler, StreamOutgoingMessage } from "../../channels/types.js";
import type { AgentSlug } from "../../instances/identifiers.js";
import { extractText } from "./a2a-context.js";

function textPart(value: string): Part {
  return { content: { $case: "text", value }, metadata: undefined, filename: "", mediaType: "text/plain" };
}

function statusOf(state: TaskState, message?: Message): TaskStatus {
  return { state, message, timestamp: new Date().toISOString() };
}

function freshTask(ctx: RequestContext): Task {
  return {
    id: ctx.taskId,
    contextId: ctx.contextId,
    status: statusOf(TaskState.TASK_STATE_SUBMITTED),
    artifacts: [],
    history: [ctx.userMessage],
    metadata: undefined,
  };
}

function buildIncomingMessage(slug: AgentSlug, ctx: RequestContext): IncomingMessage {
  return {
    channelType: "agent",
    // ponytail: encode the A2A contextId into channelId so the pipeline's own
    // conversationId template (`${slug}:agent:${channelId}`) yields ONE
    // conversation per A2A context. The pipeline never reads
    // metadata.conversationId (only server-resolved overrides), so a constant
    // channelId would have collapsed all A2A traffic into a single conversation
    // per instance. ctx.contextId is always populated (SDK generates one when
    // the client omits it → a fresh conversation).
    channelId: `a2a:${ctx.contextId}`,
    instanceId: slug,
    userName: "a2a",
    text: extractText(ctx.userMessage),
    metadata: { source: "a2a" },
  };
}

function buildReplyMessage(ctx: RequestContext, text: string): Message {
  return {
    messageId: randomUUID(),
    contextId: ctx.contextId,
    taskId: ctx.taskId,
    role: Role.ROLE_AGENT,
    parts: [textPart(text)],
    metadata: undefined,
    extensions: [],
    referenceTaskIds: [],
  };
}

function publishStatus(bus: ExecutionEventBus, ctx: RequestContext, state: TaskState, message?: Message): void {
  bus.publish(
    AgentEvent.statusUpdate({
      taskId: ctx.taskId,
      contextId: ctx.contextId,
      status: statusOf(state, message),
      metadata: undefined,
    }),
  );
}

/** Publishes one artifact-update event per non-empty text-delta chunk; stops early on abort. */
async function publishArtifactChunks(
  bus: ExecutionEventBus,
  ctx: RequestContext,
  stream: StreamOutgoingMessage,
  abort: AbortController,
): Promise<void> {
  let first = true;
  for await (const part of stream.fullStream as AsyncIterable<{ type: string; text?: string }>) {
    if (abort.signal.aborted) return;
    if (part.type === "text-delta" && part.text) {
      bus.publish(
        AgentEvent.artifactUpdate({
          taskId: ctx.taskId,
          contextId: ctx.contextId,
          artifact: {
            artifactId: "response",
            name: "response",
            description: "",
            parts: [textPart(part.text)],
            metadata: undefined,
            extensions: [],
          },
          append: !first,
          lastChunk: false,
          metadata: undefined,
        }),
      );
      first = false;
    }
  }
}

/**
 * Bridge the A2A execution seam to the Polyant streaming pipeline. One code
 * path serves both message/send and message/stream: the DefaultRequestHandler
 * collapses the published event stream into a Task for the non-streaming call.
 * Tasks are ephemeral — the pipeline is synchronous single-turn.
 *
 * A module-closure `Map<taskId, AbortController>` lets `cancelTask` interrupt
 * an in-flight `execute` call for the same task.
 */
export function createPolyantExecutor(slug: AgentSlug, streamHandler: StreamMessageHandler): AgentExecutor {
  const aborts = new Map<string, AbortController>();

  return {
    async execute(ctx: RequestContext, bus: ExecutionEventBus): Promise<void> {
      const abort = new AbortController();
      aborts.set(ctx.taskId, abort);

      try {
        // Every execute() call MUST publish a task (or message) event FIRST —
        // including follow-up turns where ctx.task is already set — or the
        // server rejects the stream.
        bus.publish(AgentEvent.task(ctx.task ?? freshTask(ctx)));
        publishStatus(bus, ctx, TaskState.TASK_STATE_WORKING);

        const stream = await streamHandler(buildIncomingMessage(slug, ctx), abort.signal);
        await publishArtifactChunks(bus, ctx, stream, abort);

        if (abort.signal.aborted) {
          publishStatus(bus, ctx, TaskState.TASK_STATE_CANCELED);
          return;
        }

        const { text: fullText } = await stream.completed;
        publishStatus(bus, ctx, TaskState.TASK_STATE_COMPLETED, buildReplyMessage(ctx, fullText));
      } catch {
        publishStatus(bus, ctx, abort.signal.aborted ? TaskState.TASK_STATE_CANCELED : TaskState.TASK_STATE_FAILED);
      } finally {
        aborts.delete(ctx.taskId);
        bus.finished();
      }
    },

    async cancelTask(taskId: string, _bus: ExecutionEventBus): Promise<void> {
      aborts.get(taskId)?.abort();
    },
  };
}
