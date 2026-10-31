import { expect, test, type APIRequestContext, type Locator, type Page } from "@playwright/test";

import { expectConnected, resetServer, setOffline } from "../driver.ts";

const DEV_SERVER_HTTP_URL = "http://127.0.0.1:4010";

/**
 * Each Set row suggests what was lifted LAST TIME, instead of the plan's range.
 *
 * "Last time" is the most recent FINISHED workout that performed the
 * exercise. The match is per Set, by position within the same set type:
 * working set n suggests last time's working set n, a drop suggests last
 * time's drop, and working sets beyond last time's count repeat last time's
 * final working set. One tap on ✓ writes exactly the suggestion. With no
 * history the row shows the plan's range and ✓ writes its top.
 *
 * What the user reads, as accessible names on the metric cells:
 *
 * - `reps — suggested 10, prescribed 5, tap to change` — a suggestion that
 *   differs from what the prescription text already says;
 * - `reps — prescribed 10, tap to change` — no history, OR a suggestion equal
 *   to an exact prescription (nothing to call out);
 * - `load — seeded 82.5 from last time, tap to change`, shown as `~82.5` —
 *   the plan leaves that metric open;
 * - `reps — logged 9, …` once logged.
 *
 * Within the workout: while the user logs exactly last time's numbers, each
 * following Set keeps suggesting its OWN last-time numbers; once a logged Set
 * departs (a heavier load typed), the next like Set suggests the departed
 * value instead.
 *
 * The retired "✓ logs 10" line under the values is asserted absent throughout.
 *
 * Seeded Session 1, top to bottom: Back Squat 2 × 5 @ 100 (superset with
 * Bench), Bench Press 1 × 8-10 @ 60, Plank 1 × 30-45 sec, Leg Press 1 × 10 @
 * 80 with a drop at <=60. Back Squat gets extra Sets through its own
 * `More for Back Squat` → `Another straight set`, which appends to it.
 */

const CONFIRM_NAME = /^(Log as prescribed|Logged)$/;
const confirms = (page: Page) => page.getByRole("button", { name: CONFIRM_NAME });
const repsCells = (page: Page) => page.getByRole("button", { name: /^reps —/ });
const loadCells = (page: Page) => page.getByRole("button", { name: /^load —/ });
const OLD_HINT = /✓ logs|logs \d/i;

type LoggedActual = {
  readonly commandId: string;
  readonly loggedSessionId?: string;
  readonly entryId?: string;
  readonly setId: string;
  readonly setType?: string;
  readonly appliedAt?: string;
  readonly retraction?: boolean;
  readonly actual: { readonly reps?: number; readonly load?: number; readonly duration?: number };
};

const readActuals = async (request: APIRequestContext): Promise<readonly LoggedActual[]> => {
  const response = await request.get(`${DEV_SERVER_HTTP_URL}/__test__/logged-actuals`);
  expect(response.ok()).toBe(true);
  return ((await response.json()) as { readonly actuals: readonly LoggedActual[] }).actuals;
};

/** Actuals that do not belong to an earlier workout, in the order they were applied. */
const actualsSince = async (request: APIRequestContext, earlier: ReadonlySet<string | undefined>) =>
  (await readActuals(request)).filter((entry) => !earlier.has(entry.loggedSessionId) && entry.retraction !== true);

const startSession1 = async (page: Page) => {
  await page.goto("/");
  await expectConnected(page);
  await expect(page.getByRole("heading", { name: "Today", exact: true })).toBeVisible();
  await page.getByRole("button", { name: /^Session 1/ }).click();
  await expect(page.getByRole("button", { name: "Back to Today" })).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText(/0\s*\/\s*\d+/)).toBeVisible();
};

const skipRest = async (page: Page) => {
  const skip = page.getByRole("button", { name: /^skip$/i }).first();
  if (await skip.isVisible().catch(() => false)) {
    await skip.click();
  }
};

const tapConfirm = async (page: Page, index: number) => {
  await skipRest(page);
  await confirms(page).nth(index).click();
  await expect(confirms(page).nth(index)).toHaveAccessibleName("Logged");
  await skipRest(page);
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

const addStraightSetToBackSquat = async (page: Page) => {
  await skipRest(page);
  await page.getByRole("button", { name: /^More for Back Squat$/i }).click();
  const dialog = page.getByRole("dialog", { name: /Back Squat/i });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: /Another straight set/i }).click();
  if (await dialog.isVisible().catch(() => false)) {
    await dialog.getByRole("button", { name: "Close" }).click();
  }
  await expect(dialog).toBeHidden();
};

