// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * A new account's first sign-in: a Platform Admin adds a user in Settings and
 * hands over the password the panel generates; that person signs in, is held
 * on the password change page until they choose their own, and from then on
 * signs in with the new password only.
 *
 * What it catches:
 * - a generated password that does not sign in, or an account created without
 *   the obligation to change it;
 * - a forced change that lets the person reach the panel before rotating, or
 *   that a reload escapes;
 * - a forced change the person clears for themselves: the panel taking
 *   `mustChangePassword: false` from a session update the browser sends, or
 *   the engine answering the session cookie before the password is changed;
 * - an engine that keeps refusing the person after the change went through;
 * - a change that answers success but is not stored: the old password still
 *   signs in, the new one does not, or the next sign-in asks again;
 * - the admin's list still saying the change is required after it was made.
 *
 * Each sign-in runs in a fresh browser context, so what it shows comes from
 * the stored account, not from a session the earlier step left behind. The
 * user is created for this spec and deleted after it.
 */

import {
  request as playwrightRequest,
  test,
  expect,
  type APIRequestContext,
  type Browser,
  type Page,
} from "@playwright/test";
import { WEB_URL } from "../setup/test-env";
import { PANEL_STATE } from "../support/panel";

const EMAIL = "first-login@e2e.polyant.test";
const NAME = "First Login Person";
const NEW_PASSWORD = "chosen-by-the-person-1";

let adminApi: APIRequestContext;

async function deleteUserIfPresent(): Promise<void> {
  const res = await adminApi.get("/api/users?limit=200");
  expect(res.ok(), `list the users: ${res.status()}`).toBe(true);
  const { users } = (await res.json()) as { users: { id: string; email: string }[] };
  const found = users.find((u) => u.email === EMAIL);
  if (!found) return;
  const removed = await adminApi.delete(`/api/users/${found.id}`);
  expect(removed.ok(), `delete ${EMAIL}: ${removed.status()}`).toBe(true);
}

test.beforeAll(async () => {
  adminApi = await playwrightRequest.newContext({ baseURL: WEB_URL, storageState: PANEL_STATE });
  await deleteUserIfPresent();
});

test.afterAll(async () => {
  if (!adminApi) return;
  await deleteUserIfPresent();
  await adminApi.dispose();
});

