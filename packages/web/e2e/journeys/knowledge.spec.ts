// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * A knowledge document's life in the panel, as a person drives it: switch
 * retrieval on, add a document, watch it be read to the end, switch it off and
 * on again, delete it. After every save the page is loaded again, and what the
 * test checks is what the panel reads back from the engine, never the toast.
 *
 * What it catches:
 * - a save that answers success but stores nothing (the retrieval switch, a
 *   document's switch), so the reloaded page shows the old position;
 * - a document that is accepted but never indexed: it stays "Processing" or
 *   ends in "Error" because the embedder was not reached;
 * - a document that is listed right after the upload but not stored, or that
 *   a deletion leaves behind.
 *
 * The agent embeds with `openai`, which the harness points at the fake model
 * (support/fake-model.mjs answers `/v1/embeddings`), so indexing runs through
 * the real engine to the `ready` state with no provider. The agent is created
 * through the panel's API for this spec and deleted after it.
 */

import { request as playwrightRequest, test, expect, type APIRequestContext, type Page } from "@playwright/test";
import { FAKE_MODEL_URL, PANEL_ORG_SLUG, PANEL_WORKSPACE_SLUG, WEB_URL } from "../setup/test-env";
import { PANEL_STATE } from "../support/panel";

const AGENT_SLUG = "e2e-journey-knowledge";
const AGENT_NAME = "Knowledge Journey Agent";
const KNOWLEDGE_PATH = `/organizations/${PANEL_ORG_SLUG}/workspaces/${PANEL_WORKSPACE_SLUG}/instances/${AGENT_SLUG}?tab=knowledge`;

const FILENAME = "opening-hours.md";
/** A marker in the text, to find the embedder call this document caused. */
const MARKER = `kb-${Date.now().toString(36)}`;
const CONTENT = `# Opening hours (${MARKER})\n\nThe showroom is open Monday to Friday, 9:00 to 18:00.\nOn Saturday it closes at 13:00.`;

let panelApi: APIRequestContext;

async function ok(res: Awaited<ReturnType<APIRequestContext["get"]>>, what: string): Promise<unknown> {
  expect(res.ok(), `${what}: ${res.status()} ${await res.text()}`).toBe(true);
  return res.json();
}

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
  // The embedder's key. The fake model accepts any.
  await ok(
    await panelApi.put(`/api/instances/${AGENT_SLUG}/secrets`, {
      data: { secrets: [{ key: "openai_api_key", value: "sk-e2e-fake-model" }] },
    }),
    "set the embedder key",
  );
});

test.afterAll(async () => {
  if (!panelApi) return;
  await deleteAgentIfPresent();
  await panelApi.dispose();
});

async function openKnowledge(page: Page): Promise<void> {
  await page.goto(KNOWLEDGE_PATH);
  await expect(page.getByRole("switch", { name: "Document retrieval" })).toBeVisible();
}

async function saveChanges(page: Page): Promise<void> {
  const saved = page.waitForResponse(
    (r) => r.url().includes(`/api/instances/${AGENT_SLUG}`) && ["PATCH", "PUT"].includes(r.request().method()),
  );
  await page.getByRole("button", { name: "Save changes" }).click();
  expect((await saved).ok(), "the save request succeeded").toBe(true);
  await expect(page.getByRole("button", { name: "Save changes" })).toBeDisabled();
}

/** The row of the document in the list. */
function documentRow(page: Page) {
  return page.getByRole("row").filter({ hasText: FILENAME });
}

function documentSwitch(page: Page) {
  return page.getByRole("switch", { name: `Enabled: ${FILENAME}` });
}

test("a document added in the panel is indexed, switched off and on, and deleted, each change surviving a reload", async ({ page }) => {
  // Retrieval starts off for a new agent: the list is inert until it is on.
  await openKnowledge(page);
  const retrieval = page.getByRole("switch", { name: "Document retrieval" });
  await expect(retrieval).not.toBeChecked();
  await retrieval.click();
  await saveChanges(page);
  await page.reload();
  await expect(page.getByRole("switch", { name: "Document retrieval" }), "retrieval is stored on").toBeChecked();

  // Add the document through the drawer.
  await page.getByRole("button", { name: "Add", exact: true }).click();
  const drawer = page.getByRole("dialog", { name: "Upload document" });
  await drawer.getByLabel("Filename").fill(FILENAME);
  await drawer.getByLabel("Content").fill(CONTENT);
  const upload = page.waitForResponse(
    (r) => r.url().endsWith(`/api/instances/${AGENT_SLUG}/knowledge`) && r.request().method() === "POST",
  );
  await drawer.getByRole("button", { name: "Add", exact: true }).click();
  expect((await upload).ok(), "the upload was accepted").toBe(true);

  // The list polls while the document is read; it ends ready, in one chunk.
  await expect(documentRow(page)).toContainText("Ready", { timeout: 30_000 });
  await expect(documentRow(page)).toContainText("1 chunk");

  // The embedder was reached with this document's text.
  const { calls } = (await (await fetch(`${FAKE_MODEL_URL}/__calls`)).json()) as {
    calls: { kind: string; inputs?: string[] }[];
  };
  expect(
    calls.filter((c) => c.kind === "embeddings" && c.inputs?.some((t) => t.includes(MARKER))),
    "one embeddings call carried the document",
  ).toHaveLength(1);

  // Stored: a fresh page lists it, ready, switched on, and shows its text.
  await page.reload();
  await expect(documentRow(page)).toContainText("Ready");
  await expect(documentSwitch(page)).toBeChecked();
  await page.getByRole("button", { name: FILENAME }).click();
  const viewer = page.getByRole("dialog", { name: FILENAME });
  await expect(viewer).toContainText("The showroom is open Monday to Friday");
  await viewer.getByRole("button", { name: "Close" }).first().click();

  // Off, saved, reloaded: still off.
  await documentSwitch(page).click();
  await saveChanges(page);
  await page.reload();
  await expect(documentSwitch(page), "the document is stored off").not.toBeChecked();

  // On again, saved, reloaded: on.
  await documentSwitch(page).click();
  await saveChanges(page);
  await page.reload();
  await expect(documentSwitch(page), "the document is stored on").toBeChecked();

  // Delete it from its drawer.
  await page.getByRole("button", { name: FILENAME }).click();
  await page.getByRole("dialog", { name: FILENAME }).getByRole("button", { name: "Delete" }).click();
  const removal = page.waitForResponse(
    (r) => r.url().includes(`/api/instances/${AGENT_SLUG}/knowledge/`) && r.request().method() === "DELETE",
  );
  await page.getByRole("alertdialog").getByRole("button", { name: "Delete" }).click();
  expect((await removal).ok(), "the deletion was accepted").toBe(true);

  await page.reload();
  await expect(page.getByText("No documents yet"), "the deleted document is gone after a reload").toBeVisible();
  await expect(documentRow(page)).toHaveCount(0);
});
