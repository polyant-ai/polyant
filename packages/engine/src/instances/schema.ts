// SPDX-License-Identifier: AGPL-3.0-or-later

import { pgTable, uuid, varchar, text, timestamp, boolean, jsonb, integer } from "drizzle-orm/pg-core";
import { workspaces } from "../organizations/organization.schema.js";

export const instances = pgTable("instances", {
  id: uuid("id").primaryKey().defaultRandom(),
  slug: varchar("slug", { length: 100 }).notNull().unique(),
  name: varchar("name", { length: 255 }).notNull(),
  description: text("description"),
  status: varchar("status", { length: 20 }).notNull().default("active"),
  provider: varchar("provider", { length: 50 }),
  model: varchar("model", { length: 100 }),
  memoryEnabled: boolean("memory_enabled").notNull().default(true),
  knowledgeEnabled: boolean("knowledge_enabled").notNull().default(false),
  langsmithEnabled: boolean("langsmith_enabled").notNull().default(false),
  langsmithProject: varchar("langsmith_project", { length: 255 }),
  authEnabled: boolean("auth_enabled").notNull().default(false),
  thinkingEnabled: boolean("thinking_enabled").notNull().default(false),
  /**
   * When true, the current conversation state store is rendered (read-only) into
   * the supervisor system prompt so the model can see known facts. Default false
   * keeps the state purely tool-to-tool (see conversations/state.buffer.ts).
   */
  stateInPromptEnabled: boolean("state_in_prompt_enabled").notNull().default(false),
  /**
   * When true, prior-turn tool calls + results are reconstructed (truncated) into
   * the model's cross-turn history so it "remembers" what tools returned. Default
   * false keeps the history text-only (see conversations/store.ts getRecentMessages).
   */
  toolResultsInHistoryEnabled: boolean("tool_results_in_history_enabled").notNull().default(false),
  /**
   * When true, the engine persists the exact LLM request payload per assistant
   * turn (full system prompt, the messages array sent to the model, and the tool
   * definitions) into conversation_messages.debug_payload, for analysis/debug.
   * Default false — this is heavy and stores PII at rest (see pipeline afterResponse).
   */
  debugEnabled: boolean("debug_enabled").notNull().default(false),
  /**
   * GDPR opt-out: when enabled, an end user who sends one of `optoutStopKeywords`
   * is recorded as opted-out (per contact, in `contact_optouts`) and receives no
   * further messages until they send one of `optoutResumeKeywords`. Enforcement is
   * deterministic (pre-LLM gate + outbound suppression) — never the LLM.
   */
  optoutEnabled: boolean("optout_enabled").notNull().default(false),
  optoutStopKeywords: jsonb("optout_stop_keywords").$type<string[]>().notNull().default(["STOP"]),
  optoutResumeKeywords: jsonb("optout_resume_keywords").$type<string[]>().notNull().default(["START"]),
  /** Sent once when a contact opts out. NULL/empty = no confirmation message. */
  optoutClosingMessage: text("optout_closing_message"),
  /** Sent once when a contact resumes. NULL/empty = no confirmation message. */
  optoutResumeMessage: text("optout_resume_message"),
  /** When true, an informational opt-out hint is injected into the supervisor prompt. */
  optoutInjectPromptHint: boolean("optout_inject_prompt_hint").notNull().default(true),
  icon: text("icon"),
  sttProvider: text("stt_provider").notNull().default("openai"),
  embeddingDim: integer("embedding_dim").notNull().default(1536),
  /**
   * Embedding provider, chosen INDEPENDENTLY of the chat `provider`. Allowed
   * values: "openai" | "bedrock" (Anthropic has no embeddings API). Backfilled
   * from the chat provider by migration 0052 so existing instances keep their
   * embedding space. Changing it abandons the old vectors and wipes memories +
   * knowledge (vectors are provider-specific) — see embedding-reset.service.ts.
   */
  embeddingProvider: varchar("embedding_provider", { length: 20 }).notNull().default("openai"),
  /**
   * Owning workspace (RBAC tenancy). Backfilled to the default workspace by
   * migration 0051 and set NOT NULL there. Every agent belongs to exactly one
   * workspace; ON DELETE RESTRICT keeps a workspace undeletable while it holds
   * agents. The `instance -> agent` table rename is deferred to a later stream.
   */
  workspaceId: uuid("workspace_id")
    .notNull()
    .references(() => workspaces.id, { onDelete: "restrict" }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
});
