import { expect, test, type APIRequestContext, type Locator, type Page } from "@playwright/test";

import { STRIP, expectConnected, resetServer, setOffline } from "../driver.ts";

const DEV_SERVER_HTTP_URL = "http://127.0.0.1:4010";

/**
 * "Next up" on Today (ADR 0023): a derived rotation hint, not a schedule.
 *
 * Today lists the Plan's Prescribed Sessions under "Pick today's session". The
 * feature adds ONE hero button above that list naming the session after the one
 * the most recently finished workout came from, wrapping from the last back to
 * the first. Every rule the ADR states that a user can see is a test below:
 *
 * - **No history → the first session.** A fresh rotation starts at the top.
 * - **Finishing advances it.** Finish a workout of A and come back to Today:
 *   next up is B. Observed on the Today a user is *returned to* by Finish, not
 *   on a fresh navigation, because that is the moment the hint is for.
 * - **The last session wraps to the first.** Stopping at the end was rejected
 *   in the ADR precisely because the hint would vanish when it is needed.
 * - **A cancelled workout does not count.** Proved where it can make a
 *   difference: with A finished (next up B), starting B and cancelling it must
 *   leave next up on B. A cancelled workout that *did* count would move it to C.
 * - **An empty session is skipped.** It cannot be started, so it is never next
 *   up; the walk continues past it.
 * - **In flight, Resume owns the slot.** The two heroes are mutually exclusive.
 * - **Reordering moves it, live.** Position is read from the Plan, never stored.
 * - **A deleted session is looked past.** If the newest finished workout's
 *   session is gone, the walk anchors on the newest finished one that remains.
 * - **Offline, the hero is disabled like the rows.**
 *
 * ## Setup, and why it goes through the Plan editor
 *
 * The seed holds one Prescribed Session (`Session 1`, four exercises) and the
 * control channel has no lever for authoring more — so the three-session Plans
 * these journeys need are authored the way a user would: Plan → rename the seed
 * → `+ New prescribed session` → rename → add an exercise from the catalog.
 * Distinct names (Alpha / Bravo / Charlie) keep every name-match unambiguous;
 * the default `Session N` names would let `/Session 1/` match a `Session 10`.
 * `GET /__test__/plan` is read back after authoring so a setup failure reads as
 * a setup failure, never as a missing hero.
 *
 * ## Handles
 *
 * - The hero is the one button whose accessible name contains `next up`
 *   (small-caps in CSS, so matched case-insensitively). Its name also carries
 *   the session title and `Start`.
 * - A list row is the whole row as a button, named `<title> <summary> Start`
 *   (`Offline` with the link down). Rows are matched ANCHORED on the title so
 *   the hero (`next up <title> …`) and Resume (`… Resume — <title> …`) — whose
 *   names also contain the title — are never mistaken for a row.
 * - A workout is finished with one Set logged rather than none, so "finished"
 *   is unambiguously a real workout and not a degenerate zero-set close.
 */

const SEEDED_SESSION_TITLE = "Session 1";

/** Library exercises used to give the authored sessions something to run. */
const EXERCISE = {
  bravo: "Barbell Deadlift",
  charlie: "Trap Bar Deadlift",
} as const;

// ---------------------------------------------------------------------------
// Locators
// ---------------------------------------------------------------------------

const todayHeading = (page: Page) => page.getByRole("heading", { name: "Today", exact: true });
const nextUpHero = (page: Page) => page.getByRole("button", { name: /next up/i });
const resumeHero = (page: Page) => page.getByRole("button", { name: /Resume/i });
const backToToday = (page: Page) => page.getByRole("button", { name: "Back to Today" });
const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** A list row on Today, by title (anchored, so never the hero or Resume). */
const sessionRow = (page: Page, title: string) =>
  page.getByRole("button", { name: new RegExp(`^${escape(title)}\\b`) });

// ---------------------------------------------------------------------------
// Server reads
// ---------------------------------------------------------------------------

interface PlanShape {
  readonly sessions: ReadonlyArray<{
    readonly name: string;
    readonly blocks: ReadonlyArray<{ readonly entries: ReadonlyArray<unknown> }>;
  }>;
}

const readPlan = async (request: APIRequestContext): Promise<PlanShape> => {
  const response = await request.get(`${DEV_SERVER_HTTP_URL}/__test__/plan`);
  expect(response.ok()).toBe(true);
  return ((await response.json()) as { readonly plan: PlanShape }).plan;
};

