import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

import { STRIP, expectConnected, resetServer, setOffline } from "../driver.ts";

const DEV_SERVER_HTTP_URL = "http://127.0.0.1:4010";

/**
 * **ADR 0009 gate 3 — prefetch sufficiency.**
 *
 * The ADR calls prescription prefetch "the enabling design move": the Prescribed
 * Session is fetched and cached when the workout starts, *while connected*, so
 * that nothing mid-set ever needs the network. Gate 1 says the writes survive a
 * dead link; this gate says the **reads** never needed it in the first place.
 * They are different failures. An outbox that captures perfectly is worthless if
 * the user cannot see what they are supposed to lift, and a client whose grid
 * blanks or falls back to "could not load" thirty seconds into a session has
 * failed ADR 0009 just as squarely as one that loses a set.
 *
 * The bar this file holds to is the gate's own wording: a session started online
 * **completes entirely from the cache** with the network down. So it logs the
 * whole seeded session — all six Sets, across all four exercises, including the
 * range prescriptions and the drop set — offline, finishes it offline, and then
 * proves that what reached the server on reconnect is exactly what was entered,
 * once each. A test that logged two sets and stopped would be reporting safety
 * it had not checked: the interesting failures (a lazily-fetched later exercise,
 * a rest target resolved on demand) live in the tail of a session, not its head.
 *
 * Second test: the cached copy is **authoritative for the session in flight**.
 * Today's own copy says starting a session makes a copy and what you log never
 * touches the plan; the corollary the cache has to honour is that a prescription
 * edited on the server mid-session does not reach into the workout you are
 * already doing. `/__test__/mutate-prescribed-session` exists for exactly this.
 *
 * ---
 *
 * **How this differs from `log-straight-session.spec.ts`** (another author's).
 * That flow proves the grid renders one Block correctly and its values persist.
 * This one never asserts on the grid's structure at all — it asserts that
 * *everything a user needs mid-set is already local*, by taking the network away
 * and then demanding the entire session anyway. And where `g1-offline-outbox`
 * manufactures pathological link states to test the outbox's arithmetic, this
 * file uses one plain, honest offline stretch and tests coverage: how much of
 * the session the cache can actually carry.
 *
 * **Black-box, per the adversarial-author contract.** Visible text and ARIA
 * names only, `setOffline` for network state, `/__test__/*` for server-side
 * proof. The retired `getByTestId` version of this file asserted on
 * `session-cached`, `set-set-1-reps-ghost` and `outbox-pending-count` — ids
 * placeholding for a surface that did not exist until #72, re-derived here per
 * #39. There is no user-visible "cached" badge and this spec does not want one:
 * the honest proof that a prescription was cached is that it is still readable
 * with the network down, which is what is asserted.
 */

const LOGGED = "Logged";
const LOG_AS_PRESCRIBED = "Log as prescribed";
/** The seed's Session 1: four exercises, six prescribed Sets. */
const SEEDED_SET_COUNT = 6;

interface LoggedActual {
  readonly commandId: string;
  readonly setId: string;
}

async function readActuals(request: APIRequestContext): Promise<ReadonlyArray<LoggedActual>> {
  const response = await request.get(`${DEV_SERVER_HTTP_URL}/__test__/logged-actuals`);
  const body = (await response.json()) as { readonly actuals: ReadonlyArray<LoggedActual> };
  return body.actuals;
}

async function readPlanJson(request: APIRequestContext): Promise<string> {
  const response = await request.get(`${DEV_SERVER_HTTP_URL}/__test__/plan`);
  return JSON.stringify((await response.json()) as unknown);
}

/**
 * Today -> Logging, through the affordance a user taps. Online, always: starting
 * connected is the gate's own premise, since the prefetch happens at start.
 *
 * Matched by the row's **title**, not by `Start`. The whole row is the button —
 * `START` is a span inside it — so its accessible name is the row's full text
 * (`Session 1 4 exercises · 6 sets Start`), and any anchored match on the verb
 * finds nothing. The title is also the steadier handle: the verb changes with
 * the row's state (`Start` / `Starting…` / `Offline`) and the title does not.
 */
