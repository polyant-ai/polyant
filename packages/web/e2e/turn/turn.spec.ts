// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * One real turn, end to end: the panel's playground and the HTTP API send a
 * message to an agent, the engine runs it against the fake model
 * (support/fake-model.mjs), the agent calls a tool, and the reply is shown,
 * persisted and listed.
 *
 * What it catches:
 * - the reply the playground streams differs from the reply stored for the
 *   turn, in particular when the text of the step that called the tool is
 *   shown but not stored (or stored but not shown);
 * - the tool call never runs (bad arguments, a tool not enabled, a broken
 *   tool loop), so the model never gets the tool's result back;
 * - a turn that answers but is not persisted or not listed.
 *
 * The agent is created through the panel's own API for this spec and deleted
 * after it, conversations included, so the panel suites never see it. It
 * keeps every step's text as the reply (`intermediateText: "reply"`): that is
 * the policy under which the streamed and the stored reply must be the same
 * text on every channel.
 */

import { request as playwrightRequest, test, expect, type APIRequestContext } from "@playwright/test";
import {
  ENGINE_URL,
  FAKE_MODEL_URL,
  PANEL_ORG_SLUG,
  PANEL_WORKSPACE_SLUG,
  WEB_URL,
} from "../setup/test-env";
import { PANEL_STATE } from "../support/panel";

/* What the fake model answers (written out again here, not imported: the test
   states what it expects instead of reading it from the thing under test). */
const STEP_TEXT = "Checking the turn probe skill before I answer.";
const FINAL_TEXT = "The turn probe skill is not installed, so this answer comes from the fake model.";
/** The reply under `intermediateText: "reply"`: every step's text, a blank line between. */
const EXPECTED_REPLY = `${STEP_TEXT}\n\n${FINAL_TEXT}`;
const TOOL_NAME = "readSkill";
const TOOL_ARGS = { name: "e2e-turn-probe" };
/** What readSkill returns for a skill the agent does not have. */
const TOOL_RESULT = { found: false };

const AGENT_SLUG = "e2e-turn";
const AGENT_NAME = "Turn Probe Agent";
/** The agent's key for the Web channel. A test value for a throwaway agent. */
const AGENT_API_KEY = "e2e-turn-agent-key-0123456789abcdef";

const WORKSPACE_PATH = `/organizations/${PANEL_ORG_SLUG}/workspaces/${PANEL_WORKSPACE_SLUG}`;

interface PersistedStep {
  index: number;
  text: string;
  toolCalls: { toolCallId: string; toolName: string; args: unknown }[];
  toolResults?: { toolCallId: string; result: unknown }[];
}

interface PersistedMessage {
  id: string;
  role: string;
  content: string;
  steps: PersistedStep[] | null;
}

interface FakeModelCall {
  kind: "first" | "final" | "service" | "unsupported";
  stream?: boolean;
  userTexts?: string[];
  functionCallOutputs?: { callId: string; output: unknown }[];
}

interface SseEvent {
  event: string;
  data: unknown;
}

/** The panel's API, as the signed-in panel user, addressing the workspace. */
let panelApi: APIRequestContext;

/**
 * Delete the agent when it exists. Looked up first: the engine answers a
 * route on an agent it cannot place in a tenant with 403, not 404.
 */
async function deleteAgentIfPresent(): Promise<void> {
  const { instances } = (await ok(await panelApi.get("/api/instances"), "list the agents")) as {
    instances: { slug: string }[];
  };
  if (!instances.some((i) => i.slug === AGENT_SLUG)) return;
  await ok(await panelApi.delete(`/api/instances/${AGENT_SLUG}`), `delete ${AGENT_SLUG}`);
}

async function ok(res: Awaited<ReturnType<APIRequestContext["get"]>>, what: string): Promise<unknown> {
  expect(res.ok(), `${what}: ${res.status()} ${await res.text()}`).toBe(true);
  return res.json();
}

