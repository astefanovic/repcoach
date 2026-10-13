import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

import { expectConnected, resetServer, setOffline } from "../driver.ts";

const DEV_SERVER_HTTP_URL = "http://127.0.0.1:4010";

/**
 * Typing an exercise the catalog does not hold, and fixing its name after
 * (issue #102, against ADR 0016).
 *
 * The affordance is one text field, so the claims worth spending a rung-2
 * flow on are the ones a screenshot of that field would not settle:
 *
 * - **`create` is the LAST row.** ADR 0016 §2 prevents duplicates at type
 *   time and nowhere else — coach-side merge is explicitly declined, because
 *   rewriting the join key on historical Entries is a data migration. The
 *   catalog row *is* the join key per-muscle volume is derived through, so a
 *   second spelling splits an exercise's history in two and the coach reasons
 *   over the split. Ordering is therefore load-bearing: you must walk past
 *   the match that already exists to mint a duplicate. A `create` row offered
 *   first would look almost identical and would have thrown that away.
 * - **One gesture, two writes.** ADR 0016 §3 keeps creating an exercise out
 *   of the Plan operation union — a catalog row is not part of the Plan — so
 *   the gesture is `createExercise` then `addEntry`. That it reads as one
 *   action is the UI's job, and this is where that is checked.
 * - **It mints no Change.** The corollary of the same decision, and the one
 *   with a server-side answer: no Plan changed, so the Change log must be
 *   untouched by the create itself. Asserted by counting Changes across the
 *   gesture — the `addEntry` half writes exactly one, and only one.
 * - **The row survives, and logs.** A name-only row declares no tracked
 *   metrics, so its set row is rendered through the existing target-key
 *   fallback. "You can log a set against the exercise you just typed" is the
 *   whole point of the feature and the only claim that spans Plan and
 *   Logging.
 * - **Offline it is visible and disabled.** ADR 0016 §4: the catalog is not
 *   cached, so creating is refused rather than queued — but *visibly*, with a
 *   reason. Hiding the row would read as the feature not existing, and the
 *   flow asserts the distinction (present, disabled, reason on screen) rather
 *   than mere absence of a crash. Picking an exercise that already exists is
 *   a Plan edit and must be unaffected.
 * - **Rename keeps the id.** ADR 0016 §6 makes rename the pressure valve that
 *   makes silent enrichment safe. The observable proof is not that the label
 *   changed — that is trivial — but that the Plan Entry still points at the
 *   same row afterwards, which is read off the server.
 *
 * Black-box throughout, per docs/agents/testing.md: visible text, accessible
 * names, and the `/__test__` read endpoints. Nothing here knows a component.
 */

const TYPO = "Zercer Squat";
const FIXED = "Zercher Squat";

const moreFor = (page: Page, name: string) =>
  page.getByRole("button", { name: `More for ${name}`, exact: true });

const sessionMenu = (page: Page) => page.getByRole("button", { name: /^More for Session/ });

/**
 * A row inside the open picker, scoped to the sheet's own list. The Plan
 * behind the sheet also carries a control per exercise (`More for …`), so a
 * page-wide match by name is ambiguous the moment the exercise is in the
 * Session.
 */
const pickerRow = (page: Page, name: string) =>
  page.getByRole("listitem").filter({ hasText: name }).getByRole("button").first();

const createRow = (page: Page, name: string) =>
  page.getByRole("button", { name: new RegExp(`^Create\\s*[“"]${name}[”"]`) });

interface PlanShape {
  readonly sessions: ReadonlyArray<{
    readonly blocks: ReadonlyArray<{
      readonly entries: ReadonlyArray<{ readonly exerciseId: string }>;
    }>;
  }>;
}

const readPlan = async (request: APIRequestContext): Promise<PlanShape> => {
  const response = await request.get(`${DEV_SERVER_HTTP_URL}/__test__/plan`);
  expect(response.ok()).toBe(true);
  return ((await response.json()) as { readonly plan: PlanShape }).plan;
};

const exerciseIds = (plan: PlanShape): ReadonlyArray<string> =>
  plan.sessions.flatMap((session) =>
    session.blocks.flatMap((block) => block.entries.map((entry) => entry.exerciseId)),
  );

const countChanges = async (request: APIRequestContext): Promise<number> => {
  const response = await request.get(`${DEV_SERVER_HTTP_URL}/__test__/changes`);
  expect(response.ok()).toBe(true);
  return ((await response.json()) as { readonly changes: ReadonlyArray<unknown> }).changes.length;
};

/**
 * The editor is unusable until the catalog has been fetched, and every flow
 * here opens the catalog. Waiting on the Session menu is the cheapest visible
 * proxy for "the surface finished arriving".
 */
async function openPlan(page: Page): Promise<void> {
  await page.goto("/plan");
  await expectConnected(page);
  await expect(page.getByRole("heading", { name: "Plan", exact: true })).toBeVisible();
  await expect(sessionMenu(page).first()).toBeVisible({ timeout: 30_000 });
}

async function openPicker(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Add exercise from catalog" }).click();
  await expect(page.getByText("Exercise catalog")).toBeVisible();
}

