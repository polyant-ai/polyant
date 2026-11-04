// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * How many SQL statements a chat turn, the agent list and the dashboard send,
 * against a real database. A change that multiplies them (a read per agent, a re-read per
 * step) keeps every behaviour test green and only shows up as load in
 * production, so these budgets fail first. They count what the database
 * client sends, so a query added anywhere on the path counts.
 *
 * When a budget fails, look at the statements it prints. If the new ones are
 * needed, raise the number in the same change and say why; if they repeat a
 * read, remove them instead.
 *
 * Only the model is replaced (a canned reply from the provider SDK); the
 * configuration, the context, the tools, the persistence and the logs are
 * real. Self-skips without a database; CI_REQUIRE_DB makes an absent one a
 * failure there.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("@ai-sdk/openai", async () => {
  const { MockLanguageModelV4 } = await import("ai/test");
  const model = () =>
    new MockLanguageModelV4({
      doGenerate: async () => ({
        content: [{ type: "text", text: "Fine, thanks." }],
        finishReason: { unified: "stop", raw: "stop" },
        usage: {
          inputTokens: { total: 20, noCache: 20, cacheRead: 0, cacheWrite: 0 },
          outputTokens: { total: 4, text: 4, reasoning: 0 },
        },
        warnings: [],
      }),
    });
  const factory = Object.assign(() => model(), { responses: () => model(), chat: () => model() });
  return { createOpenAI: () => factory };
});
// The title of a new conversation is a second model call made after the turn.
vi.mock("./utils/title-generator.js", () => ({ generateConversationTitle: async () => undefined }));

import { analyticsClient, queryClient } from "./database/client.js";
import { orgScope } from "./authz/scope-filter.js";
import { getAnalytics } from "./analytics/analytics.store.js";
import { getLatencyAnalytics } from "./analytics/latency.store.js";
import { resolveDatabaseAvailability } from "./database/test-db.js";
import { asInstanceSlug } from "./instances/identifiers.js";
import { createInstanceWithDefaults, listAllInstances } from "./instances/store.js";
import { setSecret } from "./instances/secrets.store.js";
import { runOptoutGate } from "./optout/optout-gate.js";
import { runPipelinePost, runPipelinePre } from "./pipeline.js";
import { supervise } from "./agents/supervisor/index.js";
import type { IncomingMessage } from "./channels/types.js";

const DB_AVAILABLE = await resolveDatabaseAvailability();
const MARKER = "itest-query-budget";
const AGENT = asInstanceSlug(`${MARKER}-agent`);

/**
 * Run `work` and return the statements both database pools sent meanwhile.
 * Writes that a buffered queue batches across turns (AI call logs) are not
 * part of a turn and are not counted.
 */
async function statementsDuring(work: () => Promise<unknown>): Promise<string[]> {
  const sent: string[] = [];
  const pools = [queryClient, analyticsClient].map((client) => client.options as { debug: unknown });
  const before = pools.map((options) => options.debug);
  for (const options of pools) {
    options.debug = (_connection: number, statement: string) => sent.push(statement.replace(/\s+/g, " ").trim());
  }
  try {
    await work();
  } finally {
    pools.forEach((options, i) => (options.debug = before[i]));
  }
  return sent;
}

/** One buffered web turn as the channel handler runs it: gate, context, model, post. */
async function turn(text: string): Promise<string> {
  const msg: IncomingMessage = { channelType: "web", channelId: `${MARKER}-user`, instanceId: AGENT, text, metadata: {} };
  await runOptoutGate(msg);
  const pre = await runPipelinePre(msg);
  const { ctx } = pre;
  const result = await supervise({
    message: pre.messageText,
    conversationHistory: ctx.history,
    instanceId: ctx.instanceId,
    conversationId: ctx.conversationId,
    conversationSummary: ctx.conversationSummary,
    contextPrompt: ctx.contextPrompt,
    channelIdentity: ctx.channelIdentity,
    provider: ctx.instanceConfig.provider,
    model: ctx.instanceConfig.model,
    apiKeys: ctx.instanceConfig.apiKeys,
    secrets: ctx.instanceConfig.secrets,
    memoryEnabled: ctx.instanceConfig.memoryEnabled,
    knowledgeEnabled: ctx.instanceConfig.knowledgeEnabled,
    stateBuffer: ctx.stateBuffer,
    cacheConfig: ctx.instanceConfig.cacheConfig,
    allowOAuth: true,
  });
  const { finalText } = await runPipelinePost({
    ctx,
    contextPrepMs: pre.contextPrepMs,
    messageText: pre.messageText,
    channel: "web",
    resultText: result.text,
    steps: result.steps,
    usage: { promptTokens: result.usage?.promptTokens ?? 0, completionTokens: result.usage?.completionTokens ?? 0 },
    model: result.model,
    provider: result.provider,
    durationMs: 0,
    toolBuildingMs: 0,
    isStreaming: false,
  });
  return finalText;
}