test.beforeAll(async () => {
  panelApi = await playwrightRequest.newContext({
    baseURL: WEB_URL,
    storageState: PANEL_STATE,
    extraHTTPHeaders: { "X-Workspace-Slug": PANEL_WORKSPACE_SLUG },
  });
  await deleteAgentIfPresent();

  await ok(
    await panelApi.post("/api/instances", {
      data: { slug: AGENT_SLUG, name: AGENT_NAME, provider: "openai", model: "gpt-4.1-mini" },
    }),
    "create the agent",
  );
  await ok(
    await panelApi.patch(`/api/instances/${AGENT_SLUG}`, { data: { intermediateText: "reply" } }),
    "set the intermediate text policy",
  );
  await ok(
    await panelApi.put(`/api/instances/${AGENT_SLUG}/secrets`, {
      data: {
        secrets: [
          { key: "openai_api_key", value: "sk-e2e-fake-model" },
          { key: "auth_api_key", value: AGENT_API_KEY },
        ],
      },
    }),
    "set the provider key and the agent key",
  );
  const tools = (await ok(
    await panelApi.patch(`/api/instances/${AGENT_SLUG}/tools`, { data: { enabled: [TOOL_NAME] } }),
    "enable the tool",
  )) as { tools: { name: string; enabled: boolean }[] };
  expect(tools.tools.filter((t) => t.enabled).map((t) => t.name)).toEqual([TOOL_NAME]);
  await ok(
    await panelApi.put(`/api/instances/${AGENT_SLUG}/channels/web`, { data: { config: {}, enabled: true } }),
    "switch the Web channel on",
  );
});

test.afterAll(async () => {
  if (!panelApi) return;
  await deleteAgentIfPresent();
  await panelApi.dispose();
});

