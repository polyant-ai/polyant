// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * One real turn that comes in through a channel: Twilio posts a signed
 * WhatsApp message to the engine's webhook, the engine runs the turn against
 * the fake model (support/fake-model.mjs), the agent calls a tool, and the
 * reply goes back out through Twilio's REST API, which the engine reaches at
 * the fake Twilio (support/fake-twilio.mjs, via TWILIO_API_BASE_URL).
 *
 * What it catches:
 * - the reply WhatsApp sends differs from the reply stored for the turn, in
 *   particular when the text of the step that called the tool is stored but
 *   never sent (it once reached WhatsApp truncated to the last step);
 * - an inbound message that is not run, not answered, answered twice, or
 *   answered with no tool call;
 * - a WhatsApp conversation that is not stored or not listed as WhatsApp;
 * - a second message from the same contact that starts from nothing: the
 *   model must see the earlier exchange, reply included, as history;
 * - a forged message: a post whose signature does not match is refused and
 *   runs nothing.
 *
 * The agent is created through the panel's own API for this spec and deleted
 * after it, conversations included. It keeps every step's text as the reply
 * (`intermediateText: "reply"`), the policy under which the sent and the
 * stored reply must be the same text.
 */

import { createHmac } from "node:crypto";
import { request as playwrightRequest, test, expect, type APIRequestContext } from "@playwright/test";
import { ENGINE_URL, FAKE_MODEL_URL, FAKE_TWILIO_URL, PANEL_WORKSPACE_SLUG, WEB_URL } from "../setup/test-env";
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

const AGENT_SLUG = "e2e-turn-whatsapp";
const AGENT_NAME = "WhatsApp Channel Agent";

/* The agent's Twilio account. Test values: they only ever reach the fake Twilio. */
const ACCOUNT_SID = "AC0e2e0000000000000000000000000001";
const AUTH_TOKEN = "e2e-twilio-auth-token-0123456789";
const AGENT_NUMBER = "+15550001001";
/** The contact writing to the agent. */
const CONTACT_NUMBER = "+393330001002";
const CONTACT_NAME = "Ada Probe";

const WEBHOOK_URL = `${ENGINE_URL}/webhooks/twilio/${AGENT_SLUG}/whatsapp`;
const CONVERSATION_ID = `${AGENT_SLUG}:whatsapp:${CONTACT_NUMBER}`;

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
  userTexts?: string[];
  assistantTexts?: string[];
  functionCallOutputs?: { callId: string; output: unknown }[];
}

interface TwilioRequest {
  kind: "message" | "typing" | "unsupported";
  accountSid?: string;
  auth?: string;
  to?: string;
  from?: string;
  body?: string;
  path?: string;
}

/** The panel's API, as the signed-in panel user, addressing the workspace. */
let panelApi: APIRequestContext;

async function ok(res: Awaited<ReturnType<APIRequestContext["get"]>>, what: string): Promise<unknown> {
  expect(res.ok(), `${what}: ${res.status()} ${await res.text()}`).toBe(true);
  return res.json();
}

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
      data: { secrets: [{ key: "openai_api_key", value: "sk-e2e-fake-model" }] },
    }),
    "set the provider key",
  );
  const tools = (await ok(
    await panelApi.patch(`/api/instances/${AGENT_SLUG}/tools`, { data: { enabled: [TOOL_NAME] } }),
    "enable the tool",
  )) as { tools: { name: string; enabled: boolean }[] };
  expect(tools.tools.filter((t) => t.enabled).map((t) => t.name)).toEqual([TOOL_NAME]);
  const channel = (await ok(
    await panelApi.put(`/api/instances/${AGENT_SLUG}/channels/whatsapp`, {
      data: {
        config: { authMode: "authToken", accountSid: ACCOUNT_SID, authToken: AUTH_TOKEN, whatsappNumber: AGENT_NUMBER },
        enabled: true,
      },
    }),
    "switch the WhatsApp channel on",
  )) as { channel: { enabled: boolean } };
  expect(channel.channel.enabled).toBe(true);
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

/**
 * Twilio's request signature, as Twilio documents it: HMAC-SHA1 keyed with the
 * account's Auth Token over the full URL followed by every POST parameter,
 * name then value, sorted by name; base64.
 */
function twilioSignature(url: string, params: Record<string, string>): string {
  const data = url + Object.keys(params).sort().map((k) => k + params[k]).join("");
  return createHmac("sha1", AUTH_TOKEN).update(data, "utf8").digest("base64");
}

/** The form Twilio posts for an inbound WhatsApp text message. */
function inboundForm(messageSid: string, text: string): Record<string, string> {
  return {
    SmsMessageSid: messageSid,
    NumMedia: "0",
    ProfileName: CONTACT_NAME,
    MessageType: "text",
    SmsSid: messageSid,
    WaId: CONTACT_NUMBER.slice(1),
    SmsStatus: "received",
    Body: text,
    To: `whatsapp:${AGENT_NUMBER}`,
    NumSegments: "1",
    ReferralNumMedia: "0",
    MessageSid: messageSid,
    AccountSid: ACCOUNT_SID,
    From: `whatsapp:${CONTACT_NUMBER}`,
    ApiVersion: "2010-04-01",
  };
}

function messageSid(): string {
  return `SM${Array.from({ length: 32 }, () => Math.floor(Math.random() * 16).toString(16)).join("")}`;
}

