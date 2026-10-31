import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

import { expectConnected, resetServer, setOffline } from "../driver.ts";

const DEV_SERVER_HTTP_URL = "http://127.0.0.1:4010";

/**
 * Adding an exercise to a workout already in progress.
 *
 * Under the last exercise and above `Finish session` sits `+ Add exercise`.
 * It opens the same catalog picker the Plan editor and "Swap this exercise"
 * use (`Exercise catalog`, `Search the catalog`), with three ways in:
 *
 * - one of YOUR catalog exercises is added on the tap, no second step;
 * - a library exercise opens its preview, whose action is `Add to workout`;
 * - a name the catalog lacks is offered as `Create “<name>”`, which creates
 *   and adds it in one gesture.
 *
 * Exercises already on this workout say `already in this session`.
 *
 * The added exercise is a new section after the planned ones — an h2 with its
 * name and a small `added this workout` line — starting with three Set rows
 * and its own `More for <name>` button. Its Sets log like any other row's,
 * the footer total grows by its rows, it survives a reload, and a Set logged
 * on it reaches the server. Offline, an exercise already in the catalog can
 * still be added; it shows at once and syncs on reconnect.
 *
 * The seed's catalog holds exactly the four exercises Session 1 prescribes,
 * so "one of YOUR exercises not yet in this workout" only exists once the
 * user has made one: the offline journey adds a library exercise in workout
 * 1, finishes, and adds it back from Your exercises in workout 2.
 *
 * Handles are visible text and accessible names only; there is no server
 * read lever for added Entries, so server-side claims go through the Sets
 * logged on them (`/__test__/logged-actuals`).
 */

const LIBRARY_EXERCISE = "Barbell Pendlay Row";
const NEW_EXERCISE = "Zercher Squat";
const SEEDED_ENTRY_IDS = new Set(["entry-1", "entry-2", "entry-3", "entry-4"]);

const CONFIRM_NAME = /^(Log as prescribed|Logged)$/;
const confirms = (page: Page) => page.getByRole("button", { name: CONFIRM_NAME });
const OLD_HINT = /✓ logs|logs \d/i;

const addButton = (page: Page) => page.getByRole("button", { name: "+ Add exercise" });
const picker = (page: Page) => page.getByRole("dialog", { name: "Exercise catalog" });
const search = (page: Page) => page.getByRole("textbox", { name: "Search the catalog" });
const sectionHeading = (page: Page, name: string) =>
  page.getByRole("heading", { level: 2, name, exact: true });

type LoggedActual = {
  readonly commandId: string;
  readonly loggedSessionId?: string;
  readonly entryId?: string;
  readonly setId: string;
  readonly retraction?: boolean;
  readonly actual: { readonly reps?: number; readonly load?: number; readonly duration?: number };
};

const readActuals = async (request: APIRequestContext): Promise<readonly LoggedActual[]> => {
  const response = await request.get(`${DEV_SERVER_HTTP_URL}/__test__/logged-actuals`);
  expect(response.ok()).toBe(true);
  return ((await response.json()) as { readonly actuals: readonly LoggedActual[] }).actuals;
};

/** Actuals logged against an Entry the Plan never prescribed. */
const addedEntryActuals = async (request: APIRequestContext) =>
  (await readActuals(request)).filter(
    (entry) => entry.entryId !== undefined && !SEEDED_ENTRY_IDS.has(entry.entryId) && entry.retraction !== true,
  );

const startSession1 = async (page: Page) => {
  await page.goto("/");
  await expectConnected(page);
  await expect(page.getByRole("heading", { name: "Today", exact: true })).toBeVisible();
  await page.getByRole("button", { name: /^Session 1/ }).click();
  await expect(page.getByRole("button", { name: "Back to Today" })).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText(/0\s*\/\s*6/)).toBeVisible();
};

const skipRest = async (page: Page) => {
  const skip = page.getByRole("button", { name: /^skip$/i }).first();
  if (await skip.isVisible().catch(() => false)) {
    await skip.click();
  }
};

const openPicker = async (page: Page) => {
  await skipRest(page);
  await addButton(page).click();
  await expect(picker(page)).toBeVisible();
  await expect(search(page)).toBeVisible();
};

