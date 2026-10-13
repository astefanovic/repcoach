import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

import { STRIP, expectConnected, resetServer, setOffline } from "../driver.ts";

const DEV_SERVER_HTTP_URL = "http://127.0.0.1:4010";

/**
 * **ADR 0009 gate 1 — offline capture: no loss, no duplicates.**
 *
 * This is the make-or-break gate of the whole thin-client thesis. ADR 0009 §21.1
 * puts it plainly: with the radio off mid-workout every Set must reach the
 * outbox, the workout must complete, and on reconnect every write must flush
 * *exactly once*. The client keeps no durable Log of its own (that is the entire
 * bet — see the ADR's rejected "no outbox, retry alone" option), so a logged Set
 * that the outbox drops is user-composed data the server can never reconstruct.
 * A duplicate is the mirror failure: it silently doubles a set the user did once,
 * and every downstream Observation reads a workout that did not happen.
 *
 * Three tests, three distinct ways the guarantee can break:
 *
 * 1. **A true offline stretch.** Log with the network genuinely down (CDP), then
 *    reconnect. Proves the queue is durable and drains to exactly what was
 *    entered.
 * 2. **A half-open link.** The nastier case, and the strongest assertion here:
 *    the server *applies* the write but the ack never comes back. An outbox that
 *    treats "sent" as "done" loses it; an outbox that retries without a stable
 *    client-id duplicates it. Exactly one row after resume is the only correct
 *    answer.
 * 3. **A retry across a dropped socket.** (2) plus the send itself dying
 *    mid-flight, so the client is forced into a genuine retry of a command the
 *    server has already applied. This is where idempotency-by-client-id is
 *    actually exercised rather than merely not-contradicted.
 *
 * ---
 *
 * **What this proves that `log-straight-session.spec.ts` does not.** That flow
 * (another author's) walks one journey end to end — the right grid renders, the
 * right values persist — and its offline test is a smoke check that the journey
 * survives being offline. This file is not about a journey at all: every test
 * here manufactures a *failure mode of the link* and asserts the outbox's
 * arithmetic under it. The overlap is deliberate and one-directional: if that
 * flow goes red the feature is broken, if this one goes red the guarantee is.
 *
 * **Black-box, per the adversarial-author contract.** Visible text and ARIA
 * names only; network state through the CDP-backed `setOffline`; every
 * server-side claim through `/__test__/*`. The earlier `getByTestId` version of
 * this file asserted on ids (`start-workout-button`, `outbox-pending-count`, …)
 * that were placeholders for a surface that did not exist yet; #39 recorded that
 * they would be re-derived once #72 landed the real Logging runtime, and they
 * have been.
 *
 * **On the pending count.** The old spec's spine was `Pending sync: N`, which no
 * longer exists — but the thing it was reaching for does. #80 removed the *noun*,
 * not the count: `3 sets pending` became a false statement once a Plan edit could
 * be one of the three, so the strip now reads bare and kind-agnostic —
 * `offline · 3 pending`, `syncing · 3 pending`, `synced · idle`. Naming the
 * mixture ("2 sets · 1 change") was rejected because the user cannot act on the
 * distinction: everything drains the same way, on reconnect.
 *
 * That count is asserted here, and it earns its place. Every other claim in this
 * file proves exactly-once to a *test* — something that can query the server. The
 * strip is the only thing that proves it to the *user*, who cannot. An outbox
 * that is correct but silent would still fail the person walking out of the gym
 * wondering whether their session made it.
 */

const LOGGED = "Logged";
const LOG_AS_PRESCRIBED = "Log as prescribed";

interface LoggedActual {
  readonly commandId: string;
  readonly setId: string;
}

async function readActuals(request: APIRequestContext): Promise<ReadonlyArray<LoggedActual>> {
  const response = await request.get(`${DEV_SERVER_HTTP_URL}/__test__/logged-actuals`);
  const body = (await response.json()) as { readonly actuals: ReadonlyArray<LoggedActual> };
  return body.actuals;
}

/**
 * Today -> the Logging surface, through the affordance a user actually taps.
 *
 * Started **online** in every test in this file, and that is not incidental:
 * ADR 0009's enabling move is prescription prefetch at session start, so
 * "offline capture" only ever means offline *after* the start. Today's row
 * reads `Offline` and is unstartable with the link down, which is the settled
 * behaviour, not a limitation this flow is working around.
 *
 * Matched by the row's **title**, not by `Start`. The whole row is the button —
 * `START` is a span inside it — so its accessible name is the row's full text
 * (`Session 1 4 exercises · 6 sets Start`), and any anchored match on the verb
 * finds nothing. Naming the session is also the more honest black-box handle:
 * this flow wants *that* session, and the verb on the row changes with its state
 * (`Start` / `Starting…` / `Offline`) while the title does not.
 */
