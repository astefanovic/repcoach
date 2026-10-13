import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

import { expectConnected, resetServer } from "../driver.ts";

const DEV_SERVER_HTTP_URL = "http://127.0.0.1:4010";

/**
 * Logging an unplanned "another straight set" (issue #115, item 1 only).
 *
 * The per-Entry "+" affordance (`More for <Exercise>`) opens a bottom sheet
 * with six items. "Another straight set" is the one item #115 wires up:
 * tapping it appends a fresh, unconfirmed Set row to that Entry, echoing the
 * SAME prescription as the Entry's last working Set, with a new id. The row
 * then behaves exactly like any other Set row — one tap on its confirm logs
 * it, resolving to the top of its (here, exact) target, same as every other
 * set on the surface (ADR 0007). #129 wires the three continuations (drop,
 * rest-pause, myo-cluster) the same way, tested in `log-drop-set.spec.ts`;
 * swap and a note remain the only two still-unwired placeholders here.
 *
 * Back Squat is the fixture: two prescribed working Sets (`set-1`, `set-2`,
 * both `{ reps: 5, load: 100 }`), no drop/continuation attached — the clean
 * case, deliberately not Leg Press (which has a prescribed drop and would
 * conflate "another straight set" with continuation grouping).
 *
 * Four claims, one test each:
 * 1. The sheet's six items — four wired (straight, drop, rest-pause,
 *    myo-cluster), swap and note still "· not yet wired".
 * 2. Tapping the wired item adds a row: the Entry gains a reps/load control
 *    pair, the session's total (M) grows by one, done (N) does not, and the
 *    new row is not yet logged.
 * 3. The new row's own confirm logs its own actual — same resolved
 *    prescription as Back Squat's working Sets, a genuinely new `setId`,
 *    `entryId: "entry-1"`, `setType: "working"` — and leaves `set-1`/`set-2`
 *    untouched.
 * 4. That actual, and the row itself, survive a reload.
 *
 * Text assertions are case-insensitive throughout (the surface's small-caps
 * chrome is a CSS transform; see docs/agents/testing.md).
 */

const CONFIRM_NAME = /^(Log as prescribed|Logged)$/;
const confirms = (page: Page) => page.getByRole("button", { name: CONFIRM_NAME });

/** Prescribed order down the screen; see log-straight-session.spec.ts. */
const SET = { squatFirst: 0, squatSecond: 1 } as const;

/**
 * Where the new row lands: the feature appends it to Back Squat's Entry,
 * directly after the Entry's two existing working sets and before Bench
 * Press — "the Entry's last working Set" is the anchor the feature is
 * specified against. This is an assumption about placement, not a claim
 * this file is really trying to make; tests 3 and 4 double-check it against
 * the server (entryId/setId), so a wrong index here would show up as a
 * legible mismatch rather than a false pass.
 */
const NEW_SET_INDEX = 2;

const openLogging = async (page: Page) => {
  await page.goto("/");
  await expectConnected(page);
  await expect(page.getByRole("heading", { name: "Today", exact: true })).toBeVisible();
  await page.getByRole("button", { name: /^Session 1/ }).click();
  await expect(page.getByRole("button", { name: "Back to Today" })).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText(/0\s*\/\s*6/)).toBeVisible();
};

/** Re-arrive at the Logging surface after a reload, however routing landed. */
const ensureOnLogging = async (page: Page) => {
  await expectConnected(page);
  const back = page.getByRole("button", { name: "Back to Today" });
  if (await back.isVisible().catch(() => false)) {
    return;
  }
  await expect(page.getByRole("heading", { name: "Today", exact: true })).toBeVisible();
  await page.getByRole("button", { name: /^Session 1/ }).click();
  await expect(back).toBeVisible({ timeout: 20_000 });
};

const openBackSquatSheet = (page: Page) => page.getByRole("button", { name: /^More for Back Squat$/i }).click();

const backSquatDialog = (page: Page) => page.getByRole("dialog", { name: /Back Squat/i });

/** Add the unplanned set and close the sheet, however it prefers to close. */
const addAnotherStraightSet = async (page: Page) => {
  await openBackSquatSheet(page);
  const dialog = backSquatDialog(page);
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: /Another straight set/i }).click();
  if (await dialog.isVisible().catch(() => false)) {
    await dialog.getByRole("button", { name: "Close" }).click();
  }
  await expect(dialog).toBeHidden();
};

type LoggedActual = {
  readonly commandId: string;
  readonly entryId?: string;
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
  return ((await response.json()) as { readonly actuals: readonly LoggedActual[] }).actuals;
};

