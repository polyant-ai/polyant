// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Seeds the data the panel suites (accessibility, screenshots) look at: a
 * Platform Admin who owns the default organization, and a history for the
 * showcase agent — prompt sections, conversations on three channels, one of
 * them with a tool call, two weeks of model calls for the charts, a few
 * memories and a knowledge document.
 *
 * Without it every page renders its empty state, and a check that only ever
 * sees empty states misses the tables, transcripts and charts people use.
 *
 * Every timestamp is a fixed offset before PANEL_NOW, the instant the suites
 * stop the browser clock at, so what the panel shows does not depend on the
 * day the suite runs. Idempotent: it deletes what it wrote before writing it
 * again, and touches nothing else.
 *
 * Raw SQL through postgres-js, like seed-rbac.ts: a column renamed in a
 * migration fails here, at seed time, with the column's name.
 */

import bcrypt from "bcryptjs";
import postgres from "postgres";
import {
  PANEL_AGENT_NAME,
  PANEL_AGENT_SLUG,
  PANEL_CONVERSATION_ID,
  PANEL_NOW,
  PANEL_USER,
  PANEL_WORKSPACE_SLUG,
  TEST_DATABASE_URL,
} from "./test-env.js";

/** Matches engine password.util.ts (bcrypt cost 12). */
const BCRYPT_COST = 12;

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const at = (msBeforeNow: number): Date => new Date(PANEL_NOW.getTime() - msBeforeNow);

interface SeedMessage {
  role: "user" | "assistant";
  content: string;
  minutesIn: number;
  steps?: unknown;
}

interface SeedConversation {
  id: string;
  channel: string;
  title: string;
  summary: string;
  userIdentifier: string;
  startedBefore: number;
  messages: SeedMessage[];
}

const CONVERSATIONS: SeedConversation[] = [
  {
    id: PANEL_CONVERSATION_ID,
    channel: "web",
    title: "Opening hours and booking",
    summary: "The customer asked about opening hours and booked a visit for Thursday morning.",
    userIdentifier: "e2e-panel-visitor",
    startedBefore: 2 * HOUR,
    messages: [
      { role: "user", content: "Hi, when are you open on Thursday?", minutesIn: 0 },
      {
        role: "assistant",
        content: "On Thursday we are open from 9:00 to 18:00. Would you like me to book a visit?",
        minutesIn: 1,
        steps: [
          {
            index: 0,
            stepType: "initial",
            text: "",
            toolCalls: [{ toolCallId: "call-e2e-1", toolName: "readSkill", args: { name: "opening-hours" }, durationMs: 120 }],
            toolResults: [{ toolCallId: "call-e2e-1", result: { thursday: "09:00-18:00" } }],
            finishReason: "tool-calls",
            promptTokens: 1840,
            completionTokens: 32,
            durationMs: 900,
          },
          {
            index: 1,
            stepType: "tool-result",
            text: "On Thursday we are open from 9:00 to 18:00. Would you like me to book a visit?",
            toolCalls: [],
            finishReason: "stop",
            promptTokens: 1910,
            completionTokens: 24,
            durationMs: 700,
          },
        ],
      },
      { role: "user", content: "Yes, Thursday at 10 please.", minutesIn: 3 },
      { role: "assistant", content: "Done: you are booked for Thursday at 10:00. See you then!", minutesIn: 4 },
    ],
  },
  {
    id: `${PANEL_AGENT_SLUG}:whatsapp:panel-2`,
    channel: "whatsapp",
    title: "Invoice copy",
    summary: "The customer asked for a copy of the March invoice.",
    userIdentifier: "+390000000002",
    startedBefore: 1 * DAY + 3 * HOUR,
    messages: [
      { role: "user", content: "Can you send me a copy of the March invoice?", minutesIn: 0 },
      { role: "assistant", content: "Of course. I have sent it to the email address on your account.", minutesIn: 1 },
    ],
  },
  {
    id: `${PANEL_AGENT_SLUG}:email:panel-3`,
    channel: "email",
    title: "Change of address",
    summary: "The customer reported a new delivery address.",
    userIdentifier: "customer3@e2e.polyant.test",
    startedBefore: 4 * DAY,
    messages: [
      { role: "user", content: "Please update my delivery address to Via Roma 1, Milano.", minutesIn: 0 },
      { role: "assistant", content: "Your delivery address is now Via Roma 1, Milano.", minutesIn: 2 },
    ],
  },
];