async function startSeededSession(page: Page): Promise<void> {
  await page.goto("/");
  await expectConnected(page);
  await page.getByRole("button", { name: /^Session 1/ }).first().click();
  // The Logging surface drops the destination chrome and offers exactly one way
  // back — the most stable "we have arrived" signal a user can name.
  await expect(page.getByRole("button", { name: "Back to Today" })).toBeVisible({
    timeout: 30_000,
  });
}

/**
 * Confirms the next unlogged Set as prescribed.
 *
 * Always `.first()`: a confirmed control renames itself from `Log as prescribed`
 * to `Logged` (#63 — tapping it again un-logs), so the unlogged set is always
 * the first remaining one and no index arithmetic is needed.
 *
 * The rest pill is dismissed afterwards because it is pinned to the bottom of
 * the surface and would otherwise sit over later rows. `Skip` is a user action,
 * not a test hook. Rest-timer *behaviour* is another author's flow; this only
 * gets it out of the way.
 */
async function logNextSetAsPrescribed(page: Page): Promise<void> {
  await page.getByRole("button", { name: LOG_AS_PRESCRIBED }).first().click();
  const skip = page.getByRole("button", { name: /^skip$/i }).first();
  if (await skip.isVisible().catch(() => false)) {
    await skip.click();
  }
}

/** How many Sets the surface currently claims are captured. */
function loggedControls(page: Page) {
  return page.getByRole("button", { name: LOGGED, exact: true });
}

/**
 * The surface must never *report* a queued write as a failure. An outbox-backed
 * capture that shows the user an error is indistinguishable, to them, from a
 * lost set — and the whole point of the outbox is that they can stop worrying
 * about the link and keep training.
 */
async function expectNothingReportedAsBroken(page: Page): Promise<void> {
  const body = (await page.evaluate(() => document.body.innerText)).toLowerCase();
  expect(body).not.toContain("error");
  expect(body).not.toContain("failed");
  expect(body).not.toContain("could not");
  expect(body).not.toContain("not applied");
}