/** Library path: search, open the preview, `Add to workout`. */
const addFromLibrary = async (page: Page, name: string) => {
  await openPicker(page);
  await search(page).fill(name);
  await picker(page)
    .getByRole("button", { name: new RegExp(`^${name}`) })
    .first()
    .click();
  const preview = page.getByRole("dialog", { name, exact: true });
  await expect(preview).toBeVisible();
  await preview.getByRole("button", { name: "Add to workout" }).click();
  await expect(picker(page)).toHaveCount(0);
  await expect(preview).toHaveCount(0);
};

/** Open a metric cell's editor by its accessible name, type a value, save. */
const typeMetric = async (page: Page, cell: ReturnType<Page["getByRole"]>, metric: string, value: string) => {
  await skipRest(page);
  await cell.click();
  const field = page.getByRole("textbox", { name: `${metric} value` });
  await field.fill(value);
  await page.getByRole("button", { name: "Save" }).click();
  await expect(field).toHaveCount(0);
  await skipRest(page);
};

/** The added section's rows are the last three on the surface. */
const addedRow = (page: Page, total: number, n: 0 | 1 | 2) => confirms(page).nth(total - 3 + n);

test.describe("add an exercise to a workout in progress", () => {
  test.beforeEach(async ({ request }) => {
    await resetServer(request);
  });

  test.afterEach(async ({ request, context }) => {
    await setOffline(context, false);
    await resetServer(request);
  });

  test("+ Add exercise sits under the last exercise, above Finish, and opens the catalog with this workout's exercises marked", async ({
    page,
  }) => {
    await startSession1(page);

    const add = addButton(page);
    await expect(add).toBeVisible();

    // Placement is what a user sees: after the last planned exercise (Leg
    // Press and its drop row), before the button that ends the workout.
    const lastHeading = await sectionHeading(page, "Leg Press").boundingBox();
    const lastRow = await confirms(page).last().boundingBox();
    const addBox = await add.boundingBox();
    const finishBox = await page.getByRole("button", { name: /^finish session$/i }).boundingBox();
    expect(lastHeading && lastRow && addBox && finishBox).toBeTruthy();
    expect(addBox!.y).toBeGreaterThan(lastHeading!.y);
    expect(addBox!.y).toBeGreaterThan(lastRow!.y);
    expect(addBox!.y).toBeLessThan(finishBox!.y);

    await openPicker(page);
    for (const name of ["Back Squat", "Bench Press", "Plank", "Leg Press"]) {
      await expect(
        picker(page).getByRole("button", { name: new RegExp(`^${name}.*already in this session`, "i") }),
      ).toBeVisible();
    }
    await expect(page.getByText(OLD_HINT)).toHaveCount(0);

    await picker(page).getByRole("button", { name: "Close", exact: true }).last().click();
    await expect(picker(page)).toHaveCount(0);
    // Opening and closing the picker added nothing.
    await expect(page.getByText(/0 of 6 sets logged/i)).toBeVisible();
    await expect(page.getByText(/added this workout/i)).toHaveCount(0);
  });

  test("a library exercise is added through its preview's Add to workout, as a new section with three Set rows", async ({
    page,
  }) => {
    await startSession1(page);
    await addFromLibrary(page, LIBRARY_EXERCISE);

    const heading = sectionHeading(page, LIBRARY_EXERCISE);
    await expect(heading).toBeVisible();
    await expect(page.getByText(/added this workout/i)).toHaveCount(1);
    await expect(page.getByRole("button", { name: `More for ${LIBRARY_EXERCISE}`, exact: true })).toBeVisible();

    // A new section AFTER the planned ones.
    const legPress = await sectionHeading(page, "Leg Press").boundingBox();
    const added = await heading.boundingBox();
    expect(added!.y).toBeGreaterThan(legPress!.y);
    // And still above + Add exercise, so the next one goes under it.
    expect((await addButton(page).boundingBox())!.y).toBeGreaterThan(added!.y);

    // Three rows, all unlogged; the total grows by three, done does not.
    await expect(confirms(page)).toHaveCount(9);
    await expect(page.getByRole("button", { name: "Logged", exact: true })).toHaveCount(0);
    await expect(page.getByText(/0 of 9 sets logged/i)).toBeVisible();
    await expect(page.getByText(/0\s*\/\s*9/)).toBeVisible();

    // The picker now counts it as part of this workout.
    await openPicker(page);
    await expect(
      picker(page).getByRole("button", { name: new RegExp(`^${LIBRARY_EXERCISE}.*already in this session`, "i") }),
    ).toBeVisible();
    await expect(page.getByText(OLD_HINT)).toHaveCount(0);
  });

  test("a name the catalog lacks is created and added in one gesture", async ({ page }) => {
    await startSession1(page);
    await openPicker(page);
    await search(page).fill(NEW_EXERCISE);
    await picker(page)
      .getByRole("button", { name: new RegExp(`^Create\\s*[“"]${NEW_EXERCISE}[”"]`) })
      .click();

    await expect(picker(page)).toHaveCount(0);
    await expect(sectionHeading(page, NEW_EXERCISE)).toBeVisible();
    await expect(page.getByText(/added this workout/i)).toHaveCount(1);
    await expect(page.getByRole("button", { name: `More for ${NEW_EXERCISE}`, exact: true })).toBeVisible();
    await expect(confirms(page)).toHaveCount(9);
    await expect(page.getByText(/0 of 9 sets logged/i)).toBeVisible();
  });

  test("a Set on an added exercise logs, counts, reaches the server, and survives a reload with the exercise", async ({
    page,
    request,
  }) => {
    await startSession1(page);
    await addFromLibrary(page, LIBRARY_EXERCISE);
    await expect(confirms(page)).toHaveCount(9);

    // Log the added exercise's first Set with the numbers actually lifted.
    // The section is the last one on the surface, so its first reps/load
    // cells are the third-from-last of each.
    const repsCells = page.getByRole("button", { name: /^reps —/ });
    const loadCells = page.getByRole("button", { name: /^load —/ });
    const repsCount = await repsCells.count();
    await typeMetric(page, repsCells.nth(repsCount - 3), "reps", "8");
    const loadCount = await loadCells.count();
    await typeMetric(page, loadCells.nth(loadCount - 3), "load", "40");

    await expect(addedRow(page, 9, 0)).toHaveAccessibleName("Logged");
    await expect(addedRow(page, 9, 1)).toHaveAccessibleName("Log as prescribed");
    await expect(page.getByText(/1 of 9 sets logged/i)).toBeVisible();
    await expect(page.getByText(/1\s*\/\s*9/)).toBeVisible();
    await expect(page.getByRole("button", { name: /^reps — logged 8\b/ })).toHaveCount(1);
    await expect(page.getByRole("button", { name: /^load — logged 40\b/ })).toHaveCount(1);

    await expect
      .poll(
        async () =>
          (await addedEntryActuals(request)).some(
            (entry) => entry.actual.reps === 8 && entry.actual.load === 40,
          ),
        { timeout: 20_000 },
      )
      .toBe(true);

    await page.reload();
    await expect(page.getByRole("button", { name: "Back to Today" })).toBeVisible({ timeout: 20_000 });
    await expectConnected(page);

    await expect(sectionHeading(page, LIBRARY_EXERCISE)).toBeVisible();
    await expect(page.getByText(/added this workout/i)).toHaveCount(1);
    await expect(confirms(page)).toHaveCount(9);
    await expect(addedRow(page, 9, 0)).toHaveAccessibleName("Logged");
    await expect(page.getByText(/1 of 9 sets logged/i)).toBeVisible();
    await expect(page.getByRole("button", { name: /^reps — logged 8\b/ })).toHaveCount(1);
    await expect(page.getByText(OLD_HINT)).toHaveCount(0);
  });

  test("✓ on a never-done added row asks for a number instead of logging an empty Set", async ({
    page,
    request,
  }) => {
    await startSession1(page);
    await addFromLibrary(page, LIBRARY_EXERCISE);
    await expect(confirms(page)).toHaveCount(9);

    await skipRest(page);
    // Nothing is prescribed and nothing was lifted before, so there is no
    // number for ✓ to write. The tap opens the first field rather than
    // recording a Set of nothing.
    await addedRow(page, 9, 0).click();
    await expect(addedRow(page, 9, 0)).toHaveAccessibleName("Log as prescribed");
    await expect(page.getByText(/0 of 9 sets logged/i)).toBeVisible();
    const repsInput = page.getByRole("textbox", { name: "reps value" });
    await expect(repsInput).toBeVisible();
    await repsInput.fill("8");
    await page.getByRole("button", { name: "Save" }).click();

    await expect(addedRow(page, 9, 0)).toHaveAccessibleName("Logged");
    await expect(page.getByText(/1 of 9 sets logged/i)).toBeVisible();
    await expect.poll(async () => (await addedEntryActuals(request)).length, { timeout: 20_000 }).toBe(1);

    // Whatever a logged row says about itself has to be a number a user can
    // read — never a placeholder leaking from an empty value.
    const names = await page.getByRole("button", { name: /^(reps|load) — logged/ }).evaluateAll((cells) =>
      cells.map((cell) => cell.getAttribute("aria-label") ?? cell.textContent ?? ""),
    );
    expect(names.length).toBeGreaterThan(0);
    for (const name of names) {
      expect(name).not.toMatch(/undefined|null|NaN/);
    }
  });

  test("offline, one of your catalog exercises is added at once, and its logged Set syncs on reconnect", async ({
    page,
    request,
    context,
  }) => {
    // Workout 1, online: bring the library exercise into the catalog by adding
    // it, log a Set on it, finish.
    await startSession1(page);
    await addFromLibrary(page, LIBRARY_EXERCISE);
    const repsCells = page.getByRole("button", { name: /^reps —/ });
    const loadCells = page.getByRole("button", { name: /^load —/ });
    await typeMetric(page, repsCells.nth((await repsCells.count()) - 3), "reps", "8");
    await typeMetric(page, loadCells.nth((await loadCells.count()) - 3), "load", "40");
    await expect
      .poll(
        async () =>
          (await addedEntryActuals(request)).some(
            (entry) => entry.actual.reps === 8 && entry.actual.load === 40,
          ),
        { timeout: 20_000 },
      )
      .toBe(true);
    const workout1 = new Set((await readActuals(request)).map((entry) => entry.loggedSessionId));
    await expectConnected(page);
    await page.getByRole("button", { name: /^finish session$/i }).click();
    await expect(page.getByRole("heading", { name: "Today", exact: true })).toBeVisible({ timeout: 15_000 });

    // Workout 2 starts online (the prefetch premise), then the link dies.
    await startSession1(page);
    await expect(page.getByText(/added this workout/i)).toHaveCount(0);
    await setOffline(context, true);
    await expect(page.getByText(/offline/i).first()).toBeVisible({ timeout: 20_000 });

    // It is one of YOUR exercises now and not on this workout: one tap adds
    // it — no preview, no Add to workout step.
    await openPicker(page);
    const yours = picker(page).getByRole("button", {
      name: new RegExp(`^${LIBRARY_EXERCISE}(?! upper back)`),
    });
    await expect(yours).toBeVisible();
    await expect(yours).not.toHaveAccessibleName(/already in this session/i);
    await yours.click();
    await expect(page.getByRole("button", { name: "Add to workout" })).toHaveCount(0);
    await expect(picker(page)).toHaveCount(0);

    await expect(sectionHeading(page, LIBRARY_EXERCISE)).toBeVisible();
    await expect(page.getByText(/added this workout/i)).toHaveCount(1);
    await expect(confirms(page)).toHaveCount(9);
    await expect(page.getByText(/0 of 9 sets logged/i)).toBeVisible();

    // Log its first Set offline with the reps actually done; nothing new
    // reaches the server yet. (Whether the row ALSO suggests last time's
    // numbers is suggest-last-time.spec.ts's claim, not this one's.)
    const before = (await readActuals(request)).length;
    const repsCount = await repsCells.count();
    await typeMetric(page, repsCells.nth(repsCount - 3), "reps", "6");
    await expect(addedRow(page, 9, 0)).toHaveAccessibleName("Logged");
    await expect(page.getByText(/1 of 9 sets logged/i)).toBeVisible();
    expect(await readActuals(request)).toHaveLength(before);

    await setOffline(context, false);
    await expectConnected(page);

    // Synced: one Set on an added Entry, from workout 2, carrying the typed reps.
    await expect
      .poll(
        async () =>
          (await addedEntryActuals(request)).filter((entry) => !workout1.has(entry.loggedSessionId)),
        { timeout: 30_000 },
      )
      .toEqual([expect.objectContaining({ actual: expect.objectContaining({ reps: 6 }) })]);

    // And the exercise is still there once the dust settles.
    await page.reload();
    await expect(page.getByRole("button", { name: "Back to Today" })).toBeVisible({ timeout: 20_000 });
    await expect(sectionHeading(page, LIBRARY_EXERCISE)).toBeVisible();
    await expect(page.getByText(/1 of 9 sets logged/i)).toBeVisible();
    await expect(page.getByText(OLD_HINT)).toHaveCount(0);
  });
});
