import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

import { expectConnected, resetServer, setOffline, snapshotText } from "../driver.ts";

const DEV_SERVER_HTTP_URL = "http://127.0.0.1:4010";

/**
 * Logging a superset: the Block wrapper, and the metric-driven set row
 * (issue #20, re-derived for #82 item 4).
 *
 * Skipped by #50 while the Logging surface was fixture-driven, and written
 * then against `block-block-2-label`-style ids. #72 landed the real surface;
 * the ids are gone and the rules are re-derived from ui-surfaces.md →
 * "Logging → Settled by the prototype (#63)".
 *
 * What this proves, and why each is a claim rather than a description:
 *
 * - **A Block's wrapper is a left rule and a label spanning the grouped
 *   Entries — never a container.** The observable consequence, and the one
 *   worth a test, is that grouping changes *nothing* about how the sets are
 *   read: the Entries keep their own headers, their own "+", and their own
 *   rows, in prescribed order. A wrapper that had quietly become a container
 *   would show up as an Entry losing an affordance, or as rows moving.
 * - **Rounds are stated, not structural — the rows do not reinterleave.**
 *   The tempting implementation of a 2-round superset is A1 B1 A2 B2, and #63
 *   rejected it: a superset is a prescription, and a logging surface that
 *   reshuffles rows to dramatize it makes the two sets of Back Squat harder to
 *   find, not easier. So the assertion is on document order.
 * - **A Block surfaces only when it groups more than one exercise** — one
 *   wrapper on this Session, not four.
 * - **The set row is a map over the Exercise catalog's declared metrics.**
 *   #63: "There is no reps/load pair anywhere in the rendering code." The
 *   seeded superset is the cheapest possible proof, because it puts a
 *   duration-only Plank beside a reps+load Bench Press — and #72's own brief
 *   records that the prototype regressed here, rendering four metrics where
 *   the runtime declared six, so this is a live guard rather than a
 *   formality. It is checked by *counting metric controls across the whole
 *   surface*: the Plank contributes exactly one duration control and zero
 *   reps or load controls, which cannot be true of a fixed reps/load layout
 *   no matter how it is styled.
 * - **Both grouped Entries log independently**, and a range still resolves to
 *   the top of the range inside a Block. Grouping is prescription, not a
 *   change to what a tap means.
 *
 * One claim in the settled spec is deliberately **not** asserted here and is
 * skipped below rather than fudged: that the label is never red. See the skip.
 */

const CONFIRM_NAME = /^(Log as prescribed|Logged)$/;
const confirms = (page: Page) => page.getByRole("button", { name: CONFIRM_NAME });

/** Prescribed order down the screen; see log-straight-session.spec.ts. */
const SET = { squatFirst: 0, squatSecond: 1, bench: 2, plank: 3 } as const;

const blockLabels = (page: Page) => page.getByText(/\[(superset|circuit|emom|amrap)\b/i);

/**
 * A metric control on a set row. Its accessible name carries the metric and
 * the prescribed value (`reps — prescribed 8-10, tap to change`), which makes
 * it both the handle and, counted, the evidence for metric-driven layout.
 */
const metricControls = (page: Page, metric: "reps" | "load" | "duration") =>
  page.getByRole("button", { name: new RegExp(`^${metric} — `) });

const openLogging = async (page: Page) => {
  await page.goto("/");
  await expectConnected(page);
  await expect(page.getByRole("heading", { name: "Today", exact: true })).toBeVisible();
  // The whole session row is the button; see log-straight-session.spec.ts.
  await page.getByRole("button", { name: /^Session 1/ }).click();
  await expect(page.getByRole("button", { name: "Back to Today" })).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText(/0\s*\/\s*6/)).toBeVisible();
};

type LoggedActual = {
  readonly commandId: string;
  readonly setId: string;
  readonly actual: {
    readonly reps?: number;
    readonly load?: number;
    readonly duration?: number;
  };
};

const readActuals = async (request: APIRequestContext): Promise<readonly LoggedActual[]> => {
  const response = await request.get(`${DEV_SERVER_HTTP_URL}/__test__/logged-actuals`);
  expect(response.ok()).toBe(true);
  return ((await response.json()) as { readonly actuals: readonly LoggedActual[] }).actuals;
};