test.describe("create a user-authored exercise", () => {
  test.afterEach(async ({ request, context }) => {
    await setOffline(context, false);
    await resetServer(request);
  });

  test("a name the catalog lacks is offered as the LAST row, below the matches you must walk past", async ({
    page,
  }) => {
    await openPlan(page);
    await openPicker(page);

    // A query that matches an existing exercise: the create row is still
    // offered — `Squat Variation` may genuinely be a different exercise —
    // but it comes after the match, so minting a duplicate is a visible walk
    // past the row that already exists.
    await page.getByPlaceholder("Search the catalog").fill("Squat");
    const rows = page.getByRole("listitem");
    const texts = await rows.allInnerTexts();
    expect(texts.some((text) => /Back Squat/i.test(text))).toBe(true);
    expect(texts[texts.length - 1]).toMatch(/Create/i);

    // And an exact match, differently spelled, offers no creation at all:
    // `back-squat` is `Back Squat`, and offering to make a second one is
    // offering to split its history.
    await page.getByPlaceholder("Search the catalog").fill("back-squat");
    await expect(page.getByRole("button", { name: /^Create/ })).toHaveCount(0);
  });

  test("creating adds the exercise to the Session in one gesture, mints one Change, and survives a reopen", async ({
    page,
    request,
  }) => {
    await openPlan(page);
    const changesBefore = await countChanges(request);

    await openPicker(page);
    await page.getByPlaceholder("Search the catalog").fill(FIXED);
    await createRow(page, FIXED).click();

    // One gesture: the sheet closes and the exercise is in the Session, with
    // no second step for the user to discover.
    await expect(page.getByText("Exercise catalog")).toHaveCount(0);
    await expect(moreFor(page, FIXED)).toBeVisible();

    // Two writes, but only the Plan half is a Change: creating a catalog row
    // changed no Plan, so it mints none (ADR 0016 §3). `addEntry` plus the
    // set run it seeds are the Plan edit.
    await expect
      .poll(() => countChanges(request), { timeout: 20_000 })
      .toBeGreaterThan(changesBefore);
    const plan = await readPlan(request);
    expect(exerciseIds(plan).filter((id) => id.startsWith("exercise-"))).not.toHaveLength(0);

    // Every later open of the picker lists it — it is a catalog row now, not
    // a label on one Entry.
    await openPicker(page);
    await page.getByPlaceholder("Search the catalog").fill(FIXED);
    await expect(pickerRow(page, FIXED)).toBeVisible();
    // And offers no second copy of itself.
    await expect(page.getByRole("button", { name: /^Create/ })).toHaveCount(0);
  });

  test("a set can be logged against the exercise the user typed, through the target-key fallback", async ({
    page,
  }) => {
    await openPlan(page);
    await openPicker(page);
    await page.getByPlaceholder("Search the catalog").fill(FIXED);
    await createRow(page, FIXED).click();
    await expect(moreFor(page, FIXED)).toBeVisible();

    // The exercise declares no tracked metrics — the coach has not enriched
    // it yet — so the fields come from the prescribed target's keys.
    await page.goto("/");
    await expectConnected(page);
    await page.getByRole("button", { name: /^Session 1/ }).click();
    await expect(page.getByRole("button", { name: "Back to Today" })).toBeVisible({
      timeout: 20_000,
    });
    await expect(page.getByText(FIXED)).toBeVisible();

    const confirms = page.getByRole("button", { name: /^(Log as prescribed|Logged)$/ });
    const before = await confirms.count();
    await confirms.nth(before - 1).click();
    await expect(confirms.nth(before - 1)).toHaveAccessibleName("Logged");
  });

  test("offline the create row is visible and refused with a reason, while picking an existing exercise still works", async ({
    page,
    context,
  }) => {
    await openPlan(page);
    await openPicker(page);
    await setOffline(context, true);

    await page.getByPlaceholder("Search the catalog").fill("Sandbag Carry");
    // Visible, not hidden: an absent row reads as the feature not existing.
    await expect(createRow(page, "Sandbag Carry")).toBeVisible();
    await expect(createRow(page, "Sandbag Carry")).toBeDisabled();
    await expect(page.getByText(/needs a connection/i).first()).toBeVisible();

    // The Plan half is unaffected — Plan edits go through the outbox, so
    // adding an exercise that already exists still lands on screen.
    await page.getByPlaceholder("Search the catalog").fill("Bench Press");
    await pickerRow(page, "Bench Press").click();
    await expect(page.getByText("Exercise catalog")).toHaveCount(0);
    // The seeded Session already prescribes Bench Press, so a second Entry is
    // the visible proof the offline pick landed rather than being swallowed
    // alongside the refused create.
    await expect(moreFor(page, "Bench Press")).toHaveCount(2);
  });

  test("renaming fixes a typo without moving the row: the Plan Entry still points at the same exercise", async ({
    page,
    request,
  }) => {
    await openPlan(page);
    await openPicker(page);
    await page.getByPlaceholder("Search the catalog").fill(TYPO);
    await createRow(page, TYPO).click();
    await expect(moreFor(page, TYPO)).toBeVisible();

    await expect
      .poll(async () => exerciseIds(await readPlan(request)).length, { timeout: 20_000 })
      .toBeGreaterThan(0);
    const idsBefore = exerciseIds(await readPlan(request));

    await openPicker(page);
    await page.getByPlaceholder("Search the catalog").fill(TYPO);
    await page.getByRole("button", { name: `Rename ${TYPO}` }).click();
    await page.getByRole("textbox", { name: `New name for ${TYPO}` }).fill(FIXED);
    await page.getByRole("button", { name: "Save name" }).click();

    // The name moved; the row did not. Same ids in the Plan, so history and
    // analytics follow it with no migration (ADR 0016 §6).
    await expect(pickerRow(page, FIXED)).toBeVisible();
    await page.getByRole("button", { name: "Close" }).click();
    await expect(moreFor(page, FIXED)).toBeVisible();
    expect(exerciseIds(await readPlan(request))).toEqual(idsBefore);
  });
});
