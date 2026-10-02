// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Deleting a conversation or an agent removed the rows and left the files the
 * user had sent in the agent's bucket, with nothing left in the database to
 * find them by. These run the cleanup against a real Postgres; S3 is the only
 * thing faked, at the client's `send`.
 *
 * Self-skips when no migrated database is reachable.
 */

import { describe, it, expect, afterAll, beforeEach, vi } from "vitest";
import { S3Client, DeleteObjectsCommand } from "@aws-sdk/client-s3";
import { eq } from "drizzle-orm";
import { db } from "../database/client.js";
import { resolveDatabaseAvailability } from "../database/test-db.js";
import { instances } from "../instances/schema.js";
import { workspaces } from "../organizations/organization.schema.js";
import { asInstanceSlug, asInstanceUuid } from "../instances/identifiers.js";
import { setSecret } from "../instances/secrets.store.js";
import { deleteInstance } from "../instances/store.js";
import { conversationStore } from "../conversations/store.js";
import { allTenantsScope } from "../authz/scope-filter.js";
import { prepareAttachmentCleanup } from "./attachment-cleanup.js";

const DB_AVAILABLE = await resolveDatabaseAvailability();
const SLUG = asInstanceSlug("itest-att-cleanup");
const BARE = asInstanceSlug("itest-att-cleanup-bare");
const C1 = "itest-att-cleanup:whatsapp:+391";
const C2 = "itest-att-cleanup:whatsapp:+392";

const att = (s3Key: string) => ({ type: "image" as const, s3Key });

async function createAgent(slug: string, withStorage: boolean) {
  await db.delete(instances).where(eq(instances.slug, slug));
  const [ws] = await db.select({ id: workspaces.id }).from(workspaces).where(eq(workspaces.isDefault, true)).limit(1);
  const [row] = await db
    .insert(instances)
    .values({ slug, name: slug, workspaceId: ws!.id })
    .returning({ id: instances.id });
  if (withStorage) {
    const id = asInstanceUuid(row!.id);
    await setSecret(id, "s3_bucket_name", "itest-bucket");
    await setSecret(id, "aws_region", "eu-south-1");
    await setSecret(id, "aws_access_key_id", "AKIA");
    await setSecret(id, "aws_secret_access_key", "shh");
  }
}

let send: ReturnType<typeof vi.spyOn>;
const deletedKeys = () =>
  (send.mock.calls as unknown[][])
    .map(([cmd]) => cmd)
    .filter((cmd): cmd is DeleteObjectsCommand => cmd instanceof DeleteObjectsCommand)
    .flatMap((cmd) => (cmd.input.Delete?.Objects ?? []).map((o) => o.Key))
    .sort();

beforeEach(async () => {
  vi.restoreAllMocks();
  send = vi.spyOn(S3Client.prototype, "send").mockResolvedValue({} as never);
  if (!DB_AVAILABLE) return;
  await createAgent(SLUG, true);
  await conversationStore.ensureConversation(C1, SLUG);
  await conversationStore.ensureConversation(C2, SLUG);
  await conversationStore.appendMessages(C1, [
    // A key under another agent's prefix is never this agent's to delete.
    { role: "user", content: "foto", attachments: [att(`attachments/${SLUG}/${C1}/a.jpg`), att("attachments/someone-else/x/y.jpg")] },
    { role: "assistant", content: "ok" },
    // A renamed conversation keeps the key it was stored under.
    { role: "user", content: "pdf", attachments: [att(`attachments/${SLUG}/before-rename/b.pdf`)] },
  ]);
  await conversationStore.appendMessages(C2, [
    { role: "user", content: "altro", attachments: [att(`attachments/${SLUG}/${C2}/c.png`)] },
  ]);
});

afterAll(async () => {
  vi.restoreAllMocks();
  if (!DB_AVAILABLE) return;
  for (const c of [C1, C2]) await conversationStore.deleteConversation(c, allTenantsScope("integration test cleanup")).catch(() => {});
  await db.delete(instances).where(eq(instances.slug, SLUG));
  await db.delete(instances).where(eq(instances.slug, BARE));
});

describe("prepareAttachmentCleanup (integration)", () => {
  it.skipIf(!DB_AVAILABLE)("deletes the stored files of one conversation, after its rows are gone", async () => {
    const cleanup = await prepareAttachmentCleanup(SLUG, { conversationIds: [C1] });
    await conversationStore.deleteConversation(C1, allTenantsScope("integration test"));

    await cleanup();

    expect(deletedKeys()).toEqual([`attachments/${SLUG}/${C1}/a.jpg`, `attachments/${SLUG}/before-rename/b.pdf`].sort());
    const [cmd] = (send.mock.calls as unknown[][])[0]!;
    expect((cmd as DeleteObjectsCommand).input.Bucket).toBe("itest-bucket");
  });

  it.skipIf(!DB_AVAILABLE)("deletes every stored file of an agent even though its secrets cascade with it", async () => {
    const cleanup = await prepareAttachmentCleanup(SLUG, { allConversations: true });
    await deleteInstance(SLUG);

    await cleanup();

    expect(deletedKeys()).toEqual([
      `attachments/${SLUG}/${C1}/a.jpg`,
      `attachments/${SLUG}/${C2}/c.png`,
      `attachments/${SLUG}/before-rename/b.pdf`,
    ].sort());
  });

  it.skipIf(!DB_AVAILABLE)("never throws when the bucket refuses, so the database delete is never held up", async () => {
    send.mockRejectedValue(Object.assign(new Error("denied"), { name: "AccessDenied" }));
    const cleanup = await prepareAttachmentCleanup(SLUG, { conversationIds: [C1, C2] });

    await expect(cleanup()).resolves.toBeUndefined();
    expect(send).toHaveBeenCalledOnce();
  });

  it.skipIf(!DB_AVAILABLE)("does nothing for an agent with no bucket configured", async () => {
    await createAgent(BARE, false);

    const cleanup = await prepareAttachmentCleanup(BARE, { allConversations: true });
    await cleanup();

    expect(send).not.toHaveBeenCalled();
  });
});
