import { expect, test, type Page } from "@playwright/test";

import { expectConnected, resetServer, setOffline } from "../driver.ts";


/**
 * Cancel an accidentally-started Session, and History (issue #114).
 *
 * Two rules stated in the issue, each turned into a claim a user can check
 * with their eyes:
 *
 * - **Part 1.** Starting a workout instantiates a Logged Session. While it has
 *   zero confirmed sets it was very likely a mistake (wrong day, fat-fingered
 *   Start) and can be cancelled outright. The moment one set is confirmed the
 *   Session is real history and the only way out is Finish — so the Cancel
 *   affordance itself is gated on `done === 0`, and that gate is the thing
 *   under test, not merely "there exists a Cancel button somewhere."
 * - **Part 2.** A `/history` route lists finished Sessions, newest first, and
 *   tapping one reopens it on the existing Logging surface in a read-only-ish
 *   "backfill" mode — no rest timer, "Done" instead of "Finish session" — so a
 *   past Session is recognisably not a live one.
 *
 * ## On the handles used here
 *
 * The set row's confirm control is named `Log as prescribed` before it is
 * logged and `Logged` after, exactly as in `log-straight-session.spec.ts` —
 * that file's header comment explains why a locator matching either name is
 * the stable one. Text assertions are case-insensitive throughout for the
 * same reason as every other flow in this directory: the app's chrome is
 * upper-cased in CSS, and `text-transform` changes what Playwright's text
 * matcher sees without changing the underlying DOM text.
 */

const CONFIRM_NAME = /^(Log as prescribed|Logged)$/;
const confirms = (page: Page) => page.getByRole("button", { name: CONFIRM_NAME });

const backToToday = (page: Page) => page.getByRole("button", { name: "Back to Today" });
const cancelControl = (page: Page) => page.getByRole("button", { name: /^cancel$/i });
// Not anchored: the control's full accessible name is a compound like
// "in progress · started 10:48 PM Resume — Session 1 →" — "Resume" is in the
// middle of it, not the start.
const resumeControl = (page: Page) => page.getByRole("button", { name: /Resume/i });
// Rendered as buttons, not `<a>` elements — this is an SPA route push behind
// a button, same idiom as the picker's own "Session 1 … Start" row.
const editPlanLink = (page: Page) => page.getByRole("button", { name: /edit plan/i });
const historyLink = (page: Page) => page.getByRole("button", { name: /history/i });

const openToday = async (page: Page) => {
  await page.goto("/");
  await expectConnected(page);
  await expect(page.getByRole("heading", { name: "Today", exact: true })).toBeVisible();
};

/** Start the seeded session from Today's picker, landing on Logging. */
const startSession = async (page: Page) => {
  await openToday(page);
  await page.getByRole("button", { name: /^Session 1/ }).click();
  await expect(backToToday(page)).toBeVisible({ timeout: 20_000 });
};

test.describe("cancel an accidentally-started session", () => {
  test.afterEach(async ({ request, context }) => {
    // Online first, then `reset` alone: reset abandons anything in flight and
    // reseeds, and a context left offline would take its dead network into
    // the next file — same teardown idiom as log-straight-session.spec.ts.
    await setOffline(context, false);
    await resetServer(request);
  });

  test("Cancel is offered with zero sets logged, and cancelling returns Today to its start-fresh state", async ({
    page,
  }) => {
    await startSession(page);

    // Zero sets confirmed: Cancel is on offer.
    await expect(page.getByText(/0\s*\/\s*6/)).toBeVisible();
    await expect(cancelControl(page)).toBeVisible();

    await cancelControl(page).click();

    // A confirm sheet, not an immediate cancel — named "Cancel session" both
    // as the sheet's title and as the button that actually performs it, so
    // this locator is deliberately scoped to the sheet's own text rather than
    // reused for the header control above.
    const sheet = page.getByText(/cancel session/i).first();
    await expect(sheet).toBeVisible();
    await expect(page.getByText(/no sets/i)).toBeVisible();

    await page.getByRole("button", { name: /^cancel session$/i }).click();

    // Back on Today.
    await expect(page.getByRole("heading", { name: "Today", exact: true })).toBeVisible({
      timeout: 15_000,
    });

    // And Today does not think anything is still in flight: no Resume
    // affordance for the cancelled session, and the picker's Start button for
    // it is back, i.e. a fresh start is possible rather than the app being
    // stuck pointing at a dead session.
    await expect(resumeControl(page)).toHaveCount(0);
    await expect(page.getByRole("button", { name: /^Session 1/ })).toBeVisible();
  });

  test("cancelling via Close backs out without cancelling the session", async ({ page }) => {
    await startSession(page);
    await cancelControl(page).click();
    await expect(page.getByText(/cancel session/i).first()).toBeVisible();

    await page.getByRole("button", { name: "Close" }).click();

    // Still on Logging, the session still alive: the header still offers
    // Cancel (nothing was confirmed by backing out of the sheet), and Today
    // would still see it as resumable.
    await expect(backToToday(page)).toBeVisible();
    await expect(cancelControl(page)).toBeVisible();

    await backToToday(page).click();
    await expect(page.getByRole("heading", { name: "Today", exact: true })).toBeVisible();
    await expect(resumeControl(page)).toBeVisible();
  });

  test("once a set is confirmed, Cancel is no longer offered", async ({ page }) => {
    await startSession(page);
    await expect(cancelControl(page)).toBeVisible();

    await confirms(page).first().click();
    await expect(confirms(page).first()).toHaveAccessibleName("Logged");

    // The core rule: cancel is gated on done === 0, and it is gone the moment
    // that stops being true — not merely harder to find.
    await expect(cancelControl(page)).toHaveCount(0);
  });
});

