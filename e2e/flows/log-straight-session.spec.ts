import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

import { expectConnected, resetServer, setOffline, snapshotText } from "../driver.ts";

const DEV_SERVER_HTTP_URL = "http://127.0.0.1:4010";

/**
 * Logging, the plain case: straight sets confirmed one tap at a time
 * (issue #20, re-derived for #82 item 4).
 *
 * This file was `describe.skip`'d by #50 against a Logging surface that
 * rendered fixtures through local `useState`, and its assertions were a
 * scaffold of `getByTestId("set-set-1-confirm-button")`-shaped ids that never
 * belonged in a rung-2 spec at all. #72 put the surface on the real client
 * runtime and #39's condition ("re-derive these from the settled specs once
 * #72/#74 land") is now met, so the ids are gone and every claim below is made
 * against visible text or an accessible name, per docs/agents/testing.md.
 *
 * The *rules* survived the rewrite untouched — only the handles changed:
 *
 * - **A single-exercise Block's wrapper stays hidden** (ui-surfaces.md →
 *   Logging: "Blocks surface **only** when superset/circuit/EMOM/AMRAP is
 *   used"). The seed is the right fixture for this precisely because it is
 *   mixed: Back Squat and Bench Press are grouped, Plank and Leg Press are
 *   not, so "no wrapper" is a claim about *those two* rather than about a
 *   surface that happens to have no groups at all. A single wrapper on screen
 *   is therefore the assertion — not zero, and not one per Entry.
 * - **One-tap confirm logs the target as actual, and a range resolves to the
 *   TOP of the range.** That is the double-progression intent (ui-surfaces.md
 *   → Logging; ADR 0007) and it is a *logging convention*, so it can only be
 *   checked where the value lands: server-side, in the actual.
 * - **Tapping a logged ✓ un-logs it.** #63 settled this over a long-press
 *   because "a long-press is undiscoverable with chalk on your hands"; the
 *   observable form is that the same control toggles.
 * - **Confirmed actuals reach the server through the OUTBOX, never a direct
 *   RPC.** The distinguishing evidence is not that the write arrives when
 *   online — a direct RPC would also do that — but that it survives a period
 *   with no network and then arrives **exactly once**. Hence the offline leg,
 *   and hence `commandId` uniqueness rather than a bare length check.
 * - **Logging never mutates the Plan** (ADR 0006). The footer says as much
 *   (`never touches the plan`), but copy is not proof, so the Plan is read off
 *   the server before and after and compared whole.
 *
 * ## On the handles used here
 *
 * The set row's confirm control is named `Log as prescribed` before it is
 * logged and `Logged` after — so a locator matching *either* keeps a stable,
 * document-ordered list of all six sets across the whole flow, and the name of
 * the nth control is itself the assertion about whether that set is logged.
 * Indexing into that list is ordering a user can see (the sets run down the
 * screen in prescribed order); it is not structural knowledge.
 *
 * Text assertions are case-insensitive on purpose. Much of this surface is
 * upper-cased in CSS, and `text-transform` changes what `innerText` reports
 * without changing the DOM text Playwright matches against — an exact-case
 * assertion here would be asserting a stylesheet.
 */

/** Set rows in prescribed order, whether or not each is already logged. */
const CONFIRM_NAME = /^(Log as prescribed|Logged)$/;
const confirms = (page: Page) => page.getByRole("button", { name: CONFIRM_NAME });

/**
 * Index into that list. The seeded Session, read top to bottom on screen:
 * Back Squat ×2 (grouped), Bench Press (grouped), Plank, Leg Press, and Leg
 * Press's prescribed drop continuation.
 */
const SET = {
  squatFirst: 0,
  squatSecond: 1,
  bench: 2,
  plank: 3,
  legPress: 4,
  legPressDrop: 5,
} as const;

/** Any Block wrapper label, in any of the formats ui-surfaces.md names. */
const blockLabels = (page: Page) => page.getByText(/\[(superset|circuit|emom|amrap)\b/i);

const openLogging = async (page: Page) => {
  await page.goto("/");
  await expectConnected(page);
  await expect(page.getByRole("heading", { name: "Today", exact: true })).toBeVisible();

  // The whole session row is the button, and its accessible name is the row's
  // entire text — `Session 1 4 exercises · 6 sets Start`. Named by the session
  // rather than by the word "Start": it identifies *which* row is being
  // started, and it does not also match the row's `Starting…` and `Offline`
  // states, which are the same control saying something else.
  await page.getByRole("button", { name: /^Session 1/ }).click();

  // Logging has no destination chrome; the back affordance is what says we
  // arrived, and the counter says the surface has the real Session on it.
  await expect(page.getByRole("button", { name: "Back to Today" })).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText(/0\s*\/\s*6/)).toBeVisible();
};