/** The Plan as `name:entryCount` per session, in authored order. */
const planOutline = async (request: APIRequestContext): Promise<ReadonlyArray<string>> =>
  (await readPlan(request)).sessions.map(
    (session) =>
      `${session.name}:${session.blocks.reduce((sum, block) => sum + block.entries.length, 0)}`,
  );

const readActualsCount = async (request: APIRequestContext): Promise<number> => {
  const response = await request.get(`${DEV_SERVER_HTTP_URL}/__test__/logged-actuals`);
  expect(response.ok()).toBe(true);
  return ((await response.json()) as { readonly actuals: ReadonlyArray<unknown> }).actuals.length;
};

// ---------------------------------------------------------------------------
// Authoring the Plan through the Plan editor
// ---------------------------------------------------------------------------

const moreFor = (page: Page, name: string) =>
  page.getByRole("button", { name: `More for ${name}`, exact: true });

async function openPlan(page: Page): Promise<void> {
  await page.goto("/plan");
  await expectConnected(page);
  await expect(page.getByRole("heading", { name: "Plan", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: /^More for / }).first()).toBeVisible({
    timeout: 30_000,
  });
}

/** Session ⋯ → Rename → type → Save name. */
async function renameVia(page: Page, menu: Locator, to: string): Promise<void> {
  await menu.click();
  await page.getByRole("button", { name: "Rename", exact: true }).click();
  await page.getByRole("textbox").fill(to);
  await page.getByRole("button", { name: "Save name" }).click();
  await expect(moreFor(page, to)).toBeVisible({ timeout: 15_000 });
}

/** Add a library exercise to the session being edited: catalog → preview → Add to session. */
async function addLibraryExercise(page: Page, exercise: string): Promise<void> {
  await page.getByRole("button", { name: "Add exercise from catalog" }).click();
  await page.getByPlaceholder("Search the catalog").fill(exercise);
  await page.getByRole("button", { name: new RegExp(`^${escape(exercise)} `) }).click();
  await page.getByRole("button", { name: "Add to session" }).click();
  await expect(moreFor(page, exercise)).toBeVisible({ timeout: 15_000 });
}

/** `+ New prescribed session`, renamed, with an optional exercise. */
async function addSession(
  page: Page,
  request: APIRequestContext,
  name: string,
  exercise?: string,
): Promise<void> {
  const before = (await readPlan(request)).sessions.length;
  await page.getByRole("button", { name: "New prescribed session" }).click();
  await expect
    .poll(async () => (await readPlan(request)).sessions.length, { timeout: 15_000 })
    .toBe(before + 1);
  // The new session is the one being edited; its row is the one marked so,
  // and it is the newest row in the list.
  const editingRow = page.getByRole("listitem").filter({ hasText: /editing/i });
  await expect(editingRow).toHaveCount(1);
  await expect(editingRow).toContainText(/empty/i);
  await renameVia(page, editingRow.getByRole("button", { name: /^More for / }), name);
  if (exercise !== undefined) await addLibraryExercise(page, exercise);
}

/**
 * Author a three-session Plan: Alpha (the renamed seed, four exercises), Bravo
 * and Charlie. `emptyBravo` leaves Bravo with no exercises.
 */
async function authorAlphaBravoCharlie(
  page: Page,
  request: APIRequestContext,
  options: { readonly emptyBravo?: boolean } = {},
): Promise<void> {
  await openPlan(page);
  await renameVia(page, moreFor(page, SEEDED_SESSION_TITLE), "Alpha");
  await addSession(page, request, "Bravo", options.emptyBravo === true ? undefined : EXERCISE.bravo);
  await addSession(page, request, "Charlie", EXERCISE.charlie);

  // Setup is proven on the server before any Today assertion, so a broken
  // authoring step cannot masquerade as a missing hero.
  await expect
    .poll(async () => planOutline(request), { timeout: 15_000 })
    .toEqual(["Alpha:4", options.emptyBravo === true ? "Bravo:0" : "Bravo:1", "Charlie:1"]);
}

// ---------------------------------------------------------------------------
// Today and Logging
// ---------------------------------------------------------------------------

async function openToday(page: Page): Promise<void> {
  await page.goto("/");
  await expectConnected(page);
  await expect(todayHeading(page)).toBeVisible();
}

/**
 * The hero names exactly `title`, and none of the other sessions. Its name is
 * read as a whole so a hero that names two sessions cannot pass.
 */
