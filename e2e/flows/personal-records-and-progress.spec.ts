import { expect, test, type APIRequestContext, type Locator, type Page } from "@playwright/test";

import { expectConnected, resetServer, setOffline } from "../driver.ts";

const DEV_SERVER_HTTP_URL = "http://127.0.0.1:4010";

/**
 * Personal records in Logging, and the Progress page.
 *
 * - A logged working set whose estimated 1RM (Epley: load × (1 + reps/30),
 *   only for 1–12 reps and load > 0) beats the best e1RM across PREVIOUSLY
 *   FINISHED sessions of that exercise carries a "PR" badge, aria-label
 *   "Personal record", in its row.
 * - Warmups never count toward the best; the very first session of an
 *   exercise is never a PR.
 * - Today → "Progress →" opens /progress: "Progress" / "Strength and
 *   bodyweight", a Strength section with an exercise select offering only
 *   exercises with finished history, "Best estimated 1RM X kg · L kg × R on
 *   <date>", an e1RM chart, a "Volume per session" chart and a "Personal
 *   records" list.
 *
 * Seeded Session 1, top to bottom: Back Squat ×2 (5 @ 100 kg), Bench Press,
 * Plank, Leg Press + drop. Back Squat's first two reps/load cells are its two
 * sets.
 */

const confirms = (page: Page) => page.getByRole("button", { name: /^(Log as prescribed|Logged)$/ });
const repsCells = (page: Page) => page.getByRole("button", { name: /^reps —/ });
const loadCells = (page: Page) => page.getByRole("button", { name: /^load —/ });
const prBadges = (page: Page) => page.getByLabel("Personal record", { exact: true });

type LoggedActual = { readonly retraction?: boolean };

const actualCount = async (request: APIRequestContext) => {
  const response = await request.get(`${DEV_SERVER_HTTP_URL}/__test__/logged-actuals`);
  const body = (await response.json()) as { readonly actuals: readonly LoggedActual[] };
  return body.actuals.filter((entry) => entry.retraction !== true).length;
};

const skipRest = async (page: Page) => {
  const skip = page.getByRole("button", { name: /^skip$/i }).first();
  if (await skip.isVisible().catch(() => false)) {
    await skip.click();
  }
};

const startSession1 = async (page: Page) => {
  await page.goto("/");
  await expectConnected(page);
  await expect(page.getByRole("heading", { name: "Today", exact: true })).toBeVisible();
  await page.getByRole("button", { name: /^Session 1/ }).click();
  await expect(page.getByRole("button", { name: "Back to Today" })).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText(/0\s*\/\s*6/)).toBeVisible();
};

const typeMetric = async (page: Page, cell: Locator, metric: string, value: string) => {
  await skipRest(page);
  await cell.click();
  const field = page.getByRole("textbox", { name: `${metric} value` });
  await field.fill(value);
  await page.getByRole("button", { name: "Save" }).click();
  await expect(field).toHaveCount(0);
  await skipRest(page);
};

const tapConfirm = async (page: Page, index: number) => {
  await skipRest(page);
  await confirms(page).nth(index).click();
  await expect(confirms(page).nth(index)).toHaveAccessibleName("Logged");
  await skipRest(page);
};

/** Finish once `expected` actuals in total have reached the server. */
const finish = async (page: Page, request: APIRequestContext, expected: number) => {
  await expect.poll(async () => actualCount(request), { timeout: 20_000 }).toBeGreaterThanOrEqual(expected);
  await expectConnected(page);
  await skipRest(page);
  await page.getByRole("button", { name: /^finish session$/i }).click();
  await expect(page.getByRole("heading", { name: "Today", exact: true })).toBeVisible({ timeout: 15_000 });
};

/** Workout 1: the two Back Squat sets as prescribed (5 × 100 kg), nothing else. */
const baselineSquatWorkout = async (page: Page, request: APIRequestContext) => {
  await startSession1(page);
  await tapConfirm(page, 0);
  await tapConfirm(page, 1);
  await finish(page, request, 2);
};

const openProgress = async (page: Page) => {
  await page.goto("/progress");
  await expectConnected(page);
  await expect(page.getByRole("heading", { name: "Strength and bodyweight" })).toBeVisible();
};

