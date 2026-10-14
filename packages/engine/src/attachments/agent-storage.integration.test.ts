// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * An agent's bucket is a secret the operator can change. These read a stored
 * file back against a real Postgres; S3 is faked at the client's `send`.
 *
 * Self-skips when no migrated database is reachable.
 */

import { describe, it, expect, afterAll, beforeEach, vi } from "vitest";
import { Readable } from "node:stream";
import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
import { eq } from "drizzle-orm";
import { db } from "../database/client.js";
import { resolveDatabaseAvailability } from "../database/test-db.js";
import { instances } from "../instances/schema.js";
import { workspaces } from "../organizations/organization.schema.js";
import { asInstanceSlug, asInstanceUuid } from "../instances/identifiers.js";
import { setSecret } from "../instances/secrets.store.js";
import { conversationStore } from "../conversations/store.js";
import { allTenantsScope } from "../authz/scope-filter.js";
import { getAttachmentStream, invalidateAgentS3 } from "./agent-storage.js";

const DB_AVAILABLE = await resolveDatabaseAvailability();
const SLUG = asInstanceSlug("itest-att-read");
const CONV = "itest-att-read:whatsapp:+391";

let send: ReturnType<typeof vi.spyOn>;
const bucketsRead = () =>
  (send.mock.calls as unknown[][])
    .map(([cmd]) => cmd)
    .filter((cmd): cmd is GetObjectCommand => cmd instanceof GetObjectCommand)
    .map((cmd) => cmd.input.Bucket);

beforeEach(async () => {
  vi.restoreAllMocks();
  send = vi.spyOn(S3Client.prototype, "send").mockResolvedValue({ Body: Readable.from(["x"]) } as never);
  if (!DB_AVAILABLE) return;
  await db.delete(instances).where(eq(instances.slug, SLUG));
  const [ws] = await db.select({ id: workspaces.id }).from(workspaces).where(eq(workspaces.isDefault, true)).limit(1);
  const [row] = await db.insert(instances).values({ slug: SLUG, name: SLUG, workspaceId: ws!.id }).returning({ id: instances.id });
  const id = asInstanceUuid(row!.id);
  await setSecret(id, "s3_bucket_name", "current-bucket");
  await setSecret(id, "aws_region", "eu-south-1");
  await setSecret(id, "aws_access_key_id", "AKIA");
  await setSecret(id, "aws_secret_access_key", "shh");
  invalidateAgentS3(SLUG);
  await conversationStore.ensureConversation(CONV, SLUG);
  await conversationStore.appendMessages(CONV, [
    { role: "user", content: "old", attachments: [{ type: "image", s3Key: `attachments/${SLUG}/${CONV}/old.jpg`, bucket: "previous-bucket" }] },
    { role: "user", content: "legacy", attachments: [{ type: "image", s3Key: `attachments/${SLUG}/${CONV}/legacy.jpg` }] },
  ]);
});

afterAll(async () => {
  vi.restoreAllMocks();
  if (!DB_AVAILABLE) return;
  await conversationStore.deleteConversation(CONV, allTenantsScope("integration test cleanup")).catch(() => {});
  await db.delete(instances).where(eq(instances.slug, SLUG));
});

describe("getAttachmentStream (integration)", () => {
  it.skipIf(!DB_AVAILABLE)("reads a file from the bucket it was written to", async () => {
    await getAttachmentStream(SLUG, `attachments/${SLUG}/${CONV}/old.jpg`);
    expect(bucketsRead()).toEqual(["previous-bucket"]);
  });

  it.skipIf(!DB_AVAILABLE)("reads a file stored before the bucket was recorded from the agent's bucket", async () => {
    await getAttachmentStream(SLUG, `attachments/${SLUG}/${CONV}/legacy.jpg`);
    expect(bucketsRead()).toEqual(["current-bucket"]);
  });
});