async function expectNextUp(page: Page, title: string, others: ReadonlyArray<string>): Promise<void> {
  const hero = nextUpHero(page);
  await expect(hero).toHaveCount(1, { timeout: 15_000 });
  await expect(hero).toHaveAccessibleName(new RegExp(`next up.*\\b${escape(title)}\\b`, "i"), {
    timeout: 15_000,
  });
  await expect(hero).toHaveAccessibleName(/start/i);
  for (const other of others) {
    await expect(hero).not.toHaveAccessibleName(new RegExp(`\\b${escape(other)}\\b`));
  }
  // It sits above the list, not in it: the list keeps every session in
  // authored order beneath it.
  const heroBox = await hero.boundingBox();
  const listHeadingBox = await page
    .getByRole("heading", { name: /pick today's session/i })
    .boundingBox();
  expect(heroBox).not.toBeNull();
  expect(listHeadingBox).not.toBeNull();
  expect(heroBox!.y).toBeLessThan(listHeadingBox!.y);
}

/** Start a session from its Today row, landing on Logging. */
async function startFromRow(page: Page, title: string): Promise<void> {
  await sessionRow(page, title).click();
  await expect(backToToday(page)).toBeVisible({ timeout: 20_000 });
  await expect(page.getByRole("heading", { name: title, level: 1 })).toBeVisible();
}

/**
 * Log the first Set, wait for it to reach the server, then Finish. Lands back
 * on Today — which Finish does on its own; no navigation here.
 */
async function logOneSetAndFinish(page: Page, request: APIRequestContext): Promise<void> {
  const before = await readActualsCount(request);
  await page.getByRole("button", { name: "Log as prescribed" }).first().click();
  const skip = page.getByRole("button", { name: /^skip$/i }).first();
  if (await skip.isVisible().catch(() => false)) await skip.click();
  // Finishing with a Set still queued in the outbox is a known separate gap
  // (cancel-and-history-a-session.spec.ts); this flow is about next up.
  await expect.poll(async () => readActualsCount(request), { timeout: 20_000 }).toBe(before + 1);

  await page.getByRole("button", { name: /^finish session$/i }).click();
  await expect(todayHeading(page)).toBeVisible({ timeout: 15_000 });
  await expect(resumeHero(page)).toHaveCount(0);
}

/** Start a session from its row and finish it, returning to Today. */
async function runWorkout(page: Page, request: APIRequestContext, title: string): Promise<void> {
  await startFromRow(page, title);
  await logOneSetAndFinish(page, request);
}

// ---------------------------------------------------------------------------
// Journeys
// ---------------------------------------------------------------------------

test.describe("next up on Today", () => {
  test.beforeEach(async ({ request }) => {
    await resetServer(request);
  });

  test.afterEach(async ({ request, context }) => {
    await setOffline(context, false);
    await resetServer(request);
  });

  test("with no finished workouts, next up is the first session, above an unchanged list", async ({
    page,
    request,
  }) => {
    await authorAlphaBravoCharlie(page, request);
    await openToday(page);

    await expectNextUp(page, "Alpha", ["Bravo", "Charlie"]);

    // The list below is untouched: every session, in authored order, each
    // still startable on its own.
    for (const title of ["Alpha", "Bravo", "Charlie"]) {
      await expect(sessionRow(page, title)).toBeEnabled();
      await expect(sessionRow(page, title)).toHaveAccessibleName(/start/i);
    }
    const rowNames = await page
      .getByRole("listitem")
      .getByRole("button", { name: /^(Alpha|Bravo|Charlie)\b/ })
      .allTextContents();
    expect(rowNames.map((text) => text.match(/^(Alpha|Bravo|Charlie)/)?.[1])).toEqual([
      "Alpha",
      "Bravo",
      "Charlie",
    ]);
  });

  test("tapping next up starts that session, exactly as its row would", async ({ page, request }) => {
    await authorAlphaBravoCharlie(page, request);
    await openToday(page);
    await expectNextUp(page, "Alpha", ["Bravo", "Charlie"]);

    await nextUpHero(page).click();

    await expect(backToToday(page)).toBeVisible({ timeout: 20_000 });
    await expect(page.getByRole("heading", { name: "Alpha", level: 1 })).toBeVisible();
    // Alpha is the renamed seed: six prescribed sets, none logged.
    await expect(page.getByText(/0\s*\/\s*6/)).toBeVisible();
  });

  test("finishing a workout of the first session makes the second next up", async ({ page, request }) => {
    await authorAlphaBravoCharlie(page, request);
    await openToday(page);

    await runWorkout(page, request, "Alpha");

    // On the Today that Finish returned us to — not a fresh load.
    await expectNextUp(page, "Bravo", ["Alpha", "Charlie"]);

    // And it is a server fact, not a client-side memory: a reload agrees.
    await openToday(page);
    await expectNextUp(page, "Bravo", ["Alpha", "Charlie"]);
  });

  test("finishing the last session wraps next up back to the first", async ({ page, request }) => {
    test.setTimeout(120_000);
    await authorAlphaBravoCharlie(page, request);
    await openToday(page);

    await runWorkout(page, request, "Alpha");
    await expectNextUp(page, "Bravo", ["Alpha", "Charlie"]);
    await runWorkout(page, request, "Bravo");
    await expectNextUp(page, "Charlie", ["Alpha", "Bravo"]);
    await runWorkout(page, request, "Charlie");

    await expectNextUp(page, "Alpha", ["Bravo", "Charlie"]);
  });

  test("it follows the most recent workout, not the rotation: picking off-rotation moves it", async ({
    page,
    request,
  }) => {
    await authorAlphaBravoCharlie(page, request);
    await openToday(page);

    // Next up says Alpha; the user picks Bravo from the list instead.
    await expectNextUp(page, "Alpha", ["Bravo", "Charlie"]);
    await runWorkout(page, request, "Bravo");

    await expectNextUp(page, "Charlie", ["Alpha", "Bravo"]);
  });

  test("a cancelled workout does not advance next up", async ({ page, request }) => {
    test.setTimeout(90_000);
    await authorAlphaBravoCharlie(page, request);
    await openToday(page);

    await runWorkout(page, request, "Alpha");
    await expectNextUp(page, "Bravo", ["Alpha", "Charlie"]);

    // Start Bravo, then cancel it with nothing logged.
    await startFromRow(page, "Bravo");
    await page.getByRole("button", { name: /^cancel$/i }).click();
    await page.getByRole("button", { name: /^cancel session$/i }).click();
    await expect(todayHeading(page)).toBeVisible({ timeout: 15_000 });
    await expect(resumeHero(page)).toHaveCount(0);

    // Had the cancelled Bravo counted, next up would now be Charlie.
    await expectNextUp(page, "Bravo", ["Alpha", "Charlie"]);
    await openToday(page);
    await expectNextUp(page, "Bravo", ["Alpha", "Charlie"]);
  });

  test("an empty session is skipped: after the first, next up passes over it", async ({
    page,
    request,
  }) => {
    await authorAlphaBravoCharlie(page, request, { emptyBravo: true });
    await openToday(page);

    // The empty session is listed but unstartable, as before this feature.
    await expect(sessionRow(page, "Bravo")).toBeDisabled();
    await expectNextUp(page, "Alpha", ["Bravo", "Charlie"]);

    await runWorkout(page, request, "Alpha");

    await expectNextUp(page, "Charlie", ["Alpha", "Bravo"]);
  });

  test("while a workout is in flight, Resume holds the slot and next up is not shown", async ({
    page,
    request,
  }) => {
    await authorAlphaBravoCharlie(page, request);
    await openToday(page);
    await expectNextUp(page, "Alpha", ["Bravo", "Charlie"]);

    await startFromRow(page, "Alpha");
    await backToToday(page).click();
    await expect(todayHeading(page)).toBeVisible();

    await expect(resumeHero(page)).toBeVisible({ timeout: 15_000 });
    await expect(resumeHero(page)).toHaveAccessibleName(/Resume — Alpha/);
    await expect(nextUpHero(page)).toHaveCount(0);

    // Still true from a fresh load: the in-flight workout is a server fact.
    await openToday(page);
    await expect(resumeHero(page)).toBeVisible({ timeout: 15_000 });
    await expect(nextUpHero(page)).toHaveCount(0);

    // Finishing it hands the slot back to next up — now pointing past Alpha.
    await resumeHero(page).click();
    await expect(backToToday(page)).toBeVisible({ timeout: 20_000 });
    await logOneSetAndFinish(page, request);
    await expectNextUp(page, "Bravo", ["Alpha", "Charlie"]);
  });

  test("reordering the Plan moves next up immediately", async ({ page, request }) => {
    await authorAlphaBravoCharlie(page, request);
    await openToday(page);

    await runWorkout(page, request, "Alpha");
    await expectNextUp(page, "Bravo", ["Alpha", "Charlie"]);

    // Plan → Reorder → step Charlie up above Bravo: Alpha, Charlie, Bravo.
    await openPlan(page);
    await page.getByRole("button", { name: "Reorder", exact: true }).click();
    await page.getByRole("button", { name: "Move Charlie up" }).click();
    await page.getByRole("button", { name: "Done", exact: true }).click();
    await expect
      .poll(async () => planOutline(request), { timeout: 15_000 })
      .toEqual(["Alpha:4", "Charlie:1", "Bravo:1"]);

    await openToday(page);
    await expectNextUp(page, "Charlie", ["Alpha", "Bravo"]);
  });

  test("when the newest workout's session is deleted, next up anchors on the newest one still in the Plan", async ({
    page,
    request,
  }) => {
    test.setTimeout(90_000);
    await authorAlphaBravoCharlie(page, request);
    await openToday(page);

    await runWorkout(page, request, "Alpha");
    await runWorkout(page, request, "Bravo");
    await expectNextUp(page, "Charlie", ["Alpha", "Bravo"]);

    // Delete Bravo. The newest finished workout's session is gone, so the walk
    // anchors on Alpha (still in the Plan) and the session after it — now
    // Charlie, since Bravo no longer sits between them.
    await openPlan(page);
    await moreFor(page, "Bravo").click();
    await page.getByRole("button", { name: /Delete session/ }).click();
    const confirm = page.getByRole("button", { name: /^delete( session)?$/i });
    if (await confirm.isVisible({ timeout: 2_000 }).catch(() => false)) await confirm.click();
    await expect
      .poll(async () => planOutline(request), { timeout: 15_000 })
      .toEqual(["Alpha:4", "Charlie:1"]);

    await openToday(page);
    await expectNextUp(page, "Charlie", ["Alpha", "Bravo"]);
  });

  test("when every session is empty there is nothing to suggest, and no hero", async ({
    page,
    request,
  }) => {
    // A Plan holding only an empty session: add one, then delete the seed.
    await openPlan(page);
    await addSession(page, request, "Bravo");
    await moreFor(page, SEEDED_SESSION_TITLE).click();
    await page.getByRole("button", { name: /Delete session/ }).click();
    const confirm = page.getByRole("button", { name: /^delete( session)?$/i });
    if (await confirm.isVisible({ timeout: 2_000 }).catch(() => false)) await confirm.click();
    await expect.poll(async () => planOutline(request), { timeout: 15_000 }).toEqual(["Bravo:0"]);

    await openToday(page);
    await expect(sessionRow(page, "Bravo")).toBeVisible({ timeout: 15_000 });
    await expect(sessionRow(page, "Bravo")).toBeDisabled();
    await expect(nextUpHero(page)).toHaveCount(0);
  });

  test("offline, next up is disabled exactly like the rows", async ({ page, context, request }) => {
    await authorAlphaBravoCharlie(page, request);
    await openToday(page);
    await expectNextUp(page, "Alpha", ["Bravo", "Charlie"]);
    await expect(nextUpHero(page)).toBeEnabled();

    await setOffline(context, true);
    await expect(page.getByText(STRIP.notConnected).first()).toBeVisible({ timeout: 20_000 });

    // The rows' Offline treatment belongs to a Plan read from the durable
    // cache, i.e. to a Today drawn with the link already down. A dev build has
    // no service worker, so a hard reload offline is a dead page; leaving
    // Today and coming back through the app's own navigation is how a user
    // gets a Today drawn offline.
    await page.getByRole("link", { name: /Plan/ }).click();
    await expect(page).toHaveURL(/\/plan$/);
    await expect(todayHeading(page)).toHaveCount(0);
    await page.getByRole("link", { name: /Today/ }).click();
    await expect(todayHeading(page)).toBeVisible();

    // The rows' settled offline treatment: `Offline` in place of `Start`, and
    // unstartable.
    await expect(sessionRow(page, "Alpha")).toHaveAccessibleName(/offline/i, { timeout: 20_000 });
    await expect(sessionRow(page, "Alpha")).toBeDisabled();

    // The hero follows the same rule (it may still name the session).
    const hero = nextUpHero(page);
    if ((await hero.count()) > 0) {
      await expect(hero).toHaveAccessibleName(/\bAlpha\b/);
      await expect(hero).toBeDisabled();
      await expect(hero).not.toHaveAccessibleName(/\bstart\b/i);
    }
  });
});