/** Fill and send the sign-in form once React has hydrated it. */
async function submitLogin(page: Page, email: string, password: string): Promise<void> {
  await page.goto("/login");
  await page.waitForFunction(() => {
    const form = document.querySelector("#email")?.closest("form");
    return !!form && Object.keys(form).some((key) => key.startsWith("__reactProps$"));
  });
  await page.locator("#email").fill(email);
  await page.locator("#password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
}

/**
 * Ask Auth.js to update the session with `mustChangePassword: false`, the
 * request `useSession().update()` sends, so the claim would come from the
 * browser if the panel trusted it.
 */
async function sendSessionUpdate(page: Page): Promise<void> {
  const csrf = await page.request.get("/api/auth/csrf");
  expect(csrf.ok(), `read the csrf token: ${csrf.status()}`).toBe(true);
  const { csrfToken } = (await csrf.json()) as { csrfToken: string };
  const update = await page.request.post("/api/auth/session", {
    data: { csrfToken, data: { mustChangePassword: false } },
  });
  expect(update.ok(), `the session update is answered: ${update.status()}`).toBe(true);
}

/** An ordinary engine route the panel calls with the session cookie, through the web origin. */
const ORDINARY_ENGINE_ROUTE = "/api/me/favorite-agents";

async function inFreshContext<T>(browser: Browser, run: (page: Page) => Promise<T>): Promise<T> {
  // An empty state on purpose: a context made here inherits the project's
  // storageState, which is the signed-in panel admin.
  const context = await browser.newContext({ baseURL: WEB_URL, locale: "en-US", storageState: { cookies: [], origins: [] } });
  try {
    return await run(await context.newPage());
  } finally {
    await context.close();
  }
}

/** The password column of the user's row in Settings → Users, read on a fresh load. */
async function passwordStateInAdminList(page: Page): Promise<string> {
  await page.goto("/settings");
  const row = page.getByRole("row").filter({ hasText: EMAIL });
  await expect(row).toBeVisible();
  return (await row.innerText()).trim();
}

test("a person created with a generated password must replace it at first sign-in, and the new one is the one that works", async ({
  browser,
  page: adminPage,
}) => {
  // `page` is the signed-in Platform Admin (the project's storageState).

  // The Platform Admin adds the user without a password: the panel makes one.
  await adminPage.goto("/settings");
  await adminPage.getByRole("button", { name: "Add", exact: true }).click();
  // Found by its field, not its title: the drawer's title is worded per edition.
  const sheet = adminPage.getByRole("dialog").filter({ has: adminPage.getByLabel("Email") });
  await sheet.getByLabel("Email").fill(EMAIL);
  await sheet.getByLabel("Name (optional)").fill(NAME);
  await sheet.getByRole("button", { name: "Add", exact: true }).click();
  // The form gives way to the password, so the drawer is no longer the one with an Email field.
  const secret = adminPage.getByRole("dialog").getByTestId("one-time-secret");
  await expect(secret).toHaveText(/\S{8,}/);
  const temporaryPassword = (await secret.innerText()).trim();

  expect(await passwordStateInAdminList(adminPage), "the stored account must change its password").toContain(
    "Change required",
  );

  // First sign-in: the person is held on the change page, and a reload or
  // another address does not let them out.
  await inFreshContext(browser, async (page) => {
    await submitLogin(page, EMAIL, temporaryPassword);
    await page.waitForURL((url) => url.pathname === "/password-change");
    await expect(page.getByText("Set a new password")).toBeVisible();
    await page.reload();
    await expect(page).toHaveURL(/\/password-change$/);
    await page.goto("/settings");
    await expect(page, "another page sends the person back").toHaveURL(/\/password-change$/);

    // The browser cannot clear the obligation by updating its own session.
    await sendSessionUpdate(page);
    await page.goto("/settings");
    await expect(page, "a session update from the browser does not lift the hold").toHaveURL(/\/password-change$/);

    // Nor does the session cookie open the API meanwhile: the engine refuses
    // ordinary routes and answers only what the change page needs.
    const refused = await page.request.get(ORDINARY_ENGINE_ROUTE);
    expect(refused.status(), "the engine refuses an ordinary route before the change").toBe(403);
    expect(((await refused.json()) as { code?: string }).code).toBe("password_change_required");
    const me = await page.request.get("/api/me");
    expect(me.status(), "the change page can still read who is signed in").toBe(200);

    await page.getByLabel("New password", { exact: true }).fill(NEW_PASSWORD);
    await page.getByLabel("Confirm new password").fill(NEW_PASSWORD);
    const change = page.waitForResponse((r) => r.url().includes("/api/me/password") && r.request().method() !== "GET");
    await page.getByRole("button", { name: "Update password" }).click();
    expect((await change).ok(), "the change was accepted").toBe(true);
    await page.waitForURL((url) => url.pathname !== "/password-change");

    const allowed = await page.request.get(ORDINARY_ENGINE_ROUTE);
    expect(allowed.status(), "the same route answers as soon as the password is changed").toBe(200);
  });

  // The temporary password no longer signs in.
  await inFreshContext(browser, async (page) => {
    await submitLogin(page, EMAIL, temporaryPassword);
    await expect(page.getByText("Invalid credentials")).toBeVisible();
    await expect(page).toHaveURL(/\/login/);
  });

  // The chosen one does, straight into the panel, with no second request to change it.
  await inFreshContext(browser, async (page) => {
    await submitLogin(page, EMAIL, NEW_PASSWORD);
    await page.waitForURL((url) => !url.pathname.startsWith("/login"));
    expect(new URL(page.url()).pathname, "no second forced change").not.toBe("/password-change");
    await page.goto("/password-change");
    await expect(page, "the change page is closed once the password is changed").not.toHaveURL(/\/password-change$/);
  });

  expect(await passwordStateInAdminList(adminPage), "the admin list reads the stored change").not.toContain(
    "Change required",
  );
});