test.describe("log a superset", () => {
  test.afterEach(async ({ request, context }) => {
    await setOffline(context, false);
    await resetServer(request);
  });

  test("the Block surfaces one wrapper spanning the grouped Entries, and the rows do not reinterleave", async ({
    page,
  }) => {
    await openLogging(page);

    // One wrapper, for the one Block that groups more than one exercise.
    await expect(blockLabels(page)).toHaveCount(1);
    await expect(page.getByText(/\[superset/i)).toBeVisible();

    // Both grouped Entries keep their own identity under the wrapper: their
    // names, and the per-Entry "+" that #63 made the single home for
    // everything spontaneous. If the wrapper had become a container that owned
    // its children, this is where it would show.
    await expect(page.getByText(/back squat/i).first()).toBeVisible();
    await expect(page.getByText(/bench press/i).first()).toBeVisible();
    await expect(page.getByRole("button", { name: /^More for Back Squat$/i })).toBeVisible();
    await expect(page.getByRole("button", { name: /^More for Bench Press$/i })).toBeVisible();

    // Document order. Two things about the rendered text shape this, and both
    // are properties of the settled design rather than accidents:
    //
    // 1. `innerText` puts every metric field on its own line, so a set row
    //    reads `1 / 5 / reps / 100 / kg / ✓` — there is no `5 reps` or
    //    `100 kg` to search for. The row is located by its load alone (`100`
    //    appears only on the two Back Squat sets).
    // 2. The `[SUPERSET]` label sits *between* Back Squat's rows and Bench
    //    Press's header, not above both. That is correct and required: in a
    //    card-less language the wrapper is a margin mark spanning the grouped
    //    Entries (#45), so it cannot precede them in the text the way a
    //    container's opening tag would. The grouping claim is therefore made
    //    on the Entries' own order, which is what actually matters here.
    //
    // Both Back Squat sets sit above the Bench Press header, and Bench Press's
    // only set (`8-10`) sits below it. An A1/B1/A2/B2 interleave — the reading
    // of "superset" this spec exists to rule out — breaks both.
    const body = (await snapshotText(page)).toLowerCase();
    const squatHeader = body.indexOf("back squat");
    const lastSquatRow = body.lastIndexOf("100");
    const benchHeader = body.indexOf("bench press");
    const benchRow = body.indexOf("8-10");
    expect(squatHeader).toBeGreaterThan(-1);
    expect(lastSquatRow).toBeGreaterThan(squatHeader);
    expect(benchHeader).toBeGreaterThan(lastSquatRow);
    expect(benchRow).toBeGreaterThan(benchHeader);
  });

  test("set rows render the metrics the Exercise catalog declares, not a fixed reps/load pair", async ({
    page,
  }) => {
    await openLogging(page);

    // The Plank is the whole argument: one duration control, prescribed as a
    // range, and no reps or load control anywhere on its row. Counted across
    // the surface, that is unfalsifiable by styling — a fixed reps/load layout
    // would have to render controls it then hid, and hidden controls are not
    // in the accessibility tree either.
    await expect(metricControls(page, "duration")).toHaveCount(1);
    await expect(metricControls(page, "duration")).toHaveAccessibleName(
      /^duration — prescribed 30-45, tap to change$/,
    );

    // Its reps+load neighbour in the same Block declares both, and says so in
    // the prescribed values: 8–10 reps at 60 kg.
    await expect(
      page.getByRole("button", { name: /^reps — prescribed 8-10, tap to change$/ }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: /^load — prescribed 60, tap to change$/ }),
    ).toBeVisible();

    // And nothing on the surface pairs a duration with reps or load: the four
    // reps controls are the two Back Squat sets, the Bench Press set and the
    // Leg Press working set — the Plank contributes none of them, and neither
    // does the drop continuation.
    await expect(metricControls(page, "reps")).toHaveCount(4);
    await expect(page.getByRole("button", { name: /^(reps|load) — prescribed 30-45/ })).toHaveCount(0);
  });

  test("both grouped Entries log independently, and a range still resolves to the top inside a Block", async ({
    page,
    request,
  }) => {
    await openLogging(page);

    // Log one Entry's set and not the other's. Grouping does not make the
    // Block the unit of logging — a superset is still logged set by set,
    // because that is how it is performed.
    await confirms(page).nth(SET.bench).click();
    await expect(confirms(page).nth(SET.bench)).toHaveAccessibleName("Logged");
    await expect(confirms(page).nth(SET.squatFirst)).toHaveAccessibleName("Log as prescribed");
    await expect(confirms(page).nth(SET.squatSecond)).toHaveAccessibleName("Log as prescribed");
    await expect(page.getByText(/1 of 6 sets logged/i)).toBeVisible();

    await confirms(page).nth(SET.squatFirst).click();
    await confirms(page).nth(SET.plank).click();

    await expect
      .poll(async () => (await readActuals(request)).length, { timeout: 20_000 })
      .toBe(3);

    const actuals = await readActuals(request);
    expect(actuals.map((entry) => entry.actual)).toEqual(
      expect.arrayContaining([
        // Top of 8–10 — the same convention inside a Block as outside it.
        { reps: 10, load: 60 },
        { reps: 5, load: 100 },
        // Top of 30–45, and duration alone: the metric-driven row carries all
        // the way through to what is stored.
        { duration: 45 },
      ]),
    );
    expect(new Set(actuals.map((entry) => entry.commandId)).size).toBe(3);
  });

  /**
   * #63 settled that the Block label is **not** red — "a Block is structural,
   * and red stays reserved for the coach's proposed change" — and it is a real
   * claim, not decoration: red appearing on a superset would make a
   * prescription the user wrote look like something the coach wants to change.
   *
   * It is skipped because it cannot honestly be written black-box today. The
   * settled spec names a *semantic* colour, and nothing visible or announced
   * names it: there is no text, no ARIA state, and no agreed token value an
   * e2e spec could compare a computed style against. Asserting some particular
   * rgb triple would be asserting the current stylesheet — the exact failure
   * this rung exists to prevent — and asserting "not any reddish colour" would
   * be inventing a threshold nobody agreed to.
   *
   * **Waiting on:** a decision that makes colour semantics observable from
   * outside the client — a published palette token contract the e2e suite may
   * name, or a rung-1 visual/token test taking ownership of the claim. Until
   * one exists, this belongs to design review, not to Playwright.
   */
  test.skip("the Block label is never red", () => {});
});
