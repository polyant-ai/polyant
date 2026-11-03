// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Deleting an agent removes its whole history — more conversations than one
 * batch holds, their messages, its memories and its documents with their
 * chunks — and nothing of another agent.
 *
 * Self-skips when no migrated database is reachable.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resolveDatabaseAvailability } from "../database/test-db.js";
import { queryClient } from "../database/client.js";
import { asInstanceSlug } from "./identifiers.js";
import { deleteInstance } from "./store.js";

const DB_AVAILABLE = await resolveDatabaseAvailability();
const MARKER = `itest-delinst-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const GONE = `${MARKER}-gone`;
const KEPT = `${MARKER}-kept`;
const ZERO_1024 = `[${Array.from({ length: 1024 }, () => 0.01).join(",")}]`;

async function seedAgent(slug: string, workspaceId: string, conversations: number): Promise<void> {
  await queryClient`INSERT INTO instances (slug, name, workspace_id) VALUES (${slug}, ${slug}, ${workspaceId})`;
  await queryClient`
    INSERT INTO conversations (conversation_id, instance_id)
    SELECT ${slug} || ':web:' || n, ${slug} FROM generate_series(1, ${conversations}) n`;
  await queryClient`
    INSERT INTO conversation_messages (conversation_id, role, content)
    SELECT c.conversation_id, r.role, 'hello'
    FROM conversations c CROSS JOIN (VALUES ('user'), ('assistant')) r(role)
    WHERE c.instance_id = ${slug}`;
  await queryClient`
    INSERT INTO memories (instance_id, content, embedding_1024, embedding_provider)
    SELECT ${slug}, 'fact ' || n, ${ZERO_1024}::vector, 'openai' FROM generate_series(1, 12) n`;
  await queryClient`
    INSERT INTO knowledge_documents (instance_id, filename, mime_type, raw_content, status)
    SELECT ${slug}, 'doc-' || n || '.txt', 'text/plain', 'x', 'ready' FROM generate_series(1, 3) n`;
  await queryClient`
    INSERT INTO knowledge_chunks (document_id, instance_id, content, chunk_index, embedding_1024)
    SELECT d.id, ${slug}, 'chunk', g, ${ZERO_1024}::vector FROM knowledge_documents d, generate_series(0, 4) g
    WHERE d.instance_id = ${slug}`;
}

async function counts(slug: string) {
  const [row] = await queryClient<Record<string, number>[]>`
    SELECT
      (SELECT count(*)::int FROM conversations WHERE instance_id = ${slug}) AS conversations,
      (SELECT count(*)::int FROM conversation_messages WHERE conversation_id LIKE ${slug + ":%"}) AS messages,
      (SELECT count(*)::int FROM memories WHERE instance_id = ${slug}) AS memories,
      (SELECT count(*)::int FROM knowledge_documents WHERE instance_id = ${slug}) AS documents,
      (SELECT count(*)::int FROM knowledge_chunks WHERE instance_id = ${slug}) AS chunks,
      (SELECT count(*)::int FROM instances WHERE slug = ${slug}) AS agents`;
  return row;
}

async function teardown(): Promise<void> {
  for (const slug of [GONE, KEPT]) {
    await queryClient`DELETE FROM conversation_messages WHERE conversation_id LIKE ${slug + ":%"}`;
    await queryClient`DELETE FROM conversations WHERE instance_id = ${slug}`;
    await queryClient`DELETE FROM memories WHERE instance_id = ${slug}`;
    await queryClient`DELETE FROM knowledge_documents WHERE instance_id = ${slug}`;
  }
  await queryClient`DELETE FROM instances WHERE slug LIKE ${MARKER + "%"}`;
  await queryClient`DELETE FROM workspaces WHERE slug LIKE ${MARKER + "%"}`;
  await queryClient`DELETE FROM organizations WHERE slug LIKE ${MARKER + "%"}`;
}

describe.skipIf(!DB_AVAILABLE)("deleteInstance (integration)", () => {
  beforeAll(async () => {
    await teardown();
    const [{ id: orgId }] = await queryClient<{ id: string }[]>`
      INSERT INTO organizations (slug, name, is_default) VALUES (${MARKER}, ${MARKER}, false) RETURNING id`;
    const [{ id: workspaceId }] = await queryClient<{ id: string }[]>`
      INSERT INTO workspaces (organization_id, slug, name, is_default) VALUES (${orgId}, ${MARKER}, ${MARKER}, false) RETURNING id`;
    await seedAgent(GONE, workspaceId, 1_203);
    await seedAgent(KEPT, workspaceId, 4);
  }, 60_000);

  afterAll(async () => {
    await teardown();
  });

  it("removes the agent's whole history and leaves the other agent's", async () => {
    expect(await deleteInstance(asInstanceSlug(GONE))).toBe(true);

    expect(await counts(GONE)).toEqual({ conversations: 0, messages: 0, memories: 0, documents: 0, chunks: 0, agents: 0 });
    expect(await counts(KEPT)).toEqual({ conversations: 4, messages: 8, memories: 12, documents: 3, chunks: 15, agents: 1 });
  });

  it("reports an agent that is not there", async () => {
    expect(await deleteInstance(asInstanceSlug(`${MARKER}-missing`))).toBe(false);
  });
});
