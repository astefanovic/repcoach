import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

import { expectConnected, resetServer, setOffline } from "../driver.ts";

const DEV_SERVER_HTTP_URL = "http://127.0.0.1:4010";

/**
 * "A swap is refused after a Set was logged-then-un-logged, and the refusal is
 * invisible" (issue #148). Two defects, one visible symptom.
 *
 * 1. **The guard counted tombstones.** `swapEntryExercise`'s server guard used
 *    a raw `COUNT(*)` over `logged_set_actual`, but a retraction is a row in
 *    that same table — so a Set that was logged then un-logged still blocked
 *    the swap forever, even though the client (which folds to net state)
 *    happily re-offered the affordance. Repro: swap Back Squat -> Leg Press,
 *    log its first Set, un-log it, swap again -> Bench Press. Post-fix the
 *    second swap is accepted, recorded, and survives a reload.
 *
 * 2. **A refused swap was silent.** Only the Plan editor subscribed to
 *    `outbox.rejections`; the Logging surface did not, so a swap the server
 *    refused stayed on screen with the strip reading `synced · idle` and
 *    reverted only on the next reload. With defect 1 fixed the client and
 *    server now agree for a single client, so `EntryAlreadyLoggedError` is only
 *    reachable when two clients share one Logged Session — which needs the
 *    server-reconciled Resume of #147, not yet on `master`. The flusher ->
 *    `outbox.rejections` half of the fix is covered over a real socket in
 *    `apps/server/src/outboxIntegration.test.ts` ("a swap the server
 *    refuses …"); the Logging surface's subscription is the same thin consumer
 *    of that stream the Plan editor already is.
 *
 * Seeded Session prescribes the four catalog exercises once each
 * (`entry-1` Back Squat .. `entry-4` Leg Press), so a name swapped onto
 * `entry-1` then reads on screen TWICE — see `swap-this-exercise.spec.ts` for
 * the same `.toHaveCount(2)` reasoning. Text assertions are case-insensitive
 * (the small-caps chrome is a CSS transform).
 */

const CONFIRM_NAME = /^(Log as prescribed|Logged)$/;
const confirms = (page: Page) => page.getByRole("button", { name: CONFIRM_NAME });

interface EntrySwap {
  readonly entryId: string;
  readonly exerciseId: string;
  readonly swappedAt: string;
}

interface LoggedActual {
  readonly entryId: string;
  readonly setId: string;
  readonly retraction: boolean;
}

const readSwaps = async (request: APIRequestContext): Promise<ReadonlyArray<EntrySwap>> => {
  const response = await request.get(`${DEV_SERVER_HTTP_URL}/__test__/entry-swaps`);
  expect(response.ok()).toBe(true);
  return ((await response.json()) as { readonly swaps: ReadonlyArray<EntrySwap> }).swaps;
};

const readActuals = async (request: APIRequestContext): Promise<ReadonlyArray<LoggedActual>> => {
  const response = await request.get(`${DEV_SERVER_HTTP_URL}/__test__/logged-actuals`);
  expect(response.ok()).toBe(true);
  return ((await response.json()) as { readonly actuals: ReadonlyArray<LoggedActual> }).actuals;
};

const openLogging = async (page: Page) => {
  await page.goto("/");
  await expectConnected(page);
  await expect(page.getByRole("heading", { name: "Today", exact: true })).toBeVisible();
  await page.getByRole("button", { name: /^Session 1/ }).click();
  await expect(page.getByRole("button", { name: "Back to Today" })).toBeVisible({ timeout: 20_000 });
};

const ensureOnLogging = async (page: Page) => {
  await expectConnected(page);
  const back = page.getByRole("button", { name: "Back to Today" });
  if (await back.isVisible().catch(() => false)) return;
  await expect(page.getByRole("heading", { name: "Today", exact: true })).toBeVisible();
  await page.getByRole("button", { name: /^Session 1/ }).click();
  await expect(back).toBeVisible({ timeout: 20_000 });
};

/**
 * Opens the "+" sheet on the Entry currently titled `from`, taps Swap, and
 * picks `to` from the catalog picker.
 */
const swapEntry1 = async (page: Page, from: string, to: string) => {
  await page.getByRole("button", { name: new RegExp(`^More for ${from}$`, "i") }).first().click();
  const dialog = page.getByRole("dialog", { name: new RegExp(from, "i") }).first();
  await expect(dialog).toBeVisible();
  const swap = dialog.getByRole("button", { name: /Swap this exercise/i });
  await expect(swap).toBeEnabled();
  await swap.click();
  await expect(dialog).toBeHidden();

  const picker = page.getByText("Exercise catalog");
  await expect(picker).toBeVisible();
  await page.getByPlaceholder("Search the catalog").fill(to);
  await page.getByRole("listitem").filter({ hasText: to }).getByRole("button").first().click();
  await expect(picker).toHaveCount(0);
};

test.describe("swap after un-log", () => {
  test.afterEach(async ({ request, context }) => {
    await setOffline(context, false);
    await resetServer(request);
  });

  test("a Set logged then un-logged no longer blocks a second swap — the swap is accepted and survives a reload", async ({
    page,
    request,
  }) => {
    await openLogging(page);

    // First swap: Back Squat -> Leg Press.
    await swapEntry1(page, "Back Squat", "Leg Press");
    await expect
      .poll(async () => (await readSwaps(request)).filter((s) => s.entryId === "entry-1").length, {
        timeout: 20_000,
      })
      .toBe(1);

    // Log the swapped Entry's first Set, then tap the same control again to
    // un-log it (#83). `entry-1` renders first, so its row is the first
    // confirm control on the grid.
    await confirms(page).first().click();
    await expect(confirms(page).first()).toHaveAccessibleName("Logged");
    await confirms(page).first().click();
    await expect(confirms(page).first()).toHaveAccessibleName("Log as prescribed");

    // The retraction has to reach the server before the second swap, so the
    // guard evaluates against net state and not a race.
    await expect
      .poll(async () => (await readActuals(request)).some((a) => a.retraction), { timeout: 20_000 })
      .toBe(true);

    // Second swap: Leg Press -> Bench Press. Pre-fix this was refused
    // server-side and silently reverted on reload.
    await swapEntry1(page, "Leg Press", "Bench Press");

    await expect
      .poll(
        async () => {
          const entry1 = (await readSwaps(request))
            .filter((s) => s.entryId === "entry-1")
            .sort((a, b) => a.swappedAt.localeCompare(b.swappedAt));
          return entry1.at(-1)?.exerciseId ?? null;
        },
        { timeout: 20_000 },
      )
      .toBe("exercise-bench-press");

    await expect(page.getByText(/swapped from back squat/i)).toBeVisible({ timeout: 20_000 });
    await expect(page.getByRole("heading", { name: "Bench Press", exact: true })).toHaveCount(2);

    // The point of the ticket: it is a server fact now, so it survives a
    // reload rather than reverting. Wait on the swap line specifically — it
    // only renders once `getLoggedSession` has resolved with the swap.
    await page.reload();
    await ensureOnLogging(page);
    await expect(page.getByText(/swapped from back squat/i)).toBeVisible({ timeout: 20_000 });
    await expect(page.getByRole("heading", { name: "Bench Press", exact: true })).toHaveCount(2);
  });
});
