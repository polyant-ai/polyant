// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { db } from "../database/client.js";
import { agents } from "../instances/schema.js";
import { findDefaultWorkspaceId } from "../organizations/organizations.store.js";
import { contactOptouts } from "./optout.schema.js";
import { eq } from "drizzle-orm";
import { asAgentSlug, asAgentUuid } from "../instances/identifiers.js";
import { getOptoutStatus, setOptoutStatus, listOptouts } from "./index.js";

const SLUG = asAgentSlug("optout-itest");
let agentId: ReturnType<typeof asAgentUuid>;
let workspaceId: string;

beforeAll(async () => {
  workspaceId = await findDefaultWorkspaceId();
  const [row] = await db
    .insert(agents)
    .values({ slug: SLUG, name: "Optout ITest", workspaceId })
    .returning();
  agentId = asAgentUuid(row.id);
});

afterAll(async () => {
  await db.delete(agents).where(eq(agents.slug, SLUG)); // cascade drops contact_optouts
});

describe("contact opt-out lifecycle (integration)", () => {
  it("defaults to opted_in when no row exists", async () => {
    expect(await getOptoutStatus(SLUG, "whatsapp", "+39999")).toBe("opted_in");
  });

  it("persists opt-out and reflects it (after cache TTL/invalidate) and re-opt-in", async () => {
    await setOptoutStatus({ agentId, instanceSlug: SLUG, channelType: "whatsapp", channelId: "+39999", status: "opted_out", source: "user" });
    expect(await getOptoutStatus(SLUG, "whatsapp", "+39999")).toBe("opted_out");
    const list = await listOptouts(agentId, { status: "opted_out" });
    expect(list.some((r) => r.channelId === "+39999")).toBe(true);

    await setOptoutStatus({ agentId, instanceSlug: SLUG, channelType: "whatsapp", channelId: "+39999", status: "opted_in", source: "admin" });
    expect(await getOptoutStatus(SLUG, "whatsapp", "+39999")).toBe("opted_in");
  });

  it("cascade: deleting the instance removes its opt-out rows", async () => {
    await setOptoutStatus({ agentId, instanceSlug: SLUG, channelType: "telegram", channelId: "123", status: "opted_out", source: "user" });
    await db.delete(agents).where(eq(agents.slug, SLUG));
    const remaining = await db.select().from(contactOptouts).where(eq(contactOptouts.agentId, agentId));
    expect(remaining).toHaveLength(0);
    // Re-create for afterAll idempotency
    const [row] = await db
      .insert(agents)
      .values({ slug: SLUG, name: "Optout ITest", workspaceId })
      .returning();
    agentId = asAgentUuid(row.id);
  });
});