/** Finish once everything has reached the server; returns that workout's ids. */
const finishWorkout = async (page: Page, request: APIRequestContext, expectedActuals: number) => {
  await expect
    .poll(async () => (await readActuals(request)).filter((entry) => entry.retraction !== true).length, {
      timeout: 20_000,
    })
    .toBeGreaterThanOrEqual(expectedActuals);
  await expectConnected(page);
  await skipRest(page);
  await page.getByRole("button", { name: /^finish session$/i }).click();
  await expect(page.getByRole("heading", { name: "Today", exact: true })).toBeVisible({ timeout: 15_000 });
  return new Set((await readActuals(request)).map((entry) => entry.loggedSessionId));
};

test.describe("each Set row suggests what was lifted last time", () => {
  test.beforeEach(async ({ request }) => {
    await resetServer(request);
  });

  test.afterEach(async ({ request, context }) => {
    await setOffline(context, false);
    await resetServer(request);
  });

  test("with no history, the row shows the plan's range and ✓ writes the top of it", async ({ page, request }) => {
    await startSession1(page);

    await expect(page.getByRole("button", { name: "reps — prescribed 8-10, tap to change", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "reps — prescribed 5, tap to change", exact: true })).toHaveCount(2);
    await expect(page.getByRole("button", { name: /suggested|from last time/ })).toHaveCount(0);
    await expect(page.getByText("8-10").first()).toBeVisible();
    await expect(page.getByText(OLD_HINT)).toHaveCount(0);

    // Bench Press is the third row.
    await tapConfirm(page, 2);
    await expect(page.getByRole("button", { name: /^reps — logged 10\b.*tap to change$/ })).toBeVisible();
    await expect.poll(async () => (await readActuals(request)).length, { timeout: 20_000 }).toBe(1);
    expect((await readActuals(request))[0]?.actual).toEqual({ reps: 10, load: 60 });
    await expect(page.getByText(OLD_HINT)).toHaveCount(0);
  });

  test("last time's 10 / 9 / 8 reps come back as 10 / 9 / 8, and an extra Set repeats the last of them", async ({
    page,
    request,
  }) => {
    // Workout 1: three Back Squat working Sets at 10, 9 and 8 reps.
    await startSession1(page);
    await addStraightSetToBackSquat(page);
    await typeMetric(page, repsCells(page).nth(0), "reps", "10");
    await typeMetric(page, repsCells(page).nth(1), "reps", "9");
    await typeMetric(page, repsCells(page).nth(2), "reps", "8");
    await expect(page.getByText(/3 of 7 sets logged/i)).toBeVisible();
    const workout1 = await finishWorkout(page, request, 3);

    // Workout 2: the plan prescribes two Back Squat Sets at 5. Each row
    // suggests ITS OWN last-time Set, not the plan and not set 1 repeated.
    await startSession1(page);
    await expect(repsCells(page).nth(0)).toHaveAccessibleName("reps — suggested 10, prescribed 5, tap to change");
    await expect(repsCells(page).nth(1)).toHaveAccessibleName("reps — suggested 9, prescribed 5, tap to change");
    await expect(repsCells(page).nth(0)).toContainText("10");
    await expect(repsCells(page).nth(1)).toContainText("9");
    // The load was lifted as prescribed, so there is nothing to call out.
    await expect(loadCells(page).nth(0)).toHaveAccessibleName("load — prescribed 100, tap to change");

    // A third working Set suggests last time's third; a fourth has no
    // counterpart and repeats last time's final one.
    await addStraightSetToBackSquat(page);
    await addStraightSetToBackSquat(page);
    await expect(repsCells(page).nth(2)).toHaveAccessibleName("reps — suggested 8, prescribed 5, tap to change");
    await expect(repsCells(page).nth(3)).toHaveAccessibleName("reps — suggested 8, prescribed 5, tap to change");
    await expect(page.getByText(OLD_HINT)).toHaveCount(0);

    // One tap per row, top to bottom. Logging exactly last time's numbers
    // must not drag the next row's suggestion along with it.
    await tapConfirm(page, 0);
    await expect(repsCells(page).nth(1)).toHaveAccessibleName("reps — suggested 9, prescribed 5, tap to change");
    await tapConfirm(page, 1);
    await expect(repsCells(page).nth(2)).toHaveAccessibleName("reps — suggested 8, prescribed 5, tap to change");
    await tapConfirm(page, 2);
    await tapConfirm(page, 3);

    await expect(repsCells(page).nth(0)).toHaveAccessibleName(/^reps — logged 10\b.*tap to change$/);
    await expect(repsCells(page).nth(1)).toHaveAccessibleName(/^reps — logged 9\b.*tap to change$/);
    await expect(page.getByText(OLD_HINT)).toHaveCount(0);

    await expect.poll(async () => (await actualsSince(request, workout1)).length, { timeout: 20_000 }).toBe(4);
    const written = (await actualsSince(request, workout1)).map((entry) => entry.actual);
    expect(written).toEqual([
      { reps: 10, load: 100 },
      { reps: 9, load: 100 },
      { reps: 8, load: 100 },
      { reps: 8, load: 100 },
    ]);
  });

  test("a range, an exact match and a drop: each suggests last time's own Set of its kind", async ({
    page,
    request,
  }) => {
    // Workout 1: Bench 9 reps (inside 8-10), Leg Press as prescribed (10 @
    // 80), its drop at 55.
    await startSession1(page);
    // Bench Press is reps cell 2; Leg Press reps cell 3; the drop is the
    // last load cell.
    await typeMetric(page, repsCells(page).nth(2), "reps", "9");
    await tapConfirm(page, 4);
    await typeMetric(page, loadCells(page).last(), "load", "55");
    await expect(page.getByText(/3 of 6 sets logged/i)).toBeVisible();
    const workout1 = await finishWorkout(page, request, 3);

    await startSession1(page);

    // Range: the suggestion replaces the range on the row.
    await expect(repsCells(page).nth(2)).toHaveAccessibleName("reps — suggested 9, prescribed 8-10, tap to change");
    await expect(repsCells(page).nth(2)).toContainText("9");
    await expect(repsCells(page).nth(2)).not.toContainText("8-10");
    await expect(loadCells(page).nth(2)).toHaveAccessibleName("load — prescribed 60, tap to change");

    // Exact prescription matched last time: the name stays the prescription.
    await expect(repsCells(page).nth(3)).toHaveAccessibleName("reps — prescribed 10, tap to change");
    await expect(loadCells(page).nth(3)).toHaveAccessibleName("load — prescribed 80, tap to change");

    // The drop suggests last time's DROP, not the working Set's 80.
    await expect(loadCells(page).last()).toHaveAccessibleName("load — suggested 55, prescribed <=60, tap to change");

    // Never done: Back Squat and Plank keep the plan.
    await expect(repsCells(page).nth(0)).toHaveAccessibleName("reps — prescribed 5, tap to change");
    await expect(page.getByRole("button", { name: "duration — prescribed 30-45, tap to change" })).toBeVisible();
    await expect(page.getByText(OLD_HINT)).toHaveCount(0);

    // One tap each writes exactly what was suggested.
    await tapConfirm(page, 2);
    await tapConfirm(page, 4);
    await tapConfirm(page, 5);
    await expect.poll(async () => (await actualsSince(request, workout1)).length, { timeout: 20_000 }).toBe(3);
    const written = await actualsSince(request, workout1);
    expect(written.map((entry) => entry.actual)).toEqual(
      expect.arrayContaining([{ reps: 9, load: 60 }, { reps: 10, load: 80 }, expect.objectContaining({ load: 55 })]),
    );
    expect(written.find((entry) => entry.setType === "drop")?.actual.load).toBe(55);
  });

  test("once a logged Set departs from last time, the next like Set suggests the departed value", async ({
    page,
    request,
  }) => {
    // Workout 1: Back Squat 10 and 9 reps at the prescribed 100.
    await startSession1(page);
    await typeMetric(page, repsCells(page).nth(0), "reps", "10");
    await typeMetric(page, repsCells(page).nth(1), "reps", "9");
    const workout1 = await finishWorkout(page, request, 2);

    // Workout 2: set 1 goes heavier than last time.
    await startSession1(page);
    await expect(loadCells(page).nth(1)).toHaveAccessibleName("load — prescribed 100, tap to change");
    await typeMetric(page, loadCells(page).nth(0), "load", "110");
    await expect(confirms(page).nth(0)).toHaveAccessibleName("Logged");

    // Set 2 now suggests the departed load; its reps, which set 1 did not
    // depart on, are still its own last-time 9.
    await expect(loadCells(page).nth(1)).toHaveAccessibleName("load — suggested 110, prescribed 100, tap to change");
    await expect(loadCells(page).nth(1)).toContainText("110");
    await expect(repsCells(page).nth(1)).toHaveAccessibleName("reps — suggested 9, prescribed 5, tap to change");
    await expect(page.getByText(OLD_HINT)).toHaveCount(0);

    await tapConfirm(page, 1);
    await expect.poll(async () => (await actualsSince(request, workout1)).length, { timeout: 20_000 }).toBe(2);
    const written = (await actualsSince(request, workout1)).map((entry) => entry.actual);
    expect(written).toEqual([
      { reps: 10, load: 110 },
      { reps: 9, load: 110 },
    ]);
  });

  test("a metric the plan leaves open is seeded from last time, shown as ~N", async ({ page, request }) => {
    const opened = await request.post(`${DEV_SERVER_HTTP_URL}/__test__/open-prescribed-load`);
    expect(opened.ok()).toBe(true);

    await startSession1(page);
    await typeMetric(page, loadCells(page).nth(0), "load", "82.5");
    await expect(confirms(page).nth(0)).toHaveAccessibleName("Logged");
    const workout1 = await finishWorkout(page, request, 1);

    await startSession1(page);
    await expect(loadCells(page).nth(0)).toHaveAccessibleName("load — seeded 82.5 from last time, tap to change");
    await expect(loadCells(page).nth(0)).toContainText("~82.5");
    // Set 2 had no counterpart last time, so it repeats last time's final Set.
    await expect(loadCells(page).nth(1)).toHaveAccessibleName("load — seeded 82.5 from last time, tap to change");
    // Reps matched the exact prescription: nothing to call out.
    await expect(repsCells(page).nth(0)).toHaveAccessibleName("reps — prescribed 5, tap to change");
    await expect(page.getByText(OLD_HINT)).toHaveCount(0);

    await tapConfirm(page, 0);
    await tapConfirm(page, 1);
    await expect.poll(async () => (await actualsSince(request, workout1)).length, { timeout: 20_000 }).toBe(2);
    expect((await actualsSince(request, workout1)).map((entry) => entry.actual)).toEqual([
      { reps: 5, load: 82.5 },
      { reps: 5, load: 82.5 },
    ]);
  });

  test("an exercise added mid-workout last time is suggested from last time when it is added again", async ({
    page,
    request,
  }) => {
    const name = "Barbell Pendlay Row";
    const picker = page.getByRole("dialog", { name: "Exercise catalog" });
    const search = page.getByRole("textbox", { name: "Search the catalog" });

    // Workout 1: add it from the library and log 8 reps at 40 on its first Set.
    await startSession1(page);
    await skipRest(page);
    await page.getByRole("button", { name: "+ Add exercise" }).click();
    await search.fill(name);
    await picker.getByRole("button", { name: new RegExp(`^${name}`) }).first().click();
    await page.getByRole("dialog", { name, exact: true }).getByRole("button", { name: "Add to workout" }).click();
    await expect(page.getByRole("heading", { level: 2, name, exact: true })).toBeVisible();
    // Its rows are the last three on the surface.
    await typeMetric(page, repsCells(page).nth((await repsCells(page).count()) - 3), "reps", "8");
    await typeMetric(page, loadCells(page).nth((await loadCells(page).count()) - 3), "load", "40");
    await expect
      .poll(
        async () =>
          (await readActuals(request)).some((entry) => entry.actual.reps === 8 && entry.actual.load === 40),
        { timeout: 20_000 },
      )
      .toBe(true);
    const workout1 = await finishWorkout(page, request, 1);

    // Workout 2: add it again — it is one of YOUR exercises now, one tap.
    await startSession1(page);
    await page.getByRole("button", { name: "+ Add exercise" }).click();
    await picker.getByRole("button", { name: new RegExp(`^${name}(?! upper back)`) }).click();
    await expect(page.getByRole("heading", { level: 2, name, exact: true })).toBeVisible();
    await expect(confirms(page)).toHaveCount(9);

    // The plan holds no prescription for it, so each metric is SEEDED from
    // last time: set 1 from last time's set 1, sets 2 and 3 repeating it.
    const reps = repsCells(page);
    const loads = loadCells(page);
    const repsTotal = await reps.count();
    const loadTotal = await loads.count();
    for (const offset of [3, 2, 1]) {
      await expect(reps.nth(repsTotal - offset)).toHaveAccessibleName("reps — seeded 8 from last time, tap to change");
      await expect(loads.nth(loadTotal - offset)).toHaveAccessibleName("load — seeded 40 from last time, tap to change");
    }
    await expect(loads.nth(loadTotal - 3)).toContainText("~40");
    await expect(page.getByText(OLD_HINT)).toHaveCount(0);

    await tapConfirm(page, 6);
    await expect.poll(async () => (await actualsSince(request, workout1)).length, { timeout: 20_000 }).toBe(1);
    expect((await actualsSince(request, workout1))[0]?.actual).toEqual({ reps: 8, load: 40 });
  });
});

