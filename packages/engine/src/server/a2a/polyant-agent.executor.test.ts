// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect } from "vitest";
import { TaskState, Role, type Message, type Part, type TaskStatusUpdateEvent, type TaskArtifactUpdateEvent } from "@a2a-js/sdk";
import type { RequestContext, ExecutionEventBus, AgentExecutionEvent } from "@a2a-js/sdk/server";
import { createPolyantExecutor } from "./polyant-agent.executor.js";
import { asInstanceSlug } from "../../instances/identifiers.js";
import type { StreamMessageHandler, StreamOutgoingMessage } from "../../channels/types.js";

// NOTE: the installed @a2a-js/sdk@1.0.0 event/part shapes are the v1
// protobuf-generated shape, not the earlier JSON-REST shape the original
// task brief sketched (no `kind:"..."` literal on the event itself — events
// are `{kind, data}` wrappers from the `AgentEvent` factory; text lives at
// `part.content.value` behind a `$case:"text"` discriminant; task state is
// the numeric `TaskState` enum, not a string literal).

function textPart(value: string): Part {
  return { content: { $case: "text", value }, metadata: undefined, filename: "", mediaType: "text/plain" };
}

/** Test-only narrowing helper: our own fixtures/implementation always emit text parts. */
function textValue(part: Part): string {
  return (part.content as { $case: "text"; value: string }).value;
}

function statusUpdateData(e: AgentExecutionEvent): TaskStatusUpdateEvent {
  if (e.kind !== "statusUpdate") throw new Error(`expected statusUpdate event, got ${e.kind}`);
  return e.data;
}

function artifactUpdateData(e: AgentExecutionEvent): TaskArtifactUpdateEvent {
  if (e.kind !== "artifactUpdate") throw new Error(`expected artifactUpdate event, got ${e.kind}`);
  return e.data;
}

function fakeStream(parts: Array<{ type: string; text?: string }>, finalText: string): StreamOutgoingMessage {
  return {
    textStream: (async function* () {
      yield finalText;
    })(),
    fullStream: (async function* () {
      for (const p of parts) yield p;
    })(),
    completed: Promise.resolve({ text: finalText }),
  };
}

function fakeBus(): { bus: ExecutionEventBus; published: AgentExecutionEvent[]; isFinished: () => boolean } {
  const published: AgentExecutionEvent[] = [];
  let finishedCalled = false;
  const bus = {
    publish: (e: AgentExecutionEvent) => published.push(e),
    finished: () => {
      finishedCalled = true;
    },
  } as unknown as ExecutionEventBus;
  return { bus, published, isFinished: () => finishedCalled };
}

const userMessage: Message = {
  messageId: "m1",
  contextId: "c1",
  taskId: "t1",
  role: Role.ROLE_USER,
  parts: [textPart("hi")],
  metadata: undefined,
  extensions: [],
  referenceTaskIds: [],
};

function fakeContext(): RequestContext {
  return { taskId: "t1", contextId: "c1", userMessage, task: undefined } as unknown as RequestContext;
}

