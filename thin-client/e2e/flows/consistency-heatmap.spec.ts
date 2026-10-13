import { expect, test, type Page } from "@playwright/test";

import { expectConnected, resetServer, setOffline } from "../driver.ts";

const DEV_SERVER_HTTP_URL = "http://127.0.0.1:4010";

/**
 * The Stats surface: a contributions-style consistency heatmap reachable from
 * Today (issue #117).
 *
 * Discovered by driving the running app rather than reading its source (per
 * the adversarial-author contract in docs/agents/testing.md): landing
 * directly on `/stats` renders a banner labelled `Stats`, a `Consistency`
 * heading, and a grid of one button per day named `<yyyy-mm-dd>, N sets
 * logged` — e.g. `2026-08-16, 0 sets logged`. A day with nothing logged is a
 * **disabled** button (`disabled`, not merely unstyled), and the empty state
 * underneath the grid reads `No sets logged yet`. A `Less` / `More` legend
 * sits below the grid. All of this chrome is upper-cased by CSS
 * (`text-transform`), exactly like the rest of the app (see
 * `log-straight-session.spec.ts`'s header comment) — the DOM text Playwright
 * matches against is normal case, so every assertion here is
 * case-insensitive.
 *
 * The `History` link on Today is `page.getByRole("button", { name: /history/i
 * })` (`cancel-and-history-a-session.spec.ts`); a `Stats` link, its sibling
 * per the issue, follows the same house idiom.
 *
 * **This rung caught a real regression before it landed.** The adversarial
 * author's first pass against this file found Today throwing `ReferenceError:
 * onStats is not defined` on every load — `onStats` was added to `Today`'s
 * prop *type* but never added to the destructured parameter list, so it was a
 * bare undefined identifier at runtime even though `tsc` saw nothing wrong
 * (an unused declared prop is not a type error). With no error boundary above
 * it, Today rendered nothing at all — not a Stats-only bug, every journey
 * through Today was broken. Fixed in `Today.tsx`; this file is green as of
 * that fix.
 */

const openToday = async (page: Page) => {
  await page.goto("/");
  await expectConnected(page);
  await expect(page.getByRole("heading", { name: "Today", exact: true })).toBeVisible();
};

// Same house idiom as `History` (`cancel-and-history-a-session.spec.ts`): the
// accessible name is `Stats →`, arrow included, so the match is unanchored.
const statsLink = (page: Page) => page.getByRole("button", { name: /stats/i });

/** A day cell's accessible name: `2026-08-16, 0 sets logged` (or plural/nonzero). */
const dayCell = (page: Page, isoDate: string) =>
  page.getByRole("button", { name: new RegExp(`^${isoDate}, \\d+ sets? logged$`, "i") });

// The LOCAL calendar date, not `toISOString()`'s UTC one — the app buckets
// by local day (issue #117's whole timezone point), and the two disagree for
// a large chunk of every day depending on the runner's own offset.
const todayIsoDate = () => {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
};

test.describe("the consistency heatmap", () => {
  test.afterEach(async ({ request, context }) => {
    // Same teardown idiom as every other flow in this directory: online
    // first, then reset alone, so a context left offline never leaks into
    // the next file and reset never races something still in flight.
    await setOffline(context, false);
    await resetServer(request);
  });

  test("Today offers a way into Stats, and an unlogged day is a disabled cell", async ({ page }) => {
    await openToday(page);

    // The finding: Today does not render at all, so its Stats link cannot be
    // found. See the header comment above for what was actually observed.
    await expect(statsLink(page)).toBeVisible();
    await statsLink(page).click();

    await expect(page.getByText(/^stats$/i)).toBeVisible();
    await expect(page.getByRole("heading", { name: "Consistency", exact: true })).toBeVisible();
    await expect(
      page.getByRole("img", { name: /workout consistency heatmap/i }),
    ).toBeVisible();

    // Nothing has ever been logged in a freshly-reset seed: the empty state
    // is on screen, and today's own cell reads zero and is not interactive.
    await expect(page.getByText(/no sets logged yet/i)).toBeVisible();
    const today = dayCell(page, todayIsoDate());
    await expect(today).toHaveAccessibleName(new RegExp(`^${todayIsoDate()}, 0 sets logged$`, "i"));
    await expect(today).toBeDisabled();

    // The legend that gives the color scale meaning.
    await expect(page.getByText(/^less$/i)).toBeVisible();
    await expect(page.getByText(/^more$/i)).toBeVisible();
  });

  test("logging a set makes today's cell light up in the grid", async ({ page, request }) => {
    await openToday(page);
    await statsLink(page).click();
    await expect(page.getByRole("heading", { name: "Consistency", exact: true })).toBeVisible();

    const today = dayCell(page, todayIsoDate());
    await expect(today).toBeDisabled();

    // Back to Today, start the seeded session, and log exactly one set —
    // the smallest action the acceptance criterion asks for. Mirrors
    // log-straight-session.spec.ts's `openLogging` helper: the confirm
    // control is named `Log as prescribed` before it is logged and `Logged`
    // after — matched with the union of both names (not just the
    // pre-click one), the same fix log-straight-session.spec.ts already
    // applies, because an anchored single-state regex loses track of *which*
    // button it meant once that button's own accessible name changes out
    // from under it.
    await page.getByRole("link", { name: /today/i }).click();
    await expect(page.getByRole("heading", { name: "Today", exact: true })).toBeVisible();
    await page.getByRole("button", { name: /^Session 1/ }).click();
    await expect(page.getByRole("button", { name: "Back to Today" })).toBeVisible({ timeout: 20_000 });

    const confirm = page.getByRole("button", { name: /^(log as prescribed|logged)$/i }).first();
    await confirm.click();
    await expect(confirm).toHaveAccessibleName("Logged");

    // "Logged" is the OUTBOX's optimistic local state (ADR 0009) — it flips
    // the instant the command is enqueued, not once the server has it. Stats
    // is a server-side read, so the flush has to actually land before it can
    // possibly see the set: same wait `log-straight-session.spec.ts` uses via
    // `/__test__/logged-actuals`.
    await expect
      .poll(async () => (await (await request.get(`${DEV_SERVER_HTTP_URL}/__test__/logged-actuals`)).json()).actuals.length, {
        timeout: 20_000,
      })
      .toBe(1);

    // Logging suppresses the destination chrome (#42) — there is no Stats
    // link reachable from inside it, only the one explicit way out.
    await page.getByRole("button", { name: "Back to Today" }).click();
    await expect(page.getByRole("heading", { name: "Today", exact: true })).toBeVisible();

    // Back on Stats: today's cell has moved off the "0 sets logged" empty
    // state and become an interactive (enabled) cell — the acceptance
    // criterion's whole point, "log a session, open Stats, see the day
    // light up."
    await statsLink(page).click();
    await expect(page.getByRole("heading", { name: "Consistency", exact: true })).toBeVisible();
    await expect(today).not.toHaveAccessibleName(new RegExp(`^${todayIsoDate()}, 0 sets logged$`, "i"));
    await expect(today).toBeEnabled();
  });
});