const MEMORIES = [
  { content: "Prefers appointments in the morning.", category: "preference", importance: 6 },
  { content: "Asked for invoices to be sent by email.", category: "general", importance: 5 },
  { content: "Delivery address: Via Roma 1, Milano.", category: "fact", importance: 7 },
];

const PROMPTS = [
  {
    key: "01-identity",
    title: "Identity",
    content: "# Identity\n\nYou are the front desk of a small clinic. You answer customers about opening hours, bookings and invoices.",
  },
  {
    key: "02-soul",
    title: "Soul",
    content: "# Personality\n\nFriendly and brief. Confirm every booking with its day and time.",
  },
];

// A memory must carry an embedding; nothing here searches by it.
const FLAT_EMBEDDING = `[${new Array(1536).fill("0.001").join(",")}]`;

const KNOWLEDGE_TEXT =
  "Opening hours\n\nMonday to Friday 9:00-18:00. Saturday 9:00-13:00. Closed on Sunday.\n";

export async function seedPanel(connectionUrl: string = TEST_DATABASE_URL): Promise<void> {
  const sql = postgres(connectionUrl, { max: 1, onnotice: () => {} });
  try {
    const [org] = await sql<{ id: string }[]>`SELECT id FROM organizations WHERE is_default = true LIMIT 1`;
    if (!org) throw new Error("Default organization not found — run migrations before seeding.");
    const [workspace] = await sql<{ id: string }[]>`
      SELECT id FROM workspaces WHERE organization_id = ${org.id} AND slug = ${PANEL_WORKSPACE_SLUG}
    `;
    if (!workspace) throw new Error(`Workspace "${PANEL_WORKSPACE_SLUG}" not found in the default organization.`);
    const [ownerRole] = await sql<{ id: string }[]>`
      SELECT id FROM roles WHERE key = 'owner' AND organization_id IS NULL LIMIT 1
    `;
    if (!ownerRole) throw new Error('System role "owner" not found — migration seed missing.');

    const passwordHash = await bcrypt.hash(PANEL_USER.password, BCRYPT_COST);
    const dismissed = { wizard: "dismissed", interfaceTour: "dismissed", agentTour: "dismissed", steps: {} };

    await sql.begin(async (tx) => {
      // The person: Platform Admin and organization Owner, guidance closed.
      await tx`DELETE FROM users WHERE email = ${PANEL_USER.email}`;
      const [user] = await tx<{ id: string }[]>`
        INSERT INTO users (email, name, password_hash, must_change_password, is_platform_admin, onboarding)
        VALUES (${PANEL_USER.email}, ${PANEL_USER.name}, ${passwordHash}, false, true, ${tx.json(dismissed)})
        RETURNING id
      `;
      await tx`
        INSERT INTO organization_memberships (organization_id, user_id)
        VALUES (${org.id}, ${user.id})
        ON CONFLICT DO NOTHING
      `;
      await tx`
        INSERT INTO role_bindings (user_id, role_id, scope_type, scope_id, organization_id)
        VALUES (${user.id}, ${ownerRole.id}, 'organization', ${org.id}, ${org.id})
      `;

      // The agent, with memory and knowledge on so their sections show what
      // the seed writes, and two prompt sections of its own.
      const [agent] = await tx<{ id: string }[]>`
        INSERT INTO instances (slug, name, description, status, workspace_id, memory_enabled, knowledge_enabled, created_at, updated_at)
        VALUES (${PANEL_AGENT_SLUG}, ${PANEL_AGENT_NAME}, 'Answers customers about opening hours, bookings and invoices.',
                'active', ${workspace.id}, true, true, ${at(30 * DAY)}, ${at(DAY)})
        ON CONFLICT (slug) DO UPDATE SET workspace_id = EXCLUDED.workspace_id, name = EXCLUDED.name
        RETURNING id
      `;
      await tx`DELETE FROM instance_prompts WHERE instance_id = ${agent.id}`;
      for (const p of PROMPTS) {
        await tx`
          INSERT INTO instance_prompts (instance_id, section_key, title, content)
          VALUES (${agent.id}, ${p.key}, ${p.title}, ${p.content})
        `;
      }

      // History: remove what an earlier run wrote, then write it again.
      const conversationIds = CONVERSATIONS.map((c) => c.id);
      await tx`DELETE FROM conversation_messages WHERE conversation_id IN ${tx(conversationIds)}`;
      await tx`DELETE FROM conversations WHERE conversation_id IN ${tx(conversationIds)}`;
      await tx`DELETE FROM ai_logs WHERE instance_id = ${PANEL_AGENT_SLUG}`;
      await tx`DELETE FROM memories WHERE instance_id = ${PANEL_AGENT_SLUG}`;
      await tx`DELETE FROM knowledge_documents WHERE instance_id = ${PANEL_AGENT_SLUG}`;

      for (const c of CONVERSATIONS) {
        const startedAt = at(c.startedBefore);
        const minute = (m: number) => new Date(startedAt.getTime() + m * 60_000);
        const last = c.messages[c.messages.length - 1];
        await tx`
          INSERT INTO conversations (
            conversation_id, title, summary, instance_id, channel, source, user_identifier,
            created_at, updated_at, message_count, user_message_count, last_message_at
          ) VALUES (
            ${c.id}, ${c.title}, ${c.summary}, ${PANEL_AGENT_SLUG}, ${c.channel}, 'user', ${c.userIdentifier},
            ${startedAt}, ${minute(last.minutesIn)}, ${c.messages.length},
            ${c.messages.filter((m) => m.role === "user").length}, ${minute(last.minutesIn)}
          )
        `;
        let seq = 0;
        for (const m of c.messages) {
          seq += 1;
          await tx`
            INSERT INTO conversation_messages (conversation_id, role, content, steps, created_at, seq)
            VALUES (${c.id}, ${m.role}, ${m.content}, ${m.steps ? tx.json(m.steps as never) : null}, ${minute(m.minutesIn)}, ${seq})
          `;
        }
      }

      // Two weeks of model calls, three a day, one failed: enough for every
      // chart and total to have something to draw.
      for (let day = 13; day >= 0; day -= 1) {
        for (let call = 0; call < 3; call += 1) {
          const prompt = 1200 + day * 40 + call * 300;
          const completion = 80 + call * 25;
          const failed = day === 5 && call === 2;
          await tx`
            INSERT INTO ai_logs (
              provider, model, tier, prompt_tokens, completion_tokens, total_tokens, estimated_cost_usd,
              duration_ms, conversation_id, instance_id, call_type, step_count, outcome, created_at, started_at
            ) VALUES (
              'openai', 'gpt-5-mini', 'standard', ${prompt}, ${completion}, ${prompt + completion},
              ${Number(((prompt * 0.25 + completion * 2) / 1_000_000).toFixed(6))}, ${900 + call * 400},
              ${conversationIds[call % conversationIds.length]}, ${PANEL_AGENT_SLUG}, 'conversation', ${1 + (call % 2)},
              ${failed ? "error" : "ok"}, ${at(day * DAY + (call + 1) * 3 * HOUR)}, ${at(day * DAY + (call + 1) * 3 * HOUR)}
            )
          `;
        }
      }

      for (const [i, m] of MEMORIES.entries()) {
        await tx`
          INSERT INTO memories (
            instance_id, content, category, importance, source_conversation_id, embedding, embedding_provider,
            created_at, updated_at
          ) VALUES (
            ${PANEL_AGENT_SLUG}, ${m.content}, ${m.category}, ${m.importance}, ${PANEL_CONVERSATION_ID},
            ${FLAT_EMBEDDING}::vector, 'openai', ${at((i + 1) * DAY)}, ${at((i + 1) * DAY)}
          )
        `;
      }

      await tx`
        INSERT INTO knowledge_documents (
          instance_id, filename, mime_type, size_bytes, raw_content, content_hash, source, status, chunk_count,
          created_at, updated_at
        ) VALUES (
          ${PANEL_AGENT_SLUG}, 'opening-hours.txt', 'text/plain', ${Buffer.byteLength(KNOWLEDGE_TEXT)}, ${KNOWLEDGE_TEXT},
          'e2e-panel-opening-hours', 'upload', 'ready', 1, ${at(7 * DAY)}, ${at(7 * DAY)}
        )
      `;
    });

    console.log(`[seed-panel] seeded ${PANEL_USER.email} and the history of ${PANEL_AGENT_SLUG}`);
  } finally {
    await sql.end();
  }
}

// CLI entry-point: `tsx e2e/setup/seed-panel.ts`
if (import.meta.url === `file://${process.argv[1]}`) {
  seedPanel().then(
    () => process.exit(0),
    (err) => {
      console.error("[seed-panel] failed:", err);
      process.exit(1);
    },
  );
}