describe("createPolyantExecutor.execute", () => {
  it("should_publish_task_working_artifacts_then_completed_with_full_text", async () => {
    const handler: StreamMessageHandler = async () =>
      fakeStream([{ type: "text-delta", text: "Hel" }, { type: "text-delta", text: "lo" }], "Hello");
    const exec = createPolyantExecutor(asInstanceSlug("acme"), handler);
    const { bus, published, isFinished } = fakeBus();

    await exec.execute(fakeContext(), bus);

    expect(published[0].kind).toBe("task");
    expect(
      published.some((e) => e.kind === "statusUpdate" && e.data.status?.state === TaskState.TASK_STATE_WORKING),
    ).toBe(true);

    const artifactEvents = published.filter((e) => e.kind === "artifactUpdate").map(artifactUpdateData);
    expect(artifactEvents.length).toBe(2);
    expect(textValue(artifactEvents[0].artifact!.parts[0])).toBe("Hel");
    expect(artifactEvents[0].append).toBe(false);
    expect(textValue(artifactEvents[1].artifact!.parts[0])).toBe("lo");
    expect(artifactEvents[1].append).toBe(true);

    const final = statusUpdateData(published.at(-1)!);
    expect(final.status?.state).toBe(TaskState.TASK_STATE_COMPLETED);
    expect(textValue(final.status!.message!.parts[0])).toBe("Hello");
    expect(isFinished()).toBe(true);
  });

  it("should_pass_extracted_text_and_context_derived_channelId_into_the_pipeline", async () => {
    let seen: Parameters<StreamMessageHandler>[0] | undefined;
    const handler: StreamMessageHandler = async (msg) => {
      seen = msg;
      return fakeStream([], "ok");
    };
    const exec = createPolyantExecutor(asInstanceSlug("acme"), handler);
    await exec.execute(fakeContext(), fakeBus().bus);
    expect(seen?.text).toBe("hi");
    // contextId "c1" → channelId "a2a:c1" → pipeline conversationId "acme:agent:a2a:c1"
    expect(seen?.channelId).toBe("a2a:c1");
    expect(seen?.channelType).toBe("agent");
  });

  it("should_publish_failed_when_the_pipeline_throws", async () => {
    const handler: StreamMessageHandler = async () => {
      throw new Error("boom");
    };
    const exec = createPolyantExecutor(asInstanceSlug("acme"), handler);
    const { bus, published, isFinished } = fakeBus();

    await exec.execute(fakeContext(), bus);

    const final = statusUpdateData(published.at(-1)!);
    expect(final.status?.state).toBe(TaskState.TASK_STATE_FAILED);
    expect(isFinished()).toBe(true);
  });

  it("should_abort_the_pipeline_signal_on_cancelTask", async () => {
    let capturedSignal: AbortSignal | undefined;
    const handler: StreamMessageHandler = async (_msg, signal) => {
      capturedSignal = signal;
      // never-resolving stream so cancelTask lands mid-flight
      return {
        textStream: (async function* () {})(),
        // eslint-disable-next-line require-yield -- deliberately never yields, to hang the loop until cancelTask aborts
        fullStream: (async function* () {
          await new Promise(() => {});
        })(),
        completed: new Promise(() => {}),
      };
    };
    const exec = createPolyantExecutor(asInstanceSlug("acme"), handler);
    const { bus } = fakeBus();
    const running = exec.execute(fakeContext(), bus);
    // let execute reach the pipeline call
    await new Promise((r) => setTimeout(r, 5));
    await exec.cancelTask("t1", bus);
    expect(capturedSignal?.aborted).toBe(true);
    // avoid an unhandled hang: the never-resolving execute is abandoned by the test
    void running;
  });

  it("should_publish_canceled_when_the_signal_is_aborted_mid_stream", async () => {
    const { bus, published, isFinished } = fakeBus();
    // Forward reference: the fake fullStream calls back into the executor's own
    // cancelTask (deterministically, right after its one chunk) instead of
    // relying on a timer or a hanging promise, so execute() reaches its
    // post-loop `abort.signal.aborted` check on its own and never awaits
    // `stream.completed` (which intentionally never resolves). Safe as a
    // `const` referenced from inside a closure that only runs once execute()
    // starts iterating fullStream, well after the assignment below completes.
    const handler: StreamMessageHandler = async () => ({
      textStream: (async function* () {
        yield "Hel";
      })(),
      fullStream: (async function* () {
        yield { type: "text-delta", text: "Hel" };
        await execRef.cancelTask("t1", bus);
      })(),
      completed: new Promise(() => {}),
    });
    const execRef = createPolyantExecutor(asInstanceSlug("acme"), handler);

    await execRef.execute(fakeContext(), bus);

    const final = statusUpdateData(published.at(-1)!);
    expect(final.status?.state).toBe(TaskState.TASK_STATE_CANCELED);
    expect(isFinished()).toBe(true);
  });
});
