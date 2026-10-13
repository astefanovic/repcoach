import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

import { expectConnected, resetServer, setOffline } from "../driver.ts";

const DEV_SERVER_HTTP_URL = "http://127.0.0.1:4010";

/**
 * "After a workout where I swapped an exercise, ask me whether to swap it in
 * the plan."
 *
 * A swap during a workout is an actual-side annotation only (ADR 0019); the
 * Plan keeps prescribing what it prescribed. Finishing a workout that carried
 * a swap now asks, once, whether the Plan should follow:
 *
 * - Finish opens a sheet (a dialog) titled `Update the plan?`, one row per
 *   swap, labelled `<prescribed> → <performed>` with a `swap in plan` hint.
 * - Tapping a row writes ONE `user-direct` Plan Change that points that Entry
 *   at the performed exercise — same Entry id, same Sets. The row then reads
 *   `in the plan ✓` and is disabled, so a second tap cannot write twice.
 * - `Close` keeps the Plan as it was and lands on Today.
 * - No swap, no sheet: Finish goes straight to Today.
 * - An exercise ADDED mid-workout is not a swap and is not offered.
 *
 * Fixture: Session 1 prescribes `entry-1` Back Squat .. `entry-4` Leg Press
 * (see `swap-this-exercise.spec.ts`). The performed exercise id is read off
 * `/__test__/entry-swaps` rather than assumed.
 *
 * Every workout logs one Set and waits for it to reach the server before
 * finishing — finishing with Sets still queued is a separate, known gap
 * (`cancel-and-history-a-session.spec.ts`), not this journey's claim.
 *
 * Small-caps chrome is a CSS transform, so text is matched case-insensitively.
 */

const CONFIRM_NAME = /^(Log as prescribed|Logged)$/;
const confirms = (page: Page) => page.getByRole("button", { name: CONFIRM_NAME });

interface EntrySwap {
  readonly entryId: string;
  readonly exerciseId: string;
}

interface PlanEntry {
  readonly id: string;
  readonly exerciseId: string;
  readonly sets: ReadonlyArray<unknown>;
}

interface PlanShape {
  readonly sessions: ReadonlyArray<{
    readonly blocks: ReadonlyArray<{ readonly entries: ReadonlyArray<PlanEntry> }>;
  }>;
}

interface Change {
  readonly id: string;
  readonly origin: string;
  readonly status: string;
  readonly summary: string;
}

const readSwaps = async (request: APIRequestContext): Promise<ReadonlyArray<EntrySwap>> => {
  const response = await request.get(`${DEV_SERVER_HTTP_URL}/__test__/entry-swaps`);
  expect(response.ok()).toBe(true);
  return ((await response.json()) as { readonly swaps: ReadonlyArray<EntrySwap> }).swaps;
};

const readPlan = async (request: APIRequestContext): Promise<PlanShape> => {
  const response = await request.get(`${DEV_SERVER_HTTP_URL}/__test__/plan`);
  expect(response.ok()).toBe(true);
  return ((await response.json()) as { readonly plan: PlanShape }).plan;
};

const readChanges = async (request: APIRequestContext): Promise<ReadonlyArray<Change>> => {
  const response = await request.get(`${DEV_SERVER_HTTP_URL}/__test__/changes`);
  expect(response.ok()).toBe(true);
  return ((await response.json()) as { readonly changes: ReadonlyArray<Change> }).changes;
};

const readActualsCount = async (request: APIRequestContext): Promise<number> => {
  const response = await request.get(`${DEV_SERVER_HTTP_URL}/__test__/logged-actuals`);
  expect(response.ok()).toBe(true);
  return ((await response.json()) as { readonly actuals: ReadonlyArray<unknown> }).actuals.length;
};

const entriesOf = (plan: PlanShape): ReadonlyArray<PlanEntry> =>
  plan.sessions.flatMap((session) => session.blocks.flatMap((block) => block.entries));

const entry = (plan: PlanShape, id: string): PlanEntry | undefined =>
  entriesOf(plan).find((candidate) => candidate.id === id);

const todayHeading = (page: Page) => page.getByRole("heading", { name: "Today", exact: true });
const backToToday = (page: Page) => page.getByRole("button", { name: "Back to Today" });
const updatePlanSheet = (page: Page) => page.getByRole("dialog", { name: /update the plan\?/i });
const swapRow = (page: Page, from: string, to: string) =>
  updatePlanSheet(page).getByRole("button", { name: new RegExp(`${from}\\s*→\\s*${to}`, "i") });

