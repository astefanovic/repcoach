import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

import { expectConnected, resetServer, setOffline } from "../driver.ts";

const DEV_SERVER_HTTP_URL = "http://127.0.0.1:4010";

/**
 * Weight unit — a per-device display preference (Settings → "Weight unit").
 *
 * The behaviour under test, as a user sees it:
 *
 * - Kilograms is the default; Pounds survives a reload (it lives in this
 *   browser, not on the server).
 * - In pounds every load reads in lb, rounded to 0.1 with a trailing .0
 *   dropped: 100 kg → 220.5 lb, 60 kg → 132.3 lb, 80 kg → 176.4 lb. That holds
 *   on the Plan, in the Logging grid and on Progress.
 * - A load typed in lb is **stored in kg** — the server's actual is the kg
 *   equivalent, and switching back to kg shows that kg number.
 * - Steppers move 2.5 in kg and 5 in lb, and in lb a tap snaps onto the 5 lb
 *   grid (176.4 → + → 180, 176.4 → − → 175).
 *
 * Every set row below is the seeded Session 1, top to bottom: Back Squat ×2
 * (5 @ 100 kg), Bench Press (8–10 @ 60 kg), Plank (duration only), Leg Press
 * (10 @ 80 kg) and its drop (≤60 kg). Load cells skip Plank, so the load-cell
 * indices are squat 0/1, bench 2, leg press 3, drop 4.
 */

const LOAD = { squatFirst: 0, squatSecond: 1, bench: 2, legPress: 3, drop: 4 } as const;

const loadCells = (page: Page) => page.getByRole("button", { name: /^load —/ });
const confirms = (page: Page) => page.getByRole("button", { name: /^(Log as prescribed|Logged)$/ });
const loadField = (page: Page) => page.getByRole("textbox", { name: "load value" });

type LoggedActual = {
  readonly loggedSessionId?: string;
  readonly retraction?: boolean;
  readonly actual: { readonly reps?: number; readonly load?: number; readonly duration?: number };
};

const readActuals = async (request: APIRequestContext): Promise<readonly LoggedActual[]> => {
  const response = await request.get(`${DEV_SERVER_HTTP_URL}/__test__/logged-actuals`);
  expect(response.ok()).toBe(true);
  return ((await response.json()) as { readonly actuals: readonly LoggedActual[] }).actuals.filter(
    (entry) => entry.retraction !== true,
  );
};

const skipRest = async (page: Page) => {
  const skip = page.getByRole("button", { name: /^skip$/i }).first();
  if (await skip.isVisible().catch(() => false)) {
    await skip.click();
  }
};

const chooseUnit = async (page: Page, unit: "kg" | "lb") => {
  await page.goto("/settings");
  await expectConnected(page);
  const radio = page.getByRole("radio", { name: unit === "kg" ? "Kilograms (kg)" : "Pounds (lb)" });
  await radio.check();
  await expect(radio).toBeChecked();
};

const startSession1 = async (page: Page) => {
  await page.goto("/");
  await expectConnected(page);
  await expect(page.getByRole("heading", { name: "Today", exact: true })).toBeVisible();
  await page.getByRole("button", { name: /^Session 1/ }).click();
  await expect(page.getByRole("button", { name: "Back to Today" })).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText(/0\s*\/\s*6/)).toBeVisible();
};

