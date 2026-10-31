import { readFile } from "node:fs/promises";

import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

import { expectConnected, resetServer, setOffline } from "../driver.ts";

const DEV_SERVER_HTTP_URL = "http://127.0.0.1:4010";

/**
 * Settings → "Your data" → "Export my data (JSON)".
 *
 * One file, named `repcoach-export-YYYY-MM-DD.json`, holding everything the
 * home server has: `format: "repcoach-export"`, `version: 1`, an `exportedAt`
 * timestamp and `tables` — table name → array of rows. A set logged and a
 * bodyweight logged before exporting must both be in it. The button needs
 * the server, so it is disabled offline.
 */

type Export = {
  readonly format: unknown;
  readonly version: unknown;
  readonly exportedAt: unknown;
  readonly tables: Record<string, unknown>;
};

const exportButton = (page: Page) => page.getByRole("button", { name: "Export my data (JSON)" });

const readActualCount = async (request: APIRequestContext) => {
  const response = await request.get(`${DEV_SERVER_HTTP_URL}/__test__/logged-actuals`);
  return ((await response.json()) as { readonly actuals: readonly unknown[] }).actuals.length;
};

const localDate = () => {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
};

test.describe("export my data as JSON", () => {
  test.beforeEach(async ({ request }) => {
    await resetServer(request);
  });

  test.afterEach(async ({ request, context }) => {
    await setOffline(context, false);
    await resetServer(request);
  });

  test("downloads one dated JSON file with every table, including what was just logged", async ({
    page,
    request,
  }) => {
    // Something to find: one logged set, and today's bodyweight.
    await page.goto("/");
    await expectConnected(page);
    await page.getByRole("button", { name: /^Session 1/ }).click();
    await expect(page.getByRole("button", { name: "Back to Today" })).toBeVisible({ timeout: 20_000 });
    await page.getByRole("button", { name: "Log as prescribed" }).first().click();
    await expect.poll(async () => readActualCount(request), { timeout: 20_000 }).toBe(1);

    await page.goto("/progress");
    await expectConnected(page);
    await page.getByLabel("Today's bodyweight in kg").fill("81.5");
    await page.getByRole("button", { name: "Log today" }).click();
    await expect(page.getByRole("button", { name: "Replace today's" })).toBeVisible();

    await page.goto("/settings");
    await expectConnected(page);
    await expect(page.getByRole("heading", { name: "Your data" })).toBeVisible();

    const downloading = page.waitForEvent("download");
    await exportButton(page).click();
    const download = await downloading;

    expect(download.suggestedFilename()).toMatch(/^repcoach-export-\d{4}-\d{2}-\d{2}\.json$/);
    expect(download.suggestedFilename()).toBe(`repcoach-export-${localDate()}.json`);

    const path = await download.path();
    const body = JSON.parse(await readFile(path, "utf8")) as Export;
    expect(body.format).toBe("repcoach-export");
    expect(body.version).toBe(1);
    expect(typeof body.exportedAt).toBe("string");
    expect(Number.isNaN(Date.parse(body.exportedAt as string))).toBe(false);

    expect(body.tables).toBeTruthy();
    expect(typeof body.tables).toBe("object");
    for (const rows of Object.values(body.tables)) {
      expect(Array.isArray(rows)).toBe(true);
    }

    const sessions = body.tables["logged_session"] as readonly unknown[] | undefined;
    const actuals = body.tables["logged_set_actual"] as readonly unknown[] | undefined;
    const bodyweight = body.tables["bodyweight_entry"] as readonly unknown[] | undefined;
    expect(sessions?.length ?? 0).toBeGreaterThanOrEqual(1);
    expect(actuals?.length ?? 0).toBeGreaterThanOrEqual(1);
    expect(bodyweight?.length ?? 0).toBe(1);
    expect(JSON.stringify(bodyweight)).toContain("81.5");
  });

  test("is disabled while offline, and comes back when the connection does", async ({ page, context }) => {
    await page.goto("/settings");
    await expectConnected(page);
    await expect(exportButton(page)).toBeEnabled();

    await setOffline(context, true);
    await expect(exportButton(page)).toBeDisabled({ timeout: 15_000 });

    await setOffline(context, false);
    await expectConnected(page);
    await expect(exportButton(page)).toBeEnabled({ timeout: 15_000 });
  });
});