async function startSeededSession(page: Page): Promise<void> {
  await page.goto("/");
  await expectConnected(page);
  await page.getByRole("button", { name: /^Session 1/ }).first().click();
  await expect(page.getByRole("button", { name: "Back to Today" })).toBeVisible({
    timeout: 30_000,
  });
}

/**
 * Confirms the next unlogged Set as prescribed, then clears the rest pill.
 *
 * `.first()` throughout: a confirmed control renames itself to `Logged`, so the
 * next unlogged Set is always the first remaining one — no index arithmetic, and
 * no assumption about the order the surface lays exercises out in.
 *
 * The pill is pinned to the bottom of the surface and would sit over the later
 * rows this flow specifically needs to reach. `Skip` is a user action. Its
 * behaviour is another author's flow; this only gets it out of the way.
 */
async function logNextSetAsPrescribed(page: Page): Promise<void> {
  await page.getByRole("button", { name: LOG_AS_PRESCRIBED }).first().click();
  const skip = page.getByRole("button", { name: /^skip$/i }).first();
  if (await skip.isVisible().catch(() => false)) {
    await skip.click();
  }
}

function loggedControls(page: Page) {
  return page.getByRole("button", { name: LOGGED, exact: true });
}

test.describe("G3: prescription prefetch serves a full offline session from cache", () => {
  // Reset before as well as after: `reuseExistingServer` can hand this suite a
  // dev-server carrying actuals from an earlier run, and every claim below is a
  // count.
  test.beforeEach(async ({ request }) => {
    await resetServer(request);
  });

  test.afterEach(async ({ request, context }) => {
    await setOffline(context, false);
    await resetServer(request);
  });

  test("a session started online completes end to end with the network down, and lands intact on reconnect", async ({
    page,
    context,
    request,
  }) => {
    await startSeededSession(page);
    expect(await readActuals(request)).toHaveLength(0);

    // The prescription is on screen while still connected — the baseline the
    // offline assertions below are a comparison against.
    await expect(page.getByText(/100\s*kg/i).first()).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText(/0 of 6 sets logged/i)).toBeVisible();

    // 1. The link dies. Everything from here is served from what was cached at
    //    session start, or it is not served at all.
    await setOffline(context, true);
    await expect(page.getByText(STRIP.notConnected).first()).toBeVisible({ timeout: 20_000 });

    // 2. The prescription is still readable. Named targets, not a generic
    //    "something rendered" check: the load a user is about to lift, a range
    //    prescription with its resolved top-of-range hint, and a duration
    //    prescription — three different target shapes, so a cache that only
    //    round-tripped the simple one is caught here.
    await expect(page.getByText(/100\s*kg/i).first()).toBeVisible();
    await expect(page.getByText(/8-10/).first()).toBeVisible();
    await expect(page.getByText(/30-45/).first()).toBeVisible();

    // 3. Log the WHOLE session offline — every Set of every exercise, not just
    //    the first Block. Gate 3 is about there being no network dependency
    //    *between* sets, and a dependency that only bites on the fourth
    //    exercise is exactly the one a two-set test would miss.
    for (let logged = 1; logged <= SEEDED_SET_COUNT; logged += 1) {
      await logNextSetAsPrescribed(page);
      await expect(loggedControls(page)).toHaveCount(logged, { timeout: 15_000 });
    }
    await expect(page.getByRole("button", { name: LOG_AS_PRESCRIBED })).toHaveCount(0);
    await expect(page.getByText(/6 of 6 sets logged/i)).toBeVisible();

    // 4. None of it was reported as a problem. A queued write is not a failure,
    //    and telling the user otherwise mid-workout is the behaviour the outbox
    //    exists to make unnecessary.
    const offlineBody = (await page.evaluate(() => document.body.innerText)).toLowerCase();
    expect(offlineBody).not.toContain("error");
    expect(offlineBody).not.toContain("could not");
    expect(offlineBody).not.toContain("not applied");

    // 5. Nothing has reached the server: the session really was served locally,
    //    rather than the test merely believing the link was down.
    expect(await readActuals(request)).toHaveLength(0);

    // 6. And the session can be FINISHED offline. The gate says the workout
    //    completes, not that it can be paused until signal returns — a Finish
    //    that needs the network strands the user at the last step of every
    //    session they train through a dead spot.
    await page.getByRole("button", { name: /^finish session$/i }).click();

    // 7. Reconnect: everything drains, with no reload and no user action.
    await setOffline(context, false);
    await expectConnected(page, 30_000);

    await expect
      .poll(async () => (await readActuals(request)).length, { timeout: 45_000 })
      .toBe(SEEDED_SET_COUNT);

    // 8. Exactly what was entered, once each. Six distinct Sets and six
    //    distinct client-ids: a cache that replayed a Set under the wrong id,
    //    or a queue that flushed one twice, fails here rather than silently
    //    inflating the Log the coach later reads.
    const actuals = await readActuals(request);
    expect(new Set(actuals.map((actual) => actual.setId)).size).toBe(SEEDED_SET_COUNT);
    expect(new Set(actuals.map((actual) => actual.commandId)).size).toBe(SEEDED_SET_COUNT);

    // 9. Settled, and staying settled.
    await page.waitForTimeout(2_000);
    expect(await readActuals(request)).toHaveLength(SEEDED_SET_COUNT);
  });

  test("a prescription edited on the server mid-session does not reach into the workout in flight", async ({
    page,
    context,
    request,
  }) => {
    await startSeededSession(page);
    await expect(page.getByText(/100\s*kg/i).first()).toBeVisible({ timeout: 30_000 });

    const planBefore = await readPlanJson(request);

    // The link dies, and while it is down the Prescribed Session is edited on
    // the server — the coach accepting a load Proposal, in the ordinary case.
    await setOffline(context, true);
    await expect(page.getByText(STRIP.notConnected).first()).toBeVisible({ timeout: 20_000 });

    expect(
      (await request.post(`${DEV_SERVER_HTTP_URL}/__test__/mutate-prescribed-session`)).ok(),
    ).toBe(true);

    // The mutation must actually have changed something, or the assertion below
    // is vacuous — it would "pass" against a lever that did nothing at all.
    const planAfter = await readPlanJson(request);
    expect(planAfter).not.toBe(planBefore);

    // Log a set against the cached prescription while the two copies disagree.
    await logNextSetAsPrescribed(page);
    await expect(loggedControls(page)).toHaveCount(1, { timeout: 10_000 });

    // Reconnect. This is the moment of danger: the client re-attaches its
    // subscriptions and the server replays. The Logged Session is a COPY taken
    // at start, so the targets on screen must not shift under the user
    // mid-workout — a set they are halfway through must not silently become a
    // set against a different load.
    await setOffline(context, false);
    await expectConnected(page, 30_000);

    await expect(page.getByText(/100\s*kg/i).first()).toBeVisible({ timeout: 15_000 });
    await expect(loggedControls(page)).toHaveCount(1);

    // And what was captured is one Set, once — the mutation neither duplicated
    // nor invalidated it.
    await expect
      .poll(async () => (await readActuals(request)).length, { timeout: 30_000 })
      .toBe(1);
  });
});

/**
 * What a user can see of their own capture while all of this is offline is the
 * status strip's `offline · N pending` — a count of unsent **commands**, kept
 * kind-agnostic since #80 (see `g1-offline-outbox.spec.ts`, which asserts both
 * ends of it: non-zero while offline, gone once drained).
 *
 * It is asserted there rather than here on purpose. G1 owns the guarantee, and
 * this flow owns *cache coverage* — whether a session started online can be
 * completed from the prefetch with the radio off. Duplicating G1's strip
 * assertions here would make two files fail for one cause.
 */