test.describe("personal records and Progress", () => {
  test.beforeEach(async ({ request }) => {
    await resetServer(request);
  });

  test.afterEach(async ({ request, context }) => {
    await setOffline(context, false);
    await resetServer(request);
  });

  test("the first session of an exercise is never a PR, however heavy", async ({ page, request }) => {
    await startSession1(page);
    await typeMetric(page, loadCells(page).nth(0), "load", "150");
    await expect(confirms(page).nth(0)).toHaveAccessibleName("Logged");
    await tapConfirm(page, 1);
    await expect(prBadges(page)).toHaveCount(0);
    await finish(page, request, 2);

    await openProgress(page);
    await expect(page.getByRole("heading", { name: "Personal records" })).toBeVisible();
    await expect(page.getByText(/none yet/i)).toBeVisible();
  });

  test("a set that beats the previous best e1RM is badged; equal or out-of-range sets are not", async ({
    page,
    request,
  }) => {
    await baselineSquatWorkout(page, request);

    // Workout 2. Set 1: 110 × 5 (e1RM 128.3 > 116.7) — a PR.
    await startSession1(page);
    await typeMetric(page, loadCells(page).nth(0), "load", "110");
    await expect(confirms(page).nth(0)).toHaveAccessibleName("Logged");
    await expect(prBadges(page)).toHaveCount(1);

    // Set 2: 100 × 13 would be e1RM 143.3 — but 13 reps is outside 1–12.
    await typeMetric(page, repsCells(page).nth(1), "reps", "13");
    await typeMetric(page, loadCells(page).nth(1), "load", "100");
    await expect(confirms(page).nth(1)).toHaveAccessibleName("Logged");
    await expect(prBadges(page)).toHaveCount(1);

    await finish(page, request, 4);

    // A third workout matching (not beating) workout 2's best is not a PR.
    await startSession1(page);
    await typeMetric(page, loadCells(page).nth(0), "load", "110");
    await expect(confirms(page).nth(0)).toHaveAccessibleName("Logged");
    await expect(prBadges(page)).toHaveCount(0);
  });

  test("Today's Progress link opens the page, which reports the best e1RM, two charts and the PRs", async ({
    page,
    request,
  }) => {
    await baselineSquatWorkout(page, request);
    await startSession1(page);
    await typeMetric(page, loadCells(page).nth(0), "load", "110");
    await tapConfirm(page, 1);
    await finish(page, request, 4);

    await page.getByRole("button", { name: "Progress →" }).click();
    await expect(page).toHaveURL(/\/progress$/);
    await expect(page.getByText("Progress", { exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Strength and bodyweight" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Strength", exact: true })).toBeVisible();

    const exercise = page.getByRole("combobox", { name: "Exercise" });
    await expect(exercise).toBeVisible();
    // Only Back Squat was ever logged — nothing else is offered.
    await expect(exercise.getByRole("option")).toHaveText(["Back Squat"]);

    // Best: 110 × 5 → 110 × (1 + 5/30) = 128.3 kg.
    await expect(page.getByText(/Best estimated 1RM 128\.3 kg · 110 kg × 5 on \w{3} \d{1,2}, \d{4}/)).toBeVisible();
    await expect(page.getByRole("img", { name: /estimated one-rep max for back squat/i })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Volume per session" })).toBeVisible();
    await expect(page.getByRole("img", { name: /volume per session/i })).toBeVisible();

    await expect(page.getByRole("heading", { name: "Personal records" })).toBeVisible();
    await expect(page.getByText(/none yet/i)).toHaveCount(0);
    await expect(page.getByText(/110 kg × 5/).last()).toBeVisible();
  });

  test("warmups never set the bar: an imported heavy warmup does not block a PR", async ({ page }) => {
    // History arrives by import: a 200 kg warmup (e1RM 233) and a 100 × 5
    // working set (e1RM 116.7) of the squat.
    const csv = [
      "Date,Workout Name,Duration,Exercise Name,Set Order,Weight,Reps,Distance,Seconds,Notes,Workout Notes,RPE",
      "2024-01-17 07:30:00,Leg Day,1h,Squat (Barbell),W,200,5,0,0,,,",
      "2024-01-17 07:30:00,Leg Day,1h,Squat (Barbell),1,100,5,0,0,,,",
    ].join("\n");
    await page.goto("/settings");
    await expectConnected(page);
    const importer = page.getByRole("region", { name: "Import from Strong or Hevy" });
    await importer
      .locator('input[type="file"]')
      .setInputFiles({ name: "strong.csv", mimeType: "text/csv", buffer: Buffer.from(csv) });
    await importer.getByRole("combobox", { name: "Squat (Barbell)" }).selectOption({ label: "Back Squat" });
    await importer.getByRole("button", { name: "Import 1 workouts" }).or(importer.getByRole("button", { name: "Import 1 workout" })).click();
    await expect(page.getByRole("status").filter({ hasText: /Imported 1 workouts?\./ })).toBeVisible({
      timeout: 20_000,
    });

    await openProgress(page);
    await expect(page.getByText(/Best estimated 1RM 116\.7 kg · 100 kg × 5/)).toBeVisible();

    // 110 × 5 is 128.3: below the warmup's 233, above the working best.
    await startSession1(page);
    await typeMetric(page, loadCells(page).nth(0), "load", "110");
    await expect(confirms(page).nth(0)).toHaveAccessibleName("Logged");
    await expect(prBadges(page)).toHaveCount(1);
  });
});