async function teardown(): Promise<void> {
  await queryClient`DELETE FROM conversation_messages WHERE conversation_id LIKE ${MARKER + "%"}`;
  await queryClient`DELETE FROM conversation_state WHERE scope_key LIKE ${MARKER + "%"}`;
  await queryClient`DELETE FROM conversations WHERE instance_id LIKE ${MARKER + "%"}`;
  await queryClient`DELETE FROM instances WHERE slug LIKE ${MARKER + "%"}`;
  await queryClient`DELETE FROM workspaces WHERE slug LIKE ${MARKER + "%"}`;
  await queryClient`DELETE FROM organizations WHERE slug LIKE ${MARKER + "%"}`;
}

/** Print the statements when the count is off, so the failure names them. */
function expectCount(sent: string[], expected: number): void {
  expect(sent, sent.map((s, i) => `${i + 1}. ${s}`).join("\n")).toHaveLength(expected);
}

describe.skipIf(!DB_AVAILABLE)("statement budgets (integration)", () => {
  let orgId = "";

  async function addAgents(count: number, from: number): Promise<void> {
    for (let i = from; i < from + count; i++) {
      await queryClient`
        INSERT INTO instances (slug, name, workspace_id)
        VALUES (${`${MARKER}-list-${i}`}, ${`list ${i}`}, (SELECT id FROM workspaces WHERE slug = ${MARKER}))`;
    }
  }

  beforeAll(async () => {
    await teardown();
    [{ id: orgId }] = await queryClient<{ id: string }[]>`
      INSERT INTO organizations (slug, name, is_default) VALUES (${MARKER}, 'budget', false) RETURNING id`;
    // The chat agent has a workspace of its own, so the listed one holds only the counted agents.
    await queryClient`
      INSERT INTO workspaces (organization_id, slug, name, is_default)
      VALUES (${orgId}, ${MARKER}, 'budget', false), (${orgId}, ${MARKER + "-chat"}, 'chat', false)`;
    const agent = await createInstanceWithDefaults({
      slug: AGENT, name: "budget", provider: "openai", model: "gpt-4o-mini", orgId, workspaceSlug: `${MARKER}-chat`,
    });
    await setSecret(agent.id, "openai_api_key", "sk-test");
  });

  afterAll(teardown);

  it("a warm chat turn sends 11 statements", async () => {
    // The first turns fill the caches and create the conversation.
    expect(await turn("hello")).toBe("Fine, thanks.");
    await turn("how are you?");

    expectCount(await statementsDuring(() => turn("and today?")), 11);
  });

  it("the agent list sends one statement, for one agent as for five", async () => {
    await addAgents(1, 0);
    const one = await statementsDuring(() => listAllInstances(orgId, MARKER));
    await addAgents(4, 1);
    const five = await statementsDuring(() => listAllInstances(orgId, MARKER));

    expect(await listAllInstances(orgId, MARKER)).toHaveLength(5);
    expectCount(one, 1);
    expect(five).toEqual(one);
  });

  it("the dashboard sends 12 statements, for one agent as for five", async () => {
    const range = { from: new Date(Date.now() - 7 * 86_400_000), to: new Date() };
    const dashboard = () => Promise.all([getAnalytics(orgScope(orgId), range, undefined, true), getLatencyAnalytics(orgScope(orgId), range)]);
    await queryClient`DELETE FROM instances WHERE slug LIKE ${MARKER + "-list-%"}`;
    await addAgents(1, 0);
    // The first read on a pool also fetches the database's array types.
    await dashboard();
    const one = await statementsDuring(dashboard);
    await addAgents(4, 1);
    const five = await statementsDuring(dashboard);

    expectCount(one, 12);
    expect(five).toHaveLength(one.length);
  });
});