const startSession1 = async (page: Page) => {
  await page.goto("/");
  await expectConnected(page);
  await expect(todayHeading(page)).toBeVisible();
  await page.getByRole("button", { name: /^Session 1/ }).click();
  await expect(backToToday(page)).toBeVisible({ timeout: 20_000 });
};

const skipRest = async (page: Page) => {
  const skip = page.getByRole("button", { name: /^skip$/i }).first();
  if (await skip.isVisible().catch(() => false)) {
    await skip.click();
  }
};

/** Swap the Entry currently titled `from` to the catalog exercise `to`. */
const swapEntry = async (page: Page, from: string, to: string) => {
  await skipRest(page);
  await page.getByRole("button", { name: new RegExp(`^More for ${from}$`, "i") }).first().click();
  const sheet = page.getByRole("dialog", { name: new RegExp(from, "i") }).first();
  await expect(sheet).toBeVisible();
  await sheet.getByRole("button", { name: /Swap this exercise/i }).click();
  await expect(sheet).toBeHidden();

  const picker = page.getByText("Exercise catalog");
  await expect(picker).toBeVisible();
  await page.getByPlaceholder("Search the catalog").fill(to);
  await page.getByRole("listitem").filter({ hasText: to }).getByRole("button").first().click();
  await expect(picker).toHaveCount(0);
};

/** Log the first Set on the grid and wait for the server to hold it. */
const logFirstSet = async (page: Page, request: APIRequestContext) => {
  await skipRest(page);
  const before = await readActualsCount(request);
  await confirms(page).first().click();
  await expect(confirms(page).first()).toHaveAccessibleName("Logged");
  await skipRest(page);
  await expect.poll(() => readActualsCount(request), { timeout: 20_000 }).toBe(before + 1);
  await expectConnected(page);
};

const finish = async (page: Page) => {
  await skipRest(page);
  await page.getByRole("button", { name: /^finish session$/i }).click();
};

/** A swap reached the server for `entryId`; returns the performed exercise id. */
const swappedExerciseFor = async (request: APIRequestContext, entryId: string): Promise<string> => {
  await expect
    .poll(async () => (await readSwaps(request)).filter((swap) => swap.entryId === entryId).length, {
      timeout: 20_000,
    })
    .toBe(1);
  const swap = (await readSwaps(request)).find((candidate) => candidate.entryId === entryId);
  expect(swap).toBeDefined();
  return swap!.exerciseId;
};