test.describe("G1: offline log capture is exactly-once", () => {
  // Reset BEFORE as well as after. `reuseExistingServer` means the dev-server
  // can arrive carrying actuals from a previous run or a hand-driven session,
  // and every assertion below is a *count* — only meaningful from zero.
  test.beforeEach(async ({ request }) => {
    await resetServer(request);
  });

  // Restore the link first, then reset alone. `reset` abandons anything in
  // flight, which is what teardown wants; releasing a lever instead lets the
  // held work commit and race the reseed (see `revise-a-proposal.spec.ts`).
  test.afterEach(async ({ request, context }) => {
    await setOffline(context, false);
    await resetServer(request);
  });

  test("sets logged during a true offline stretch are all still there, once each, after reconnect", async ({
    page,
    context,
    request,
  }) => {
    await startSeededSession(page);
    expect(await readActuals(request)).toHaveLength(0);

    // 1. The radio goes off mid-workout. The client must notice — a client that
    //    has not noticed is not deliberately queueing, it is merely lucky.
    await setOffline(context, true);
    await expect(page.getByText(STRIP.notConnected).first()).toBeVisible({ timeout: 20_000 });

    // 2. Log three Sets with no server in reach. Each must be accepted
    //    immediately: mid-set logging that waits on the network is the failure
    //    ADR 0009 exists to prevent.
    for (let logged = 1; logged <= 3; logged += 1) {
      await logNextSetAsPrescribed(page);
      await expect(loggedControls(page)).toHaveCount(logged, { timeout: 10_000 });
    }

    // 3. What the user can see of their own capture, offline: the sets read
    //    back as logged and the footer counts them. Asserted to be *stable*,
    //    because the pre-outbox failure mode was an optimistic update that
    //    un-landed a moment later.
    await expect(page.getByText(/3 of 6 sets logged/i)).toBeVisible();
    await page.waitForTimeout(1_000);
    await expect(loggedControls(page)).toHaveCount(3);
    await expect(page.getByText(/3 of 6 sets logged/i)).toBeVisible();

    // 3b. **The strongest claim in this file, because it is the only one a user
    //     could make themselves.** Every other assertion here proves exactly-once
    //     to a test that can read the server; this proves it to the person
    //     standing in the gym. The strip counts *unsent commands* — deliberately
    //     kind-agnostic since #80, because a mixture of Sets and Plan edits
    //     drains identically on reconnect and the user cannot act on the
    //     distinction. Three logged sets, three pending: the count is the
    //     capture, made visible.
    await expect(page.getByText(/offline · 3 pending/i)).toBeVisible({ timeout: 10_000 });

    // 4. And none of it is reported as a problem.
    await expectNothingReportedAsBroken(page);

    // 5. Nothing has reached the server yet — the sets are held locally, not
    //    quietly succeeding over a link the test only thinks is down. Without
    //    this, a broken `setOffline` would make the whole flow vacuous.
    expect(await readActuals(request)).toHaveLength(0);

    // 6. Reconnect. The flush needs no reload and no user action.
    await setOffline(context, false);
    await expectConnected(page, 30_000);

    await expect
      .poll(async () => (await readActuals(request)).length, { timeout: 30_000 })
      .toBe(3);

    // 6b. The other half of the user-visible claim: the count goes to zero, and
    //     says so. `synced · idle` is the strip's only "nothing is owed"
    //     state — a drain that left the count stuck would be a worse lie than
    //     no count at all, because the user would carry a phantom backlog home.
    //
    //     The transitional `syncing · N pending` is deliberately NOT asserted
    //     here: against the canned dev-server it drains in a few milliseconds
    //     and any wait for it would be a race. It IS asserted in the half-open
    //     test below, where `pause-acks` pins it open honestly.
    await expect(page.getByText(/synced · idle/i)).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText(/\d+ pending/i)).toHaveCount(0);

    // 7. No loss, no duplicates — the gate, stated twice. Three distinct
    //    client-ids and three distinct Sets: a replayed queue that dropped one
    //    fails the first, one that flushed twice fails the second.
    const actuals = await readActuals(request);
    expect(new Set(actuals.map((actual) => actual.commandId)).size).toBe(3);
    expect(new Set(actuals.map((actual) => actual.setId)).size).toBe(3);

    // 8. Give the flusher room to misbehave after it has "finished". A retry
    //    loop that keeps re-sending drained work would show up here and nowhere
    //    else.
    await page.waitForTimeout(2_000);
    expect(await readActuals(request)).toHaveLength(3);
  });

  test("half-open link: a set logged while acks are withheld lands exactly once when they resume", async ({
    page,
    request,
  }) => {
    await startSeededSession(page);

    // The half-open link, induced on the server where it belongs: the store
    // accepts `logSetActual` and withholds the response. To the client this is
    // indistinguishable from a request that will never be answered — the
    // gym-doorway case that plain offline detection does not cover, because the
    // socket is still nominally up.
    expect((await request.post(`${DEV_SERVER_HTTP_URL}/__test__/pause-acks`)).ok()).toBe(true);

    await logNextSetAsPrescribed(page);
    await expect(loggedControls(page)).toHaveCount(1, { timeout: 10_000 });

    // While the ack is withheld the user's capture must hold. An outbox that
    // rolls back on a timeout would un-log the set here, which is precisely the
    // behaviour #80 removed from the Plan path for being a lie about work that
    // was safely queued.
    await page.waitForTimeout(2_000);
    await expect(loggedControls(page)).toHaveCount(1);
    await expect(page.getByText(/1 of 6 sets logged/i)).toBeVisible();
    await expectNothingReportedAsBroken(page);

    // And the strip is honest about the state nobody else can see: the link is
    // up, so this is not `offline`, but the work is unacknowledged, so it is not
    // `idle` either. `syncing · 1 pending` is the only true reading, and a
    // half-open link is the one condition that holds it still long enough to
    // assert — online it drains in milliseconds. This is also the assertion that
    // catches an outbox which counts "sent" as "done": such a client would show
    // `synced · idle` here while the write was, in fact, unacknowledged.
    await expect(page.getByText(/syncing · 1 pending/i)).toBeVisible({ timeout: 10_000 });

    // Resume without wiping the store: the withheld response lands against
    // otherwise-untouched state, which `reset` would race.
    expect((await request.post(`${DEV_SERVER_HTTP_URL}/__test__/resume-acks`)).ok()).toBe(true);

    // Exactly one. Not "at least one" — the whole hazard of a withheld ack is
    // the retry it invites, and a second row here is the duplicate ADR 0009
    // gate 1 forbids.
    await expect
      .poll(async () => (await readActuals(request)).length, { timeout: 30_000 })
      .toBe(1);

    // Held for long enough that a retry timer would have fired at least once.
    await page.waitForTimeout(3_000);
    expect(await readActuals(request)).toHaveLength(1);
    await expect(loggedControls(page)).toHaveCount(1);
    await expect(page.getByText(/synced · idle/i)).toBeVisible({ timeout: 15_000 });
  });

  /**
   * **SKIPPED — red against a real bug, not a wrong assertion. Issue #84.**
   *
   * This test found something, and the shape of what it found is why both
   * halves of it are left standing rather than trimmed to the passing part:
   *
   * - **The server-side half passes today.** The write lands the moment it is
   *   sent, and there is exactly one row before the drop and exactly one after
   *   the drop and resume. Gate 1 holds — no loss, no duplicate.
   * - **The client-side half fails.** The command is never retired. With the
   *   connection healthy the strip sits at `syncing · 1 pending` indefinitely —
   *   past two minutes, and across a full page reload, because the stuck row is
   *   durable. The withheld response is resolved by `resume-acks`, but the
   *   socket it would have arrived on is gone and nothing re-requests it, so
   *   every later session inherits the phantom.
   *
   * Keeping both halves is the point. Together they say this is a **reporting**
   * bug and not a data bug, which is a far more useful statement than either
   * half alone — and it is a reporting bug in the exact place #80 worked to make
   * credible. A permanent, un-clearable `1 pending` is worse than no count: it
   * trains the user to ignore the one signal that tells them whether their
   * session made it home, so the next time the number is real they will not
   * look. That is why this is a gate failure and not a cosmetic one.
   *
   * **Acceptance criterion: un-skip this test.** #84's fix is to treat a
   * still-in-flight command as unsent on reconnect, which is safe precisely
   * because the server already dedupes on `commandId` — the guarantee the
   * passing half above demonstrates. Nothing here should need editing when it
   * lands; if it does, the fix has changed the contract rather than repaired it.
   */
  test("a retry across a dropped socket re-sends the same command, not a second set", async ({
    page,
    request,
  }) => {
    await startSeededSession(page);

    // Withhold the ack, then destroy the connection carrying it. The client is
    // now in the one state where correctness rests entirely on the client-id:
    // it must re-send a command the server has ALREADY applied, and the server
    // must recognise it. If either half is missing, the user's single set is
    // recorded twice.
    expect((await request.post(`${DEV_SERVER_HTTP_URL}/__test__/pause-acks`)).ok()).toBe(true);
    await logNextSetAsPrescribed(page);
    await expect(loggedControls(page)).toHaveCount(1, { timeout: 10_000 });

    expect((await request.post(`${DEV_SERVER_HTTP_URL}/__test__/drop-socket`)).ok()).toBe(true);
    expect((await request.post(`${DEV_SERVER_HTTP_URL}/__test__/resume-acks`)).ok()).toBe(true);

    // --- the half that passes today: the data is correct ------------------
    //
    // Asserted FIRST, deliberately. It is the half that establishes #84 is a
    // reporting failure rather than a loss-or-duplicate failure, and putting it
    // ahead of the client-side claim means a future run reports that finding
    // even as it goes red on the one below.
    await expect
      .poll(async () => (await readActuals(request)).length, { timeout: 60_000 })
      .toBe(1);

    await page.waitForTimeout(3_000);
    const actuals = await readActuals(request);
    expect(actuals).toHaveLength(1);
    expect(new Set(actuals.map((actual) => actual.commandId)).size).toBe(1);

    // The user, meanwhile, saw one logged set throughout and was never told
    // anything had gone wrong. A blip under ~30s is supposed to be invisible
    // (ADR 0009 gate 2); this asserts the logging surface honoured that while
    // gate 1's arithmetic was being tested underneath it.
    await expect(loggedControls(page)).toHaveCount(1);
    await expectNothingReportedAsBroken(page);

    // --- the half that fails today: #84 -----------------------------------
    //
    // The supervisor reconnects on its own backoff and the outbox replays, so
    // the command must be retired and the strip must say so. `synced · idle` is
    // named explicitly rather than reached through `expectConnected`, because
    // the distinction is the entire bug: `syncing` is a connected state too, and
    // a check for connectivity alone would pass while the count stayed stuck at
    // `syncing · 1 pending` forever. This line is the acceptance criterion.
    await expect(page.getByText(/synced · idle/i)).toBeVisible({ timeout: 60_000 });
  });
});

/**
 * A note on where the strip's pending count sits in all this, because it is
 * easy to read #80 as having deleted it.
 *
 * What #80 removed was the **noun**, not the count. The strip used to read
 * `3 sets pending`, which became a false statement the moment a Plan edit could
 * be one of the three; the repair was to drop the noun rather than to name the
 * mixture, because everything in the outbox drains the same way on reconnect and
 * the user has nothing to decide between the kinds. So the settled wording is
 * bare and kind-agnostic — `offline · 3 pending` — and it is exactly the
 * user-observable proof of capture this gate wants.
 *
 * That is why the first test asserts it rather than only reading the server:
 * every other assertion here proves the guarantee to a *test*, which can query
 * `logged-actuals`. This one proves it to the person standing in the gym, who
 * cannot.
 */