test.describe("history", () => {
  test.afterEach(async ({ request, context }) => {
    await setOffline(context, false);
    await resetServer(request);
  });

  test("Today links to History, and an empty history says so", async ({ page }) => {
    await openToday(page);

    await expect(editPlanLink(page)).toBeVisible();
    await expect(historyLink(page)).toBeVisible();

    await historyLink(page).click();

    await expect(page.getByRole("heading", { name: "Past sessions", exact: true })).toBeVisible();
    await expect(page.getByText("History", { exact: true })).toBeVisible();

    // Nothing has ever been finished in a freshly-reset seed.
    await expect(page.getByText(/no finished sessions yet/i)).toBeVisible();
  });

  test("a finished session appears in History and reopens as a backfill in Logging", async ({ page }) => {
    await startSession(page);

    // Log every seeded set, then finish — mirrors log-straight-session.spec's
    // seeded layout (Back Squat x2, Bench Press, Plank, Leg Press, Leg Press
    // drop: six sets).
    const total = await confirms(page).count();
    expect(total).toBeGreaterThan(0);
    for (let i = 0; i < total; i += 1) {
      await confirms(page).nth(i).click();
    }
    await expect(page.getByText(new RegExp(`${total} of ${total} sets logged`, "i"))).toBeVisible();

    // Let the outbox drain before finishing. Confirms go through the outbox
    // (log-straight-session.spec.ts), and finishing while sets are still
    // queued surfaced a real, user-visible failure here — "could not finish ·
    // No Logged Session found for id …" — rather than the app waiting for
    // sync itself. Reported separately; this test is about the History
    // journey, so it synchronizes explicitly rather than racing that gap.
    await expectConnected(page);

    await page.getByRole("button", { name: /^finish session$/i }).click();

    // Finishing returns to Today (mirrors the outcome the Cancel journey
    // checks for — Today, not stuck on Logging).
    await expect(page.getByRole("heading", { name: "Today", exact: true })).toBeVisible({
      timeout: 15_000,
    });
    await expect(resumeControl(page)).toHaveCount(0);

    await historyLink(page).click();
    await expect(page.getByRole("heading", { name: "Past sessions", exact: true })).toBeVisible();

    // The just-finished session is a row: named (or "Session" as fallback),
    // dated, and reporting the full set count. Scoped to the "N of M sets"
    // text rather than a bare /session/i match, because that would also
    // match the "Past sessions" heading itself — a click on the heading does
    // nothing, which is a false negative for "the row opens the session"
    // rather than proof there is no row.
    const row = page.getByRole("button", { name: new RegExp(`${total} of ${total} sets`, "i") });
    await expect(row).toBeVisible();
    await expect(page.getByText(/no finished sessions yet/i)).toHaveCount(0);

    await row.click();

    // Reopened on Logging, in backfill mode: no live-session chrome (Cancel
    // is a live-only affordance, checked already; the distinguishing label is
    // "Backfill"), and "Done" rather than "Finish session" at the bottom.
    await expect(backToToday(page)).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText(/backfill/i)).toBeVisible();
    await expect(page.getByRole("button", { name: /^done$/i })).toBeVisible();
    await expect(page.getByRole("button", { name: /^finish session$/i })).toHaveCount(0);
    await expect(cancelControl(page)).toHaveCount(0);

    // And the URL itself moved to that session's Logging surface.
    await expect(page).toHaveURL(/\/log\//);
  });
});