test.describe("swap it in the plan after the workout", () => {
  test.beforeEach(async ({ request }) => {
    await resetServer(request);
  });

  test.afterEach(async ({ request, context }) => {
    await setOffline(context, false);
    await resetServer(request);
  });

  test("finishing a workout with a swap asks to update the plan, offering the swap as one row", async ({
    page,
    request,
  }) => {
    await startSession1(page);
    await swapEntry(page, "Back Squat", "Leg Press");
    await swappedExerciseFor(request, "entry-1");
    await logFirstSet(page, request);

    await finish(page);

    const sheet = updatePlanSheet(page);
    await expect(sheet).toBeVisible({ timeout: 15_000 });
    // It explains why it is asking: the user swapped an exercise.
    await expect(sheet.getByText(/swapped/i).first()).toBeVisible();

    // One row per swap, prescribed → performed, with the hint.
    const row = swapRow(page, "Back Squat", "Leg Press");
    await expect(row).toHaveCount(1);
    await expect(row).toBeEnabled();
    await expect(row).toContainText(/swap in plan/i);
    // Nothing else is offered: no unchanged exercise appears as a row.
    await expect(sheet.getByRole("button", { name: /→/ })).toHaveCount(1);

    // The sheet is the decision point; nothing has happened to the Plan yet.
    await expect(sheet.getByRole("button", { name: "Close", exact: true })).toBeVisible();
  });

  test("tapping the row writes one user-direct Change pointing the Entry at the performed exercise, keeping its id and Sets", async ({
    page,
    request,
  }) => {
    const planBefore = await readPlan(request);
    const entry1Before = entry(planBefore, "entry-1");
    expect(entry1Before).toBeDefined();
    const changesBefore = await readChanges(request);

    await startSession1(page);
    await swapEntry(page, "Back Squat", "Leg Press");
    const performedId = await swappedExerciseFor(request, "entry-1");
    expect(performedId).not.toBe(entry1Before!.exerciseId);
    await logFirstSet(page, request);

    await finish(page);
    const sheet = updatePlanSheet(page);
    await expect(sheet).toBeVisible({ timeout: 15_000 });

    // Finishing alone has not touched the Plan.
    expect(await readPlan(request)).toEqual(planBefore);
    expect(await readChanges(request)).toHaveLength(changesBefore.length);

    const row = swapRow(page, "Back Squat", "Leg Press");
    await row.click();

    // The row confirms itself and cannot be tapped again.
    await expect(row).toContainText(/in the plan\s*✓/i, { timeout: 15_000 });
    await expect(row).not.toContainText(/swap in plan/i);
    await expect(row).toBeDisabled();

    // Server: entry-1 now prescribes the performed exercise; same id, same Sets.
    await expect
      .poll(async () => entry(await readPlan(request), "entry-1")?.exerciseId, { timeout: 20_000 })
      .toBe(performedId);
    const planAfter = await readPlan(request);
    const entry1After = entry(planAfter, "entry-1");
    expect(entry1After?.id).toBe("entry-1");
    expect(entry1After?.sets).toEqual(entry1Before!.sets);
    // Every other Entry is untouched.
    for (const other of entriesOf(planBefore).filter((candidate) => candidate.id !== "entry-1")) {
      expect(entry(planAfter, other.id)).toEqual(other);
    }

    // Exactly one new Change, and it is the user's own.
    await expect.poll(async () => (await readChanges(request)).length, { timeout: 20_000 }).toBe(
      changesBefore.length + 1,
    );
    const beforeIds = new Set(changesBefore.map((change) => change.id));
    const fresh = (await readChanges(request)).filter((change) => !beforeIds.has(change.id));
    expect(fresh).toHaveLength(1);
    expect(fresh[0]?.origin).toBe("user-direct");

    // Close returns to Today.
    await sheet.getByRole("button", { name: "Close", exact: true }).click();
    await expect(sheet).toHaveCount(0);
    await expect(todayHeading(page)).toBeVisible({ timeout: 15_000 });

    // And nothing more was written on the way out.
    expect(await readChanges(request)).toHaveLength(changesBefore.length + 1);

    // The next workout prescribes the performed exercise outright: no swap
    // line, two Leg Press Entries (entry-1 and its own original entry-4).
    await page.getByRole("button", { name: /^Session 1/ }).click();
    await expect(backToToday(page)).toBeVisible({ timeout: 20_000 });
    await expect(page.getByRole("heading", { name: "Leg Press", exact: true })).toHaveCount(2);
    await expect(page.getByRole("heading", { name: "Back Squat", exact: true })).toHaveCount(0);
    await expect(page.getByText(/swapped from/i)).toHaveCount(0);
  });

  test("Close without tapping keeps the plan unchanged, mints no Change, and lands on Today", async ({
    page,
    request,
  }) => {
    const planBefore = await readPlan(request);
    const changesBefore = await readChanges(request);

    await startSession1(page);
    await swapEntry(page, "Back Squat", "Leg Press");
    await swappedExerciseFor(request, "entry-1");
    await logFirstSet(page, request);

    await finish(page);
    const sheet = updatePlanSheet(page);
    await expect(sheet).toBeVisible({ timeout: 15_000 });
    await sheet.getByRole("button", { name: "Close", exact: true }).click();

    await expect(sheet).toHaveCount(0);
    await expect(todayHeading(page)).toBeVisible({ timeout: 15_000 });
    await expect(backToToday(page)).toHaveCount(0);

    expect(await readPlan(request)).toEqual(planBefore);
    expect(await readChanges(request)).toEqual(changesBefore);

    // The next workout still prescribes Back Squat.
    await page.getByRole("button", { name: /^Session 1/ }).click();
    await expect(backToToday(page)).toBeVisible({ timeout: 20_000 });
    await expect(page.getByRole("heading", { name: "Back Squat", exact: true })).toHaveCount(1);
    await expect(page.getByText(/swapped from/i)).toHaveCount(0);
  });

  test("with two swaps, each is its own row and tapping one writes only that one", async ({ page, request }) => {
    const planBefore = await readPlan(request);
    const changesBefore = await readChanges(request);

    await startSession1(page);
    await swapEntry(page, "Back Squat", "Leg Press");
    const legPressId = await swappedExerciseFor(request, "entry-1");
    await swapEntry(page, "Bench Press", "Plank");
    await swappedExerciseFor(request, "entry-2");
    await logFirstSet(page, request);

    await finish(page);
    const sheet = updatePlanSheet(page);
    await expect(sheet).toBeVisible({ timeout: 15_000 });

    const squatRow = swapRow(page, "Back Squat", "Leg Press");
    const benchRow = swapRow(page, "Bench Press", "Plank");
    await expect(squatRow).toHaveCount(1);
    await expect(benchRow).toHaveCount(1);
    await expect(sheet.getByRole("button", { name: /→/ })).toHaveCount(2);

    await squatRow.click();
    await expect(squatRow).toContainText(/in the plan\s*✓/i, { timeout: 15_000 });
    await expect(squatRow).toBeDisabled();
    // The other row is untouched and still offered.
    await expect(benchRow).toContainText(/swap in plan/i);
    await expect(benchRow).toBeEnabled();

    await expect
      .poll(async () => entry(await readPlan(request), "entry-1")?.exerciseId, { timeout: 20_000 })
      .toBe(legPressId);
    await expect.poll(async () => (await readChanges(request)).length, { timeout: 20_000 }).toBe(
      changesBefore.length + 1,
    );

    await sheet.getByRole("button", { name: "Close", exact: true }).click();
    await expect(todayHeading(page)).toBeVisible({ timeout: 15_000 });

    // entry-2 kept its prescribed exercise.
    expect(entry(await readPlan(request), "entry-2")).toEqual(entry(planBefore, "entry-2"));
    expect(await readChanges(request)).toHaveLength(changesBefore.length + 1);
  });

  test("a workout with no swap finishes straight to Today, with no Update the plan? sheet", async ({
    page,
    request,
  }) => {
    const planBefore = await readPlan(request);
    const changesBefore = await readChanges(request);

    await startSession1(page);
    await logFirstSet(page, request);
    await finish(page);

    await expect(todayHeading(page)).toBeVisible({ timeout: 15_000 });
    // A sheet that arrives a beat after Today would still be the wrong answer.
    await page.waitForTimeout(1_500);
    await expect(updatePlanSheet(page)).toHaveCount(0);
    await expect(page.getByText(/update the plan\?/i)).toHaveCount(0);

    expect(await readPlan(request)).toEqual(planBefore);
    expect(await readChanges(request)).toEqual(changesBefore);
  });

  test("an exercise added mid-workout is not offered: finishing goes straight to Today", async ({
    page,
    request,
  }) => {
    const planBefore = await readPlan(request);

    await startSession1(page);
    await skipRest(page);
    await page.getByRole("button", { name: "+ Add exercise" }).click();
    const picker = page.getByRole("dialog", { name: "Exercise catalog" });
    await expect(picker).toBeVisible();
    await page.getByRole("textbox", { name: "Search the catalog" }).fill("Barbell Pendlay Row");
    await picker.getByRole("button", { name: /^Barbell Pendlay Row/ }).first().click();
    const preview = page.getByRole("dialog", { name: "Barbell Pendlay Row", exact: true });
    await expect(preview).toBeVisible();
    await preview.getByRole("button", { name: "Add to workout" }).click();
    await expect(picker).toHaveCount(0);
    await expect(page.getByRole("heading", { level: 2, name: "Barbell Pendlay Row", exact: true })).toBeVisible();
    await expect(page.getByText(/added this workout/i)).toHaveCount(1);

    await logFirstSet(page, request);
    await finish(page);

    await expect(todayHeading(page)).toBeVisible({ timeout: 15_000 });
    // A sheet that arrives a beat after Today would still be the wrong answer.
    await page.waitForTimeout(1_500);
    await expect(updatePlanSheet(page)).toHaveCount(0);
    await expect(page.getByText(/update the plan\?/i)).toHaveCount(0);
    expect(await readPlan(request)).toEqual(planBefore);
  });
});