test.describe("weight unit: pounds on this device, kilograms underneath", () => {
  test.beforeEach(async ({ request }) => {
    await resetServer(request);
  });

  test.afterEach(async ({ request, context }) => {
    await setOffline(context, false);
    await resetServer(request);
  });

  test("Kilograms is the default, and choosing Pounds survives a reload", async ({ page }) => {
    await page.goto("/settings");
    await expectConnected(page);

    const group = page.getByRole("radiogroup", { name: "Weight unit" });
    await expect(group).toBeVisible();
    await expect(group.getByRole("radio", { name: "Kilograms (kg)" })).toBeChecked();
    await expect(group.getByRole("radio", { name: "Pounds (lb)" })).not.toBeChecked();

    await group.getByRole("radio", { name: "Pounds (lb)" }).check();
    await expect(group.getByRole("radio", { name: "Pounds (lb)" })).toBeChecked();

    await page.reload();
    await expectConnected(page);
    await expect(page.getByRole("radio", { name: "Pounds (lb)" })).toBeChecked();
    await expect(page.getByRole("radio", { name: "Kilograms (kg)" })).not.toBeChecked();
  });

  test("in pounds, the Plan's targets read in lb, rounded to 0.1", async ({ page }) => {
    await chooseUnit(page, "lb");
    await page.goto("/plan");
    await expectConnected(page);

    await expect(page.getByRole("button", { name: /2 × 5 reps @ 220\.5 lb/ })).toBeVisible();
    await expect(page.getByRole("button", { name: /1 × 8-10 reps @ 132\.3 lb/ })).toBeVisible();
    await expect(page.getByRole("button", { name: /1 × 10 reps @ 176\.4 lb/ })).toBeVisible();
    // Nothing on the Plan is still quoted in kilograms.
    await expect(page.getByText(/\d\s*kg\b/)).toHaveCount(0);
  });

  test("in pounds, the Logging grid shows lb, and a load typed in lb is stored as kg", async ({
    page,
    request,
  }) => {
    await chooseUnit(page, "lb");
    await startSession1(page);

    await expect(loadCells(page).nth(LOAD.squatFirst)).toContainText(/220\.5\s*lb/);
    await expect(loadCells(page).nth(LOAD.bench)).toContainText(/132\.3\s*lb/);
    await expect(loadCells(page).nth(LOAD.legPress)).toContainText(/176\.4\s*lb/);

    // Type 135 lb on Bench Press and save — that logs the set.
    await loadCells(page).nth(LOAD.bench).click();
    await loadField(page).fill("135");
    await page.getByRole("button", { name: "Save" }).click();
    await expect(loadField(page)).toHaveCount(0);
    await skipRest(page);
    await expect(loadCells(page).nth(LOAD.bench)).toContainText(/135\s*lb/);

    // The server holds kilograms: 135 lb ≈ 61.235 kg.
    await expect.poll(async () => (await readActuals(request)).length, { timeout: 20_000 }).toBe(1);
    const [benchActual] = await readActuals(request);
    expect(benchActual?.actual.load).toBeCloseTo(61.235, 2);

    // Back to kilograms: the same set reads as its kg equivalent.
    const logUrl = page.url();
    await chooseUnit(page, "kg");
    await page.goto(logUrl);
    await expect(page.getByRole("button", { name: "Back to Today" })).toBeVisible({ timeout: 20_000 });
    await expectConnected(page);
    await expect(loadCells(page).nth(LOAD.bench)).toContainText(/61\.2\d?\s*kg/);
    await expect(loadCells(page).nth(LOAD.squatFirst)).toContainText(/100\s*kg/);
  });

  test("the load stepper moves 2.5 in kg", async ({ page }) => {
    await startSession1(page);

    await loadCells(page).nth(LOAD.squatFirst).click();
    await expect(loadField(page)).toHaveValue("100");
    await page.getByRole("button", { name: "Increase load" }).click();
    await expect(loadField(page)).toHaveValue("102.5");
    await page.getByRole("button", { name: "Decrease load" }).click();
    await page.getByRole("button", { name: "Decrease load" }).click();
    await expect(loadField(page)).toHaveValue("97.5");
  });

  test("in pounds the load stepper moves 5 and snaps onto the 5 lb grid", async ({ page }) => {
    await chooseUnit(page, "lb");
    await startSession1(page);

    // Leg Press: 80 kg reads 176.4 lb. + snaps up to 180, then steps by 5.
    await loadCells(page).nth(LOAD.legPress).click();
    await expect(loadField(page)).toHaveValue("176.4");
    await page.getByRole("button", { name: "Increase load" }).click();
    await expect(loadField(page)).toHaveValue("180");
    await page.getByRole("button", { name: "Increase load" }).click();
    await expect(loadField(page)).toHaveValue("185");
    await page.getByRole("button", { name: "Cancel" }).last().click();
    await expect(loadField(page)).toHaveCount(0);

    // From 176.4 again, − snaps down to 175.
    await loadCells(page).nth(LOAD.legPress).click();
    await expect(loadField(page)).toHaveValue("176.4");
    await page.getByRole("button", { name: "Decrease load" }).click();
    await expect(loadField(page)).toHaveValue("175");
  });

  /** One finished workout in kg: two Back Squat sets at 5 × 100 kg. */
  const finishTwoSquatSets = async (page: Page, request: APIRequestContext) => {
    await startSession1(page);
    await confirms(page).nth(0).click();
    await skipRest(page);
    await confirms(page).nth(1).click();
    await skipRest(page);
    await expect.poll(async () => (await readActuals(request)).length, { timeout: 20_000 }).toBe(2);
    await expectConnected(page);
    await page.getByRole("button", { name: /^finish session$/i }).click();
    await expect(page.getByRole("heading", { name: "Today", exact: true })).toBeVisible({ timeout: 15_000 });
  };

  test("in pounds, Progress quotes the best set and the bodyweight field in lb", async ({ page, request }) => {
    await finishTwoSquatSets(page, request);
    await chooseUnit(page, "lb");
    await page.goto("/progress");
    await expectConnected(page);

    await expect(page.getByText(/Best estimated 1RM [\d.]+ lb · 220\.5 lb × 5/)).toBeVisible();
    await expect(page.getByText(/\d\s*kg\b/)).toHaveCount(0);
    await expect(page.getByLabel("Today's bodyweight in lb")).toBeVisible();
  });

  /**
   * Rounded once, in the shown unit: 100 × (1 + 5/30) = 116.667 kg = 257.206 lb
   * reads 257.2 lb, not 257.3 (the 0.1 kg display value converted).
   */
  test("in pounds, the best estimated 1RM is converted from kg before rounding", async ({ page, request }) => {
    await finishTwoSquatSets(page, request);
    await chooseUnit(page, "lb");
    await page.goto("/progress");
    await expectConnected(page);

    await expect(page.getByText(/Best estimated 1RM 257\.2 lb · 220\.5 lb × 5/)).toBeVisible();
  });
});