/**
 * "Last time" gives way to the plan when the plan has moved a number since.
 *
 * Last time is a suggestion about what the user CAN do; an accepted coach
 * Proposal is a decision about what they SHOULD do next. When a Proposal
 * changes a prescription after the last workout, the row shows the plan's new
 * number for the changed metric — and one tap writes it — while metrics the
 * change did not touch keep suggesting last time.
 *
 * The seeded Proposal is the lever, accepted through Today exactly as a user
 * would: "Increase back squat working load by 2.5kg." (100 → 102.5 kg, see
 * a-proposal-carries-its-change.spec.ts). Two things make the journey fiddly,
 * and both are handled by what a user sees, not by a hook:
 *
 * - Finishing workout 1 runs a canned session review, which puts its own
 *   Proposal ("Add a fourth back squat working set…") on Today in front of the
 *   seeded one. Today shows one pending Proposal at a time, so the review's is
 *   dismissed until the seeded one is the card on screen — and Accept is only
 *   ever pressed inside the card carrying the seeded summary.
 * - The accept is checked at the server (`/__test__/plan`): Back Squat's two
 *   Sets at 102.5, still two of them. A red row assertion can then never be
 *   blamed on the accept not having happened.
 */

const SEEDED_PROPOSAL = "Increase back squat working load by 2.5kg.";