/** A marker that ties a message to the fake model calls it caused. */
function nonce(): string {
  return `probe-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function parseSse(body: string): SseEvent[] {
  const events: SseEvent[] = [];
  for (const block of body.split("\n\n")) {
    let event = "message";
    const data: string[] = [];
    for (const line of block.split("\n")) {
      if (line.startsWith("event: ")) event = line.slice(7);
      else if (line.startsWith("data: ")) data.push(line.slice(6));
    }
    if (data.length > 0) events.push({ event, data: JSON.parse(data.join("\n")) });
  }
  return events;
}

async function messagesOf(conversationId: string): Promise<PersistedMessage[]> {
  const body = (await ok(
    await panelApi.get(
      `/api/conversations/${encodeURIComponent(conversationId)}/messages?instanceId=${AGENT_SLUG}`,
    ),
    `read the messages of ${conversationId}`,
  )) as { messages: PersistedMessage[] };
  return body.messages;
}

/**
 * The turn's model calls for the message carrying `marker`. The title and
 * summary calls that follow a turn quote the message too; they are not steps.
 */
async function turnCallsFor(marker: string): Promise<FakeModelCall[]> {
  const res = await fetch(`${FAKE_MODEL_URL}/__calls`);
  const { calls } = (await res.json()) as { calls: FakeModelCall[] };
  return calls.filter((c) => c.kind !== "service" && c.userTexts?.some((t) => t.includes(marker)));
}

/** The tool ran: the persisted turn holds the call, its arguments and its result. */
function expectToolStep(assistant: PersistedMessage): void {
  const steps = assistant.steps ?? [];
  expect(steps.map((s) => s.text), "each step's text, in order").toEqual([STEP_TEXT, FINAL_TEXT]);
  const [toolStep] = steps;
  expect(toolStep.toolResults?.map((r) => r.result), "the tool ran: its result is stored with its call").toEqual([TOOL_RESULT]);
  expect(toolStep.toolCalls.map((c) => ({ toolName: c.toolName, args: c.args }))).toEqual([
    { toolName: TOOL_NAME, args: TOOL_ARGS },
  ]);
}

/** The model was called twice, and the second call carried the tool's result back. */
function expectToolResultReachedModel(calls: FakeModelCall[], streamed: boolean): void {
  expect(calls.map((c) => c.kind), "a first step, then the step after the tool").toEqual(["first", "final"]);
  expect(calls.every((c) => c.stream === streamed)).toBe(true);
  const outputs = calls[1].functionCallOutputs ?? [];
  expect(outputs).toHaveLength(1);
  const output = outputs[0].output;
  expect(typeof output === "string" ? JSON.parse(output) : output).toEqual(TOOL_RESULT);
}

test("a playground turn shows, stores and lists the same reply, tool step included", async ({ page }) => {
  const marker = nonce();
  const userText = `Is the turn probe skill installed? (${marker})`;

  await page.goto(`${WORKSPACE_PATH}/playground`);
  await page.getByRole("combobox", { name: "Agent" }).click();
  await page.getByRole("option", { name: new RegExp(AGENT_NAME) }).click();
  await expect(page.getByRole("combobox", { name: "Agent" })).toContainText(AGENT_NAME);

  const streamResponse = page.waitForResponse(
    (r) => r.url().endsWith(`/api/instances/${AGENT_SLUG}/playground/stream`) && r.request().method() === "POST",
  );
  await page.getByPlaceholder("Type a message...").fill(userText);
  await page.getByRole("button", { name: "Send" }).click();

  // What the browser received: the typed SSE stream, read whole once it ends.
  const response = await streamResponse;
  expect(response.ok(), `the stream answered ${response.status()}`).toBe(true);
  const events = parseSse(await response.text());
  const streamed = events
    .filter((e) => e.event === "text-delta")
    .map((e) => (e.data as { text: string }).text)
    .join("");
  expect(events.filter((e) => e.event === "error"), "the stream reports no error").toEqual([]);
  const toolResults = events.filter((e) => e.event === "tool-result").map((e) => (e.data as { result: unknown }).result);
  expect(toolResults, "the tool ran: the stream carries its result").toEqual([TOOL_RESULT]);
  const toolCall = events.find((e) => e.event === "tool-call")?.data as { name: string; args: unknown } | undefined;
  expect(toolCall).toEqual(expect.objectContaining({ name: TOOL_NAME, args: TOOL_ARGS }));
  const done = events.find((e) => e.event === "done")?.data as { conversationId?: string; messageId?: string };
  expect(done?.conversationId, "the stream names the conversation it stored").toBeTruthy();
  const conversationId = done.conversationId as string;

  // What the person sees: both steps' text in the reply bubble, once it ends.
  await expect(page.getByRole("button", { name: "Stop" })).toHaveCount(0, { timeout: 30_000 });
  const bubble = page.locator("div.bg-muted").filter({ hasText: FINAL_TEXT });
  await expect(bubble).toHaveCount(1);
  await expect(bubble).toContainText(STEP_TEXT);

  // What was stored for the turn: the same reply, and the tool's call and result.
  const messages = await messagesOf(conversationId);
  expect(messages.map((m) => m.role)).toEqual(["user", "assistant"]);
  expect(messages[0].content).toBe(userText);
  const assistant = messages[1];
  expect(assistant.id, "the stream names the message it stored").toBe(done.messageId);
  expect(assistant.content, "the stored reply equals the streamed one").toBe(streamed);
  expect(streamed, "the reply holds both steps' text").toBe(EXPECTED_REPLY);
  expectToolStep(assistant);
  expectToolResultReachedModel(await turnCallsFor(marker), true);

  // The conversation is listed, and opening it shows the stored reply.
  await page.goto(`${WORKSPACE_PATH}/conversations`);
  const row = page.locator(`a[href*="${encodeURIComponent(conversationId)}"]`).first();
  await expect(row).toBeVisible();
  await row.click();
  await page.waitForURL((url) => url.pathname.includes(encodeURIComponent(conversationId)));
  await expect(page.getByText(userText)).toBeVisible();
  await expect(page.getByText(FINAL_TEXT)).toBeVisible();
  await expect(page.getByText(STEP_TEXT)).toBeVisible();
});

test("an API turn answers, runs the tool and is stored", async () => {
  const marker = nonce();
  const userText = `Is the turn probe skill installed? (${marker})`;
  const chatId = `e2e-${marker}`;

  const res = await fetch(`${ENGINE_URL}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${AGENT_API_KEY}` },
    body: JSON.stringify({ model: AGENT_SLUG, messages: [{ role: "user", content: userText }], chat_id: chatId }),
  });
  const bodyText = await res.text();
  expect(res.status, bodyText).toBe(200);
  const body = JSON.parse(bodyText) as { choices: { message: { content: string } }[] };
  expect(body.choices[0].message.content, "the reply the API returned").toBe(EXPECTED_REPLY);

  // Persistence runs after the answer is sent, so it is awaited, not assumed.
  const conversationId = `${AGENT_SLUG}:web:api-${chatId}`;
  await expect
    .poll(async () => (await messagesOf(conversationId).catch(() => [])).map((m) => m.role), { timeout: 15_000 })
    .toEqual(["user", "assistant"]);
  const [user, assistant] = await messagesOf(conversationId);
  expect(user.content).toBe(userText);
  expect(assistant.content, "the stored reply equals the returned one").toBe(EXPECTED_REPLY);
  expectToolStep(assistant);
  expectToolResultReachedModel(await turnCallsFor(marker), false);

  const list = (await ok(
    await panelApi.get(`/api/conversations?instanceId=${AGENT_SLUG}`),
    "list the agent's conversations",
  )) as { conversations: { conversationId: string }[] };
  expect(list.conversations.map((c) => c.conversationId)).toContain(conversationId);
});