test.describe("log an unplanned straight set", () => {
  test.afterEach(async ({ request, context }) => {
    await context.setOffline(false);
    await resetServer(request);
  });

  // #129/#130/#131 wired the last of these — the three continuations, "Add a
  // note", and "Swap this exercise" — alongside #115's "Another straight
  // set"; see add-a-note.spec.ts and swap-this-exercise.spec.ts for those
  // journeys in full. Updated here rather than left red, since this spec's
  // own claim ("the rest are not yet wired") is exactly what they changed.
  test("the sheet renders every item as wired, with none left saying not yet wired", async ({
    page,
  }) => {
    await openLogging(page);
    await openBackSquatSheet(page);

    const dialog = backSquatDialog(page);
    await expect(dialog).toBeVisible();

    const wired = [
      "Another straight set",
      "Drop set",
      "Rest-pause set",
      "Myo-cluster",
      "Add a note",
    ];
    for (const label of wired) {
      const item = dialog.getByRole("button", { name: new RegExp(label, "i") });
      await expect(item).toBeVisible();
      await expect(item).not.toHaveAccessibleName(/not yet wired/i);
    }

    // Swap (#131, ADR 0019) is wired too — Back Squat has zero logged Sets at
    // this point in the flow, so it is enabled, not just present.
    const swap = dialog.getByRole("button", { name: /Swap this exercise/i });
    await expect(swap).toBeVisible();
    await expect(swap).not.toHaveAccessibleName(/not yet wired/i);
    await expect(swap).toBeEnabled();

    // Nothing in the sheet is a dead tap any more, so the whole dialog is
    // asserted at once rather than by an ever-shrinking `stillUnwired` list.
    await expect(dialog.getByText(/not yet wired/i)).toHaveCount(0);

    await dialog.getByRole("button", { name: "Close" }).click();
    await expect(dialog).toBeHidden();
  });

  test("tapping it adds a new, unconfirmed Set row and grows the session's total, not its done count", async ({
    page,
  }) => {
    await openLogging(page);

    const repsButtons = page.getByRole("button", { name: /^reps — / });
    const loadButtons = page.getByRole("button", { name: /^load — / });
    await expect(repsButtons).toHaveCount(4);
    await expect(loadButtons).toHaveCount(5);
    await expect(confirms(page)).toHaveCount(6);

    await addAnotherStraightSet(page);

    // One more reps control and one more load control — the shape of a
    // straight working set, not a drop's load-only row.
    await expect(repsButtons).toHaveCount(5);
    await expect(loadButtons).toHaveCount(6);
    await expect(confirms(page)).toHaveCount(7);

    // The total (M) grew; done (N) did not.
    await expect(page.getByText(/0\s*\/\s*7/)).toBeVisible();
    await expect(page.getByText(/0 of 7 sets logged/i)).toBeVisible();
    await expect(page.getByRole("button", { name: "Logged" })).toHaveCount(0);
  });

  test("the new row echoes the last working Set's prescription and logs its own actual", async ({
    page,
    request,
  }) => {
    await openLogging(page);
    await addAnotherStraightSet(page);

    await expect(confirms(page)).toHaveCount(7);
    await expect(confirms(page).nth(SET.squatFirst)).toHaveAccessibleName("Log as prescribed");
    await expect(confirms(page).nth(SET.squatSecond)).toHaveAccessibleName("Log as prescribed");
    await expect(confirms(page).nth(NEW_SET_INDEX)).toHaveAccessibleName("Log as prescribed");

    await confirms(page).nth(NEW_SET_INDEX).click();
    await expect(confirms(page).nth(NEW_SET_INDEX)).toHaveAccessibleName("Logged");

    // The two original Back Squat sets are untouched by logging the new one.
    await expect(confirms(page).nth(SET.squatFirst)).toHaveAccessibleName("Log as prescribed");
    await expect(confirms(page).nth(SET.squatSecond)).toHaveAccessibleName("Log as prescribed");

    await expect(page.getByText(/1 of 7 sets logged/i)).toBeVisible();

    await expect
      .poll(async () => (await readActuals(request)).length, { timeout: 20_000 })
      .toBe(1);

    const [actual] = await readActuals(request);
    expect(actual?.entryId).toBe("entry-1");
    expect(actual?.setId).not.toBe("set-1");
    expect(actual?.setId).not.toBe("set-2");
    expect(actual?.setType).toBe("working");
    // Back Squat's resolved prescription: an exact target, so one tap
    // resolves to itself (ADR 0007) — the same values `set-1`/`set-2` log.
    expect(actual?.actual).toEqual({ reps: 5, load: 100 });
  });

  test("the unplanned set, once logged, survives a reload", async ({ page, request }) => {
    await openLogging(page);
    await addAnotherStraightSet(page);

    await expect(confirms(page)).toHaveCount(7);
    await confirms(page).nth(NEW_SET_INDEX).click();
    await expect(confirms(page).nth(NEW_SET_INDEX)).toHaveAccessibleName("Logged");
    await expect(page.getByText(/1 of 7 sets logged/i)).toBeVisible();

    await expect
      .poll(async () => (await readActuals(request)).length, { timeout: 20_000 })
      .toBe(1);

    await page.reload();
    await ensureOnLogging(page);

    // Same Entry, same shape, still logged — reconstructed from the server,
    // not merely surviving because the tab never unloaded.
    await expect(confirms(page)).toHaveCount(7);
    await expect(confirms(page).nth(NEW_SET_INDEX)).toHaveAccessibleName("Logged");
    await expect(page.getByText(/1 of 7 sets logged/i)).toBeVisible();
    await expect(page.getByText(/1\s*\/\s*7/)).toBeVisible();

    expect(await readActuals(request)).toHaveLength(1);
  });
});