interface PlanTargets {
  readonly plan: {
    readonly sessions: ReadonlyArray<{
      readonly blocks: ReadonlyArray<{
        readonly entries: ReadonlyArray<{
          readonly id: string;
          readonly sets: ReadonlyArray<{ readonly target: Record<string, unknown> }>;
        }>;
      }>;
    }>;
  };
}

/** Back Squat's prescribed targets (entry-1 in the seed), as plain JSON. */
const backSquatTargets = async (request: APIRequestContext): Promise<ReadonlyArray<string>> => {
  const response = await request.get(`${DEV_SERVER_HTTP_URL}/__test__/plan`);
  expect(response.ok()).toBe(true);
  const body = (await response.json()) as PlanTargets;
  const entry = body.plan.sessions
    .flatMap((session) => session.blocks.flatMap((block) => block.entries))
    .find((candidate) => candidate.id === "entry-1");
  return (entry?.sets ?? []).map((set) => JSON.stringify(set.target));
};

const SQUAT_AT = (load: number) => JSON.stringify({ reps: { min: 5, max: 5 }, load: { min: load, max: load } });

/** On Today: clear any newer Proposal off the top until the seeded one shows, then accept it. */
const acceptSeededProposal = async (page: Page, request: APIRequestContext) => {
  await page.goto("/");
  await expectConnected(page);
  await expect(page.getByRole("heading", { name: "Today", exact: true })).toBeVisible();

  const seeded = page.getByRole("article").filter({ hasText: SEEDED_PROPOSAL });
  const other = page
    .getByRole("article")
    .filter({ hasNotText: SEEDED_PROPOSAL })
    .filter({ has: page.getByRole("button", { name: "Dismiss", exact: true }) });

  // Retried as a whole rather than stepped: a dismissed card lingers for a
  // moment before the next one replaces it, and a click aimed at a card that
  // is on its way out must not wait on it forever.
  await expect(async () => {
    if (await seeded.isVisible().catch(() => false)) {
      return;
    }
    const card = other.first();
    if (await card.isVisible().catch(() => false)) {
      await card.getByRole("button", { name: "Dismiss", exact: true }).click({ timeout: 2_000 });
    }
    await expect(seeded).toBeVisible({ timeout: 3_000 });
  }).toPass({ timeout: 30_000 });

  await seeded.getByRole("button", { name: /^Accept/ }).click();

  await expect.poll(() => backSquatTargets(request), { timeout: 15_000 }).toEqual([SQUAT_AT(102.5), SQUAT_AT(102.5)]);
};

