import { expect, test, type Page } from "@playwright/test";

import { expectConnected, resetServer, setOffline } from "../driver.ts";

/**
 * Bodyweight, on the Progress page's "Bodyweight" section.
 *
 * - "Today's bodyweight in kg" + "Log today". Once today has a reading the
 *   button reads "Replace today's", and logging again replaces it — one
 *   reading per day, never two.
 * - "Trend X" summarises; a chart appears only once there is more than one
 *   reading; the last readings are listed, each with "Remove the reading for
 *   <date>".
 * - It is server-held: the reading survives a reload.
 */

const field = (page: Page) => page.getByLabel("Today's bodyweight in kg");
const removeButtons = (page: Page) => page.getByRole("button", { name: /^Remove the reading for / });

const openProgress = async (page: Page) => {
  await page.goto("/progress");
  await expectConnected(page);
  await expect(page.getByRole("heading", { name: "Bodyweight", exact: true })).toBeVisible();
};

test.describe("log today's bodyweight", () => {
  test.beforeEach(async ({ request }) => {
    await resetServer(request);
  });

  test.afterEach(async ({ request, context }) => {
    await setOffline(context, false);
    await resetServer(request);
  });

  test("a first reading is logged, trended and listed, with no chart for a single point", async ({ page }) => {
    await openProgress(page);
    await expect(page.getByRole("button", { name: "Log today" })).toBeVisible();
    await expect(page.getByText(/^Trend /)).toHaveCount(0);
    await expect(removeButtons(page)).toHaveCount(0);

    await field(page).fill("80.5");
    await page.getByRole("button", { name: "Log today" }).click();

    await expect(page.getByRole("button", { name: "Replace today's" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Log today" })).toHaveCount(0);
    await expect(page.getByText(/^Trend 80\.5 kg/)).toBeVisible();
    await expect(removeButtons(page)).toHaveCount(1);
    await expect(page.getByText(/80\.5 kg/).last()).toBeVisible();

    // One reading is not a line.
    await expect(page.getByRole("img", { name: /bodyweight/i })).toHaveCount(0);

    // Held by the server, not the page.
    await page.reload();
    await expectConnected(page);
    await expect(page.getByRole("button", { name: "Replace today's" })).toBeVisible();
    await expect(removeButtons(page)).toHaveCount(1);
  });

  test("logging again the same day replaces today's reading rather than adding one", async ({ page }) => {
    await openProgress(page);
    await field(page).fill("80.5");
    await page.getByRole("button", { name: "Log today" }).click();
    await expect(page.getByRole("button", { name: "Replace today's" })).toBeVisible();

    await field(page).fill("79.8");
    await page.getByRole("button", { name: "Replace today's" }).click();

    await expect(page.getByText(/^Trend 79\.8 kg/)).toBeVisible();
    await expect(removeButtons(page)).toHaveCount(1);
    await expect(page.getByText(/80\.5 kg/)).toHaveCount(0);
  });

  test("a reading can be removed, returning the section to empty", async ({ page }) => {
    await openProgress(page);
    await field(page).fill("82");
    await page.getByRole("button", { name: "Log today" }).click();
    await expect(removeButtons(page)).toHaveCount(1);

    await removeButtons(page).first().click();

    await expect(removeButtons(page)).toHaveCount(0);
    await expect(page.getByText(/^Trend /)).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Log today" })).toBeVisible();

    await page.reload();
    await expectConnected(page);
    await expect(removeButtons(page)).toHaveCount(0);
  });
});
