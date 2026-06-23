// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { db } from "../database/client.js";
import { instances } from "../instances/schema.js";
import { findDefaultWorkspaceId } from "../organizations/organizations.store.js";
import { contactOptouts } from "./optout.schema.js";
import { eq } from "drizzle-orm";
import { asInstanceSlug, asInstanceUuid } from "../instances/identifiers.js";
import { getOptoutStatus, setOptoutStatus, listOptouts } from "./index.js";

const SLUG = asInstanceSlug("optout-itest");
let instanceId: ReturnType<typeof asInstanceUuid>;
let workspaceId: string;

beforeAll(async () => {
  workspaceId = await findDefaultWorkspaceId();
  const [row] = await db
    .insert(instances)
    .values({ slug: SLUG, name: "Optout ITest", workspaceId })
    .returning();
  instanceId = asInstanceUuid(row.id);
});

afterAll(async () => {
  await db.delete(instances).where(eq(instances.slug, SLUG)); // cascade drops contact_optouts
});

describe("contact opt-out lifecycle (integration)", () => {
  it("defaults to opted_in when no row exists", async () => {
    expect(await getOptoutStatus(SLUG, "whatsapp", "+39999")).toBe("opted_in");
  });

  it("persists opt-out and reflects it (after cache TTL/invalidate) and re-opt-in", async () => {
    await setOptoutStatus({ instanceId, instanceSlug: SLUG, channelType: "whatsapp", channelId: "+39999", status: "opted_out", source: "user" });
    expect(await getOptoutStatus(SLUG, "whatsapp", "+39999")).toBe("opted_out");
    const list = await listOptouts(instanceId, { status: "opted_out" });
    expect(list.some((r) => r.channelId === "+39999")).toBe(true);

    await setOptoutStatus({ instanceId, instanceSlug: SLUG, channelType: "whatsapp", channelId: "+39999", status: "opted_in", source: "admin" });
    expect(await getOptoutStatus(SLUG, "whatsapp", "+39999")).toBe("opted_in");
  });

  it("cascade: deleting the instance removes its opt-out rows", async () => {
    await setOptoutStatus({ instanceId, instanceSlug: SLUG, channelType: "telegram", channelId: "123", status: "opted_out", source: "user" });
    await db.delete(instances).where(eq(instances.slug, SLUG));
    const remaining = await db.select().from(contactOptouts).where(eq(contactOptouts.instanceId, instanceId));
    expect(remaining).toHaveLength(0);
    // Re-create for afterAll idempotency
    const [row] = await db
      .insert(instances)
      .values({ slug: SLUG, name: "Optout ITest", workspaceId })
      .returning();
    instanceId = asInstanceUuid(row.id);
  });
});