/**
 * Workout 1 at the old 100 kg — set 1 at 6 reps, set 2 at the prescribed 5 —
 * finished; then the seeded Proposal is accepted. Returns workout 1's ids.
 */
const lastTimeThenPlanMoves = async (page: Page, request: APIRequestContext) => {
  expect(await backSquatTargets(request)).toEqual([SQUAT_AT(100), SQUAT_AT(100)]);

  await startSession1(page);
  await typeMetric(page, repsCells(page).nth(0), "reps", "6");
  // Typed, not tapped: set 1's departure from the plan (6 against 5) carries
  // to set 2 as its suggestion within the workout, so a tap here would write 6.
  await typeMetric(page, repsCells(page).nth(1), "reps", "5");
  await expect(page.getByText(/2 of 6 sets logged/i)).toBeVisible();
  await expect
    .poll(async () => (await readActuals(request)).map((entry) => entry.actual), { timeout: 20_000 })
    .toEqual(
      expect.arrayContaining([
        { reps: 6, load: 100 },
        { reps: 5, load: 100 },
      ]),
    );
  const workout1 = await finishWorkout(page, request, 2);

  await acceptSeededProposal(page, request);
  return workout1;
};

test.describe("last time gives way to the plan when the plan has moved since", () => {
  test.beforeEach(async ({ request }) => {
    await resetServer(request);
  });

  test.afterEach(async ({ request, context }) => {
    await setOffline(context, false);
    await resetServer(request);
  });

  test("an accepted load change shows the plan's new load, last time's reps stay, and one tap writes both", async ({
    page,
    request,
  }) => {
    const workout1 = await lastTimeThenPlanMoves(page, request);

    await startSession1(page);

    // The changed metric: the plan's new number, not last time's 100.
    await expect(loadCells(page).nth(0)).toHaveAccessibleName("load — prescribed 102.5, tap to change");
    await expect(loadCells(page).nth(1)).toHaveAccessibleName("load — prescribed 102.5, tap to change");
    await expect(loadCells(page).nth(0)).toContainText("102.5");
    await expect(loadCells(page).nth(1)).toContainText("102.5");

    // The untouched metric: still last time's reps, per Set.
    await expect(repsCells(page).nth(0)).toHaveAccessibleName("reps — suggested 6, prescribed 5, tap to change");
    await expect(repsCells(page).nth(1)).toHaveAccessibleName("reps — prescribed 5, tap to change");
    await expect(page.getByText(OLD_HINT)).toHaveCount(0);

    await tapConfirm(page, 0);
    await expect.poll(async () => (await actualsSince(request, workout1)).length, { timeout: 20_000 }).toBe(1);
    expect((await actualsSince(request, workout1))[0]?.actual).toEqual({ reps: 6, load: 102.5 });
  });

  test("a heavier load typed on top of the new prescription still carries to the next Set", async ({
    page,
    request,
  }) => {
    const workout1 = await lastTimeThenPlanMoves(page, request);

    await startSession1(page);
    await expect(loadCells(page).nth(1)).toHaveAccessibleName("load — prescribed 102.5, tap to change");

    await typeMetric(page, loadCells(page).nth(0), "load", "105");
    await expect(confirms(page).nth(0)).toHaveAccessibleName("Logged");

    await expect(loadCells(page).nth(1)).toHaveAccessibleName("load — suggested 105, prescribed 102.5, tap to change");
    await expect(loadCells(page).nth(1)).toContainText("105");
    await expect(repsCells(page).nth(1)).toHaveAccessibleName("reps — prescribed 5, tap to change");
    await expect(page.getByText(OLD_HINT)).toHaveCount(0);

    await tapConfirm(page, 1);
    await expect.poll(async () => (await actualsSince(request, workout1)).length, { timeout: 20_000 }).toBe(2);
    expect((await actualsSince(request, workout1)).map((entry) => entry.actual)).toEqual([
      { reps: 6, load: 105 },
      { reps: 5, load: 105 },
    ]);
  });
});