const readPlan = async (request: APIRequestContext): Promise<string> => {
  const response = await request.get(`${DEV_SERVER_HTTP_URL}/__test__/plan`);
  expect(response.ok()).toBe(true);
  return JSON.stringify((await response.json()) as unknown);
};

type LoggedActual = {
  readonly commandId: string;
  readonly setId: string;
  readonly setType?: string;
  readonly actual: {
    readonly reps?: number;
    readonly load?: number;
    readonly duration?: number;
  };
};

const readActuals = async (request: APIRequestContext): Promise<readonly LoggedActual[]> => {
  const response = await request.get(`${DEV_SERVER_HTTP_URL}/__test__/logged-actuals`);
  expect(response.ok()).toBe(true);
  const body = (await response.json()) as { readonly actuals: readonly LoggedActual[] };
  return body.actuals;
};

test.describe("log a straight session", () => {
  test.afterEach(async ({ request, context }) => {
    // Online first, then `reset` alone: reset abandons anything in flight and
    // reseeds, and a context left offline would take its dead network into the
    // next file. See revise-a-proposal.spec.ts for why teardown must not try
    // to be more helpful than this.
    await setOffline(context, false);
    await resetServer(request);
  });

  test("a single-exercise Block renders no wrapper, and its sets are directly loggable", async ({
    page,
  }) => {
    await openLogging(page);

    // Exactly one wrapper on a Session with four Entries: the seeded superset.
    // Plank and Leg Press are Blocks too, but Blocks of one, and a wrapper
    // around a single exercise would be structure the user has to read past for
    // nothing.
    await expect(blockLabels(page)).toHaveCount(1);

    // All four exercises are named, so "no wrapper" is not being satisfied by
    // the ungrouped Entries simply being absent.
    await expect(page.getByText(/back squat/i).first()).toBeVisible();
    await expect(page.getByText(/bench press/i).first()).toBeVisible();
    await expect(page.getByText(/plank/i).first()).toBeVisible();
    await expect(page.getByText(/leg press/i).first()).toBeVisible();

    // And an ungrouped Entry's set is loggable in one tap, with nothing to
    // open or expand first — the wrapper's absence costs it no affordance.
    await expect(confirms(page)).toHaveCount(6);
    await confirms(page).nth(SET.plank).click();
    await expect(confirms(page).nth(SET.plank)).toHaveAccessibleName("Logged");
    await expect(page.getByText(/1 of 6 sets logged/i)).toBeVisible();
  });

  test("one-tap confirm logs the target as actual, and a range resolves to the top of the range", async ({
    page,
    request,
  }) => {
    await openLogging(page);

    // Two exact targets (Back Squat, 5 reps @ 100) and two ranges (Bench
    // Press 8–10 reps, Plank 30–45 sec). The ranges are the point. With no
    // history for these exercises the row shows the plan's range itself, and
    // nothing under it (UAT took the "✓ logs 10" line away); the actuals below
    // are what prove a tap means the top.
    await expect(page.getByRole("button", { name: /^reps — prescribed 8-10, tap to change$/ })).toBeVisible();
    await expect(page.getByText(/logs 10/i)).toHaveCount(0);

    await confirms(page).nth(SET.squatFirst).click();
    await confirms(page).nth(SET.squatSecond).click();
    await confirms(page).nth(SET.bench).click();
    await confirms(page).nth(SET.plank).click();

    await expect(page.getByText(/4 of 6 sets logged/i)).toBeVisible();

    await expect
      .poll(async () => (await readActuals(request)).length, { timeout: 20_000 })
      .toBe(4);

    const actuals = await readActuals(request);
    // Compared as a set of values rather than keyed by set id: the claim is
    // about what a tap *means*, and the seed's internal ids are not something
    // a user can see.
    expect(actuals.map((entry) => entry.actual)).toEqual(
      expect.arrayContaining([
        { reps: 5, load: 100 },
        { reps: 5, load: 100 },
        // Top of 8–10, not 8 and not a midpoint.
        { reps: 10, load: 60 },
        // Duration only — no reps, no load. The set row is a map over the
        // metrics the Exercise catalog declares (#63), and that shows up in
        // the actual as much as on screen.
        { duration: 45 },
      ]),
    );
    // Every set is its own command, so a partially-drained outbox can never
    // half-write one.
    expect(new Set(actuals.map((entry) => entry.setId)).size).toBe(4);
    expect(new Set(actuals.map((entry) => entry.commandId)).size).toBe(4);
  });

  test("confirmed actuals go through the outbox: captured offline, delivered exactly once on reconnect", async ({
    page,
    request,
    context,
  }) => {
    await openLogging(page);

    // Offline for real, via CDP. A direct RPC would fail here; the outbox is
    // the reason confirming still works, and ADR 0009's gate 1 is that it must
    // work *silently* — a set logged in a basement gym is not an error
    // condition to be reported to the user.
    await setOffline(context, true);

    await confirms(page).nth(SET.squatFirst).click();
    await confirms(page).nth(SET.squatSecond).click();

    // Locally the sets read as logged straight away: capture is not gated on
    // the round-trip.
    await expect(confirms(page).nth(SET.squatFirst)).toHaveAccessibleName("Logged");
    await expect(confirms(page).nth(SET.squatSecond)).toHaveAccessibleName("Logged");
    await expect(page.getByText(/2 of 6 sets logged/i)).toBeVisible();

    const offlineText = await snapshotText(page);
    expect(offlineText.toLowerCase()).not.toContain("error");
    expect(offlineText.toLowerCase()).not.toContain("failed");

    // Nothing has reached the server yet — the writes are genuinely queued,
    // not merely slow.
    expect(await readActuals(request)).toHaveLength(0);

    await setOffline(context, false);
    await expectConnected(page);

    await expect
      .poll(async () => (await readActuals(request)).length, { timeout: 30_000 })
      .toBe(2);

    // Exactly once. A retrying outbox that does not deduplicate would land
    // two identical actuals for one set and leave the Plan looking like a
    // harder session than the user trained.
    const actuals = await readActuals(request);
    expect(new Set(actuals.map((entry) => entry.commandId)).size).toBe(2);
    expect(new Set(actuals.map((entry) => entry.setId)).size).toBe(2);
    expect(actuals.every((entry) => entry.actual.reps === 5 && entry.actual.load === 100)).toBe(true);
  });

  /**
   * **Un-skipped — this was the acceptance criterion for [#83](https://github.com/astefanovic/repcoach/issues/83).**
   *
   * #63 settled that tapping a logged ✓ un-logs the set — "backfill needs an
   * undo, and a long-press is undiscoverable with chalk on your hands" — and
   * ADR 0019 settled the server-side contract the old skip note said was
   * missing: un-logging appends a retraction (`unlogSetActual`), never a
   * delete. This assertion is unchanged from the skipped version — the
   * control's own accessible name and the counter, nothing server-side (a
   * server-side round-trip assertion lives separately, in
   * `outboxIntegration.test.ts`).
   */
  test("tapping a logged ✓ un-logs the set", async ({ page }) => {
    await openLogging(page);

    await confirms(page).nth(SET.squatFirst).click();
    await expect(confirms(page).nth(SET.squatFirst)).toHaveAccessibleName("Logged");
    await expect(page.getByText(/1 of 6 sets logged/i)).toBeVisible();

    // The same control, tapped again. #63 chose this over a long-press
    // explicitly: backfill needs an undo, and the undo has to be reachable by
    // someone whose hands are covered in chalk.
    await confirms(page).nth(SET.squatFirst).click();
    await expect(confirms(page).nth(SET.squatFirst)).toHaveAccessibleName("Log as prescribed");
    await expect(page.getByText(/0 of 6 sets logged/i)).toBeVisible();
    await expect(page.getByText(/0\s*\/\s*6/)).toBeVisible();
  });

  test("logging never mutates the Plan", async ({ page, request }) => {
    await openLogging(page);

    const before = await readPlan(request);

    await confirms(page).nth(SET.squatFirst).click();
    await confirms(page).nth(SET.bench).click();
    await confirms(page).nth(SET.plank).click();

    await expect
      .poll(async () => (await readActuals(request)).length, { timeout: 20_000 })
      .toBe(3);

    // ADR 0006. The footer states this in words — `never touches the plan` —
    // and the words are worth having on screen, but they are copy, not
    // evidence. Starting a Session takes a *copy* of the prescription, so a
    // whole-Plan comparison is the honest check: not "the load target is still
    // 100" but "nothing anywhere in the Plan moved".
    await expect(page.getByText(/never touches the plan/i)).toBeVisible();
    expect(await readPlan(request)).toBe(before);
  });
});