async function postInbound(form: Record<string, string>, signature: string): Promise<Response> {
  return fetch(WEBHOOK_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", "X-Twilio-Signature": signature },
    body: new URLSearchParams(form).toString(),
  });
}

/** The WhatsApp messages the engine sent this agent's contact, oldest first. */
async function sentToContact(): Promise<TwilioRequest[]> {
  const res = await fetch(`${FAKE_TWILIO_URL}/__requests`);
  const { requests } = (await res.json()) as { requests: TwilioRequest[] };
  return requests.filter(
    (r) => r.kind === "message" && r.accountSid === ACCOUNT_SID && r.to === `whatsapp:${CONTACT_NUMBER}`,
  );
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
 * The model calls of the turn that answered the message carrying `marker`.
 * The title and summary calls that follow a turn quote the message too; they
 * are not steps. Called before any later message is sent, so a later turn
 * quoting this one as history is not among them.
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
function expectToolResultReachedModel(calls: FakeModelCall[]): void {
  expect(calls.map((c) => c.kind), "a first step, then the step after the tool").toEqual(["first", "final"]);
  const outputs = calls[1].functionCallOutputs ?? [];
  expect(outputs).toHaveLength(1);
  const output = outputs[0].output;
  expect(typeof output === "string" ? JSON.parse(output) : output).toEqual(TOOL_RESULT);
}

/**
 * Post one signed inbound message and wait until the turn it starts is both
 * sent and stored (persistence runs after the reply goes out). Returns the
 * WhatsApp message that went out for it.
 */
async function converse(text: string, storedRoles: string[]): Promise<TwilioRequest> {
  const before = (await sentToContact()).length;
  const form = inboundForm(messageSid(), text);
  const res = await postInbound(form, twilioSignature(WEBHOOK_URL, form));
  expect(res.status, "Twilio's post is accepted").toBe(200);
  expect(await res.text()).toBe("<Response/>");

  await expect.poll(async () => (await sentToContact()).length, { timeout: 30_000 }).toBeGreaterThan(before);
  await expect
    .poll(async () => (await messagesOf(CONVERSATION_ID).catch(() => [])).map((m) => m.role), { timeout: 15_000 })
    .toEqual(storedRoles);
  const sent = (await sentToContact()).slice(before);
  expect(sent, "one WhatsApp message per reply").toHaveLength(1);
  return sent[0];
}

test("a WhatsApp turn sends, stores and lists the same reply, and the next message carries the history", async () => {
  // A post whose signature does not match is refused, runs nothing and sends nothing.
  const forgedMarker = nonce();
  const forged = inboundForm(messageSid(), `Is the turn probe skill installed? (${forgedMarker})`);
  const forgedRes = await postInbound(forged, twilioSignature(WEBHOOK_URL, { ...forged, Body: "something else" }));
  expect(forgedRes.status, "a forged post is refused").toBe(403);

  const marker = nonce();
  const userText = `Is the turn probe skill installed? (${marker})`;
  const sent = await converse(userText, ["user", "assistant"]);

  // What WhatsApp received: both steps' text, from the agent's number, on the agent's account.
  expect(sent.from).toBe(`whatsapp:${AGENT_NUMBER}`);
  expect(sent.auth, "sent with the channel's own Twilio account").toBe(ACCOUNT_SID);
  expect(sent.body, "the reply holds both steps' text").toBe(EXPECTED_REPLY);

  // What was stored for the turn: the same reply, and the tool's call and result.
  const [user, assistant] = await messagesOf(CONVERSATION_ID);
  expect(user.content).toBe(userText);
  expect(assistant.content, "the stored reply equals the sent one").toBe(sent.body);
  expectToolStep(assistant);
  expectToolResultReachedModel(await turnCallsFor(marker));
  expect(await turnCallsFor(forgedMarker), "the forged post ran no turn").toEqual([]);

  // The conversation is listed as the agent's one WhatsApp conversation, under the contact's name.
  const list = (await ok(
    await panelApi.get(`/api/conversations?instanceId=${AGENT_SLUG}`),
    "list the agent's conversations",
  )) as { conversations: { conversationId: string; channel: string; userIdentifier: string | null }[] };
  expect(
    list.conversations.map((c) => ({ conversationId: c.conversationId, channel: c.channel, userIdentifier: c.userIdentifier })),
  ).toEqual([{ conversationId: CONVERSATION_ID, channel: "whatsapp", userIdentifier: CONTACT_NAME }]);

  // A second message from the same contact continues the conversation: the
  // model sees the first exchange, the reply exactly as sent, before the new message.
  const nextMarker = nonce();
  const nextText = `And is it installed now? (${nextMarker})`;
  const nextSent = await converse(nextText, ["user", "assistant", "user", "assistant"]);
  expect(nextSent.body).toBe(EXPECTED_REPLY);

  const nextCalls = await turnCallsFor(nextMarker);
  expectToolResultReachedModel(nextCalls);
  const [nextFirst] = nextCalls;
  const history = nextFirst.userTexts ?? [];
  expect(history, "the earlier message is in the history").toContain(userText);
  expect(history.indexOf(userText), "the earlier message comes before the new one").toBeLessThan(history.indexOf(nextText));
  expect(nextFirst.assistantTexts, "the earlier reply is in the history, as sent").toContain(sent.body);

  const stored = await messagesOf(CONVERSATION_ID);
  expect(stored[2].content).toBe(nextText);
  expect(stored[3].content).toBe(nextSent.body);
  expectToolStep(stored[3]);
});
