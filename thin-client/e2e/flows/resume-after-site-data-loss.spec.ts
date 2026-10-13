import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

import { expectConnected, resetServer, setOffline } from "../driver.ts";

const DEV_SERVER_HTTP_URL =
  process.env["REPCOACH_DEV_SERVER_HTTP_URL"] ?? "http://127.0.0.1:4010";

/**
 * **Issue #147 — a browser that loses site data must not strand an open workout.**
 *
 * Before #147 the only record that a workout was in flight was a device-local
 * `localStorage` pointer. Clear it — "clear on close", a second device, a
 * private window — and a session the server still holds `active` fell off every
 * surface: Today showed the picker, History excludes `active`, and tapping Start
 * again minted a *second* `active` row that nothing ever finished.
 *
 * The fix makes the server the source of truth: once connected, Today asks which
 * Logged Sessions are `active` and reconciles the pointer against the answer.
 * This flow proves the two halves of that:
 *
 * 1. after the pointer is wiped and the tab reloaded, Resume comes back, and the
 *    set already logged into the session is still there;
 * 2. tapping Start on the same session again resumes it rather than starting a
 *    parallel one — "one intended workout, one active row".
 *
 * Black-box per the adversarial-author contract: visible text / roles only.
 * `window.localStorage.clear()` is not white-box knowledge of the client — it is
 * the browser event this ticket exists for (a user's site data going away),
 * reproduced deterministically.
 */

const CONFIRM_NAME = /^(Log as prescribed|Logged)$/;

async function startSeededSessionAndLogOne(page: Page): Promise<void> {
  await page.goto("/");
  await expectConnected(page);
  await page.getByRole("button", { name: /^Session 1/ }).first().click();
  await expect(page.getByRole("button", { name: "Back to Today" })).toBeVisible({ timeout: 30_000 });

  await page.getByRole("button", { name: CONFIRM_NAME }).first().click();
  await expect(page.getByText(/1 of 6 sets logged/i)).toBeVisible({ timeout: 15_000 });

  await page.getByRole("button", { name: "Back to Today" }).click();
  await expect(page.getByRole("button", { name: /Resume/ })).toBeVisible();
}

async function readActuals(request: APIRequestContext): Promise<ReadonlyArray<{ readonly setId: string }>> {
  const response = await request.get(`${DEV_SERVER_HTTP_URL}/__test__/logged-actuals`);
  const body = (await response.json()) as { readonly actuals: ReadonlyArray<{ readonly setId: string }> };
  return body.actuals;
}

test.describe("resume survives site-data loss (#147)", () => {
  test.beforeEach(async ({ request }) => {
    await resetServer(request);
  });

  test.afterEach(async ({ request, context }) => {
    await setOffline(context, false);
    await resetServer(request);
  });

  test("Resume comes back after localStorage is cleared, and the logged set is still there", async ({
    page,
    request,
  }) => {
    await startSeededSessionAndLogOne(page);
    expect(await readActuals(request)).toHaveLength(1);

    // The browser loses its site data, then the tab reloads. The pointer is
    // gone; the server still holds the session `active`.
    await page.evaluate(() => window.localStorage.clear());
    await page.reload();
    await expectConnected(page);

    // Reconciled from the server: Resume is offered again.
    await expect(page.getByRole("button", { name: /Resume/ })).toBeVisible({ timeout: 30_000 });

    // And it opens the same session — the set logged before the wipe is still
    // logged, not a fresh 0-of-6.
    await page.getByRole("button", { name: /Resume/ }).click();
    await expect(page.getByRole("button", { name: "Back to Today" })).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText(/1 of 6 sets logged/i)).toBeVisible();

    // Nothing was duplicated server-side.
    expect(await readActuals(request)).toHaveLength(1);
  });

  test("Start on the same session after the wipe resumes it rather than opening a parallel one", async ({
    page,
    request,
  }) => {
    await startSeededSessionAndLogOne(page);

    await page.evaluate(() => window.localStorage.clear());
    await page.reload();
    await expectConnected(page);

    // Ignore the reconciled Resume hero (first `/Session 1/` match, "Resume —
    // Session 1") — tap the picker row (last match), the pre-#147
    // duplicate-minting path.
    await expect(page.getByRole("button", { name: /Resume/ })).toBeVisible({ timeout: 30_000 });
    await page.getByRole("button", { name: /^Session 1/ }).last().click();
    await expect(page.getByRole("button", { name: "Back to Today" })).toBeVisible({ timeout: 30_000 });

    // Resumed, not restarted: the earlier set is still on the grid.
    await expect(page.getByText(/1 of 6 sets logged/i)).toBeVisible();
    expect(await readActuals(request)).toHaveLength(1);
  });
});
