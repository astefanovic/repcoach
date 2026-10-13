import { expect, test } from "@playwright/test";

import { expectConnected, resetServer } from "../driver.ts";


/**
 * The Settings destination (#81) — the last of the four top-level surfaces
 * #42 settled with a real build behind it. Black-box, per the adversarial-
 * author contract: every assertion is on visible text or an ARIA role.
 *
 * ## What this file proves
 *
 * - **Settings is a real destination, not a placeholder.** The route used to
 *   render nothing but the word "Settings"; this asserts the actual sections
 *   the ticket names — model per cadence, RPE capture, spend — are on screen.
 * - **A model choice applies immediately and survives a reload.** #81's whole
 *   pitch is "no save button" — changing the Session review model, then
 *   reloading, must show the change persisted through the server rather than
 *   living only in component state.
 * - **The RPE capture control is three states, not a toggle.** Off / flagged
 *   sets only / every set are all present and mutually exclusive (a radio
 *   group), and the default reads flagged-only (#63's shipped default).
 * - **Revision run is shown as non-configurable, with the reason on screen**
 *   (ADR 0013 §6) — no selector for it, but a line explaining why.
 */

test.describe("Settings (#81)", () => {
  /**
   * Reset on BOTH sides, the same belt-and-braces `g1-offline-outbox.spec.ts`
   * uses — and this file needed it most, because it is the only one that
   * *writes* settings and it had neither hook.
   *
   * Every case below asserts a **default** (flagged-only RPE, the unchanged
   * Session review model), and two of them then change it. A default is only
   * assertable from a known-clean server, so the `beforeEach` is what makes
   * these tests mean anything; the `afterEach` is what stops the changes
   * reaching whatever runs next.
   *
   * This replaces a hand-rolled restore on the last line of the RPE case,
   * which could not work: it awaited the radio's DOM click, not the RPC that
   * persists the choice, and the test ended — closing the page — immediately
   * after. Whether the write ever reached the server was a race, and if the
   * case failed earlier it never ran at all.
   */
  test.beforeEach(async ({ request }) => {
    await resetServer(request);
  });

  test.afterEach(async ({ request }) => {
    await resetServer(request);
  });

  test("renders the model-per-cadence, RPE capture, and spend sections", async ({ page }) => {
    await page.goto("/settings");
    await expectConnected(page);

    await expect(page.getByRole("heading", { name: "Settings", exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Model per cadence" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "RPE capture" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Spend" })).toBeVisible();

    // Four configurable cadences, per ADR 0011 §4's "every cadence that
    // resolves a model gets a selector".
    await expect(page.getByText("Session review", { exact: true })).toBeVisible();
    await expect(page.getByText("Cycle review", { exact: true })).toBeVisible();
    await expect(page.getByLabel("Session review")).toBeVisible();

    // Revision run: named, but with no selector — ADR 0013 §6's reason on screen.
    await expect(page.getByText("Revision run", { exact: true })).toBeVisible();
    await expect(page.getByText(/reads the Session review model/i)).toBeVisible();
  });

  test("a model choice applies immediately with no save button, and survives a reload", async ({ page }) => {
    await page.goto("/settings");
    await expectConnected(page);

    const sessionReviewModel = page.getByLabel("Session review");
    await sessionReviewModel.selectOption("opus");

    // Reload — the change must have gone through the server, not stayed in
    // component state (#81: "settings apply immediately").
    await page.reload();
    await expectConnected(page);
    await expect(page.getByLabel("Session review")).toHaveValue("opus");
  });

  test("the RPE capture control is three mutually-exclusive states, defaulting to flagged sets only (#63)", async ({
    page,
  }) => {
    await page.goto("/settings");
    await expectConnected(page);

    const off = page.getByRole("radio", { name: "Off" });
    const flaggedOnly = page.getByRole("radio", { name: "Flagged sets only" });
    const everySet = page.getByRole("radio", { name: "Every set" });

    await expect(off).toBeVisible();
    await expect(flaggedOnly).toBeVisible();
    await expect(everySet).toBeVisible();
    await expect(flaggedOnly).toBeChecked();

    await everySet.check();
    await expect(everySet).toBeChecked();
    await expect(flaggedOnly).not.toBeChecked();

    // Applies immediately and survives a reload, same contract as the model selectors.
    await page.reload();
    await expectConnected(page);
    await expect(page.getByRole("radio", { name: "Every set" })).toBeChecked();
  });
});
