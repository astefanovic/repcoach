import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

import { expectConnected, resetServer, setOffline, snapshotText } from "../driver.ts";

const DEV_SERVER_HTTP_URL = "http://127.0.0.1:4010";

/**
 * Logging a prescribed drop set (issue #20, re-derived for #82 item 4).
 *
 * Skipped by #50 against a fixture-driven surface, and written then against
 * `set-set-6-type-label`. #72 landed the real surface; the ids are gone, and
 * the note that shipped with the skip was right about what to do next — #63
 * gave "visually distinguishable" a settled meaning, so it is re-derived here
 * rather than restored.
 *
 * The seed's Leg Press is the fixture: one working set, followed by a
 * prescribed drop continuation of it. What that costs the design, and what
 * this file therefore proves:
 *
 * - **Prescribed specials render inline, indented under their parent, kind
 *   named** (ui-surfaces.md → Logging → #63). All three halves matter.
 *   *Inline*, because #63 put the "+" on the Entry for the **spontaneous**
 *   case only — a drop the Plan already prescribes must not be something the
 *   user has to go and find. *Indented under its parent*, because a drop set
 *   is meaningless read on its own: it is a continuation of the nearest
 *   preceding working set, and the indent is what says so. *Kind named*,
 *   because "drop", "rest-pause" and "myo-cluster" are performed differently
 *   and a generic marker would make the user remember which one they wrote.
 * - **Leg Press is a Block of one, so no wrapper.** The drop does not make it
 *   a group — grouping is about exercises, not set kinds — so the surface
 *   still carries exactly the one wrapper the seeded superset earns.
 * - **It logs independently.** The continuation is its own set with its own
 *   confirm; logging it does not log its parent, and logging the parent does
 *   not log it. A drop that rode along with its parent would be untrackable
 *   the moment a session went differently than written.
 * - **Its cap is a range, and one tap resolves to the top of it.** The
 *   prescription is `≤60 kg` — a ceiling, not a target — and one tap means 60,
 *   consistently with every other range on the surface (ADR 0007).
 * - **It declares load only.** The metric-driven row (#63) again: a drop set
 *   whose prescription names no rep target renders no reps control, and the
 *   actual that reaches the server carries none either.
 * - **The write goes through the outbox** — `GET /__test__/logged-actuals` is
 *   the only place `setType: "drop"` can be checked, and it is worth checking:
 *   a drop logged as a straight set is a silently wrong training record.
 *
 * Two more tests (#129 item 1/2) extend this file rather than duplicating it,
 * covering the *spontaneous* half of the same story — a drop added from the
 * per-Entry "+" sheet rather than prescribed by the Plan:
 *
 * - **The spontaneous drop echoes the working reps but leaves the load
 *   open.** "Reduced load, immediately, no rest" is the whole point of a
 *   drop, so nothing here should guess the reduced number — the row still
 *   carries the anchor's reps target, but confirming it as-is (no load typed)
 *   logs no `load` key at all, proof the field was genuinely left for the
 *   user rather than silently defaulted.
 * - **It goes through the outbox offline, exactly once, on reconnect** —
 *   the same guarantee `confirmSet` already gives a prescribed Set, proven
 *   here for the unplanned path specifically, since #129's own client-only
 *   `extraSets` state (never persisted until confirmed) is new surface area
 *   the guarantee has to hold over.
 */

const CONFIRM_NAME = /^(Log as prescribed|Logged)$/;
const confirms = (page: Page) => page.getByRole("button", { name: CONFIRM_NAME });

/** Prescribed order down the screen; see log-straight-session.spec.ts. */
const SET = { legPress: 4, legPressDrop: 5 } as const;

const blockLabels = (page: Page) => page.getByText(/\[(superset|circuit|emom|amrap)\b/i);

/** The drop's cap, tolerant of `<=` vs `≤` — the glyph is not the claim. */
const DROP_CAP = /(<=|≤)\s*60/;

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

const legPressDialog = (page: Page) => page.getByRole("dialog", { name: /Leg Press/i });

/** Adds a spontaneous drop via the per-Entry sheet and closes it, however it prefers to close. */
const addSpontaneousDrop = async (page: Page) => {
  await page.getByRole("button", { name: /^More for Leg Press$/i }).click();
  const dialog = legPressDialog(page);
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: /^Drop set/i }).click();
  if (await dialog.isVisible().catch(() => false)) {
    await dialog.getByRole("button", { name: "Close" }).click();
  }
  await expect(dialog).toBeHidden();
};

/** Where the spontaneous drop lands: appended after Leg Press's prescribed working set AND its prescribed drop, since it is itself a continuation of the same anchor. */
const SPONTANEOUS_DROP_INDEX = 6;

test.describe("log a drop set", () => {
  test.afterEach(async ({ request, context }) => {
    await setOffline(context, false);
    await resetServer(request);
  });

  test("the prescribed drop renders inline under its parent, indented and kind-named", async ({
    page,
  }) => {
    await openLogging(page);

    // Inline: it is on screen the moment the Session opens, with nothing
    // expanded. The per-Entry "+" is for spontaneous work, and a prescribed
    // drop must not be hiding behind it.
    await expect(page.getByText(/^drop$/i)).toBeVisible();
    await expect(page.getByText(DROP_CAP)).toBeVisible();
    await expect(page.getByRole("button", { name: /^More for Leg Press$/i })).toBeVisible();

    // Indented under its parent, and after it: the continuation marker sits
    // below the Leg Press header and below the working set it continues (`80`
    // is the only load on the Session that reads that way). `innerText` puts
    // every metric field on its own line, so the row is located by the load
    // alone — there is no `80 kg` to search for.
    const body = (await snapshotText(page)).toLowerCase();
    const legPressHeader = body.indexOf("leg press");
    const workingRow = body.indexOf("80");
    const continuation = body.indexOf("↳");
    expect(legPressHeader).toBeGreaterThan(-1);
    expect(workingRow).toBeGreaterThan(legPressHeader);
    expect(continuation).toBeGreaterThan(workingRow);

    // A drop does not turn its Entry into a group: the seeded superset is
    // still the only Block with a wrapper on screen.
    await expect(blockLabels(page)).toHaveCount(1);

    // Load only. No rep target is prescribed for the drop, so no reps control
    // is offered for it — the four reps controls on the surface belong to the
    // two Back Squat sets, the Bench Press set and the Leg Press working set.
    await expect(page.getByRole("button", { name: /^reps — / })).toHaveCount(4);
    await expect(page.getByRole("button", { name: /^load — / })).toHaveCount(5);
  });

  test("the drop logs independently of its parent, resolving its cap to the top", async ({
    page,
    request,
  }) => {
    await openLogging(page);

    // Log the continuation and *not* its parent — the harder direction, since
    // a drop that logged as part of its parent would still look right if the
    // parent were tapped first.
    await confirms(page).nth(SET.legPressDrop).click();
    await expect(confirms(page).nth(SET.legPressDrop)).toHaveAccessibleName("Logged");
    await expect(confirms(page).nth(SET.legPress)).toHaveAccessibleName("Log as prescribed");
    await expect(page.getByText(/1 of 6 sets logged/i)).toBeVisible();

    await expect
      .poll(async () => (await readActuals(request)).length, { timeout: 20_000 })
      .toBe(1);

    const [dropActual] = await readActuals(request);
    // Top of the cap, and load alone — no invented rep count.
    expect(dropActual?.actual).toEqual({ load: 60 });
    // The kind survives the trip. This is the assertion the surface cannot
    // make for itself: `DROP` on screen proves it was *rendered* as a drop,
    // not that it was *recorded* as one.
    expect(dropActual?.setType).toBe("drop");

    // Now the parent, and the two stay distinct commands against distinct
    // sets — no merging of a continuation into the set it continues.
    await confirms(page).nth(SET.legPress).click();
    await expect(page.getByText(/2 of 6 sets logged/i)).toBeVisible();

    await expect
      .poll(async () => (await readActuals(request)).length, { timeout: 20_000 })
      .toBe(2);

    const actuals = await readActuals(request);
    expect(new Set(actuals.map((entry) => entry.setId)).size).toBe(2);
    expect(new Set(actuals.map((entry) => entry.commandId)).size).toBe(2);
    expect(actuals.map((entry) => entry.actual)).toEqual(
      expect.arrayContaining([{ load: 60 }, { reps: 10, load: 80 }]),
    );
  });

  test("a spontaneous drop, added from the sheet, echoes the working reps but leaves the load open", async ({
    page,
    request,
  }) => {
    await openLogging(page);

    // Before: one continuation marker (the prescribed drop) and 6 confirms.
    await expect(page.getByText("↳")).toHaveCount(1);
    await expect(confirms(page)).toHaveCount(6);

    await addSpontaneousDrop(page);

    // After: a second continuation marker, a seventh confirm, still unlogged,
    // and the session total grows without growing done.
    await expect(page.getByText("↳")).toHaveCount(2);
    await expect(confirms(page)).toHaveCount(7);
    await expect(confirms(page).nth(SPONTANEOUS_DROP_INDEX)).toHaveAccessibleName(
      "Log as prescribed",
    );
    await expect(page.getByText(/0\s*\/\s*7/)).toBeVisible();

    // Logged as-is (no load typed): the reps target echoed from Leg Press's
    // working set resolves to 10, and the ABSENCE of a `load` key is the
    // proof the field was left open rather than silently defaulted.
    await confirms(page).nth(SPONTANEOUS_DROP_INDEX).click();
    await expect(confirms(page).nth(SPONTANEOUS_DROP_INDEX)).toHaveAccessibleName("Logged");
    await expect(page.getByText(/1 of 7 sets logged/i)).toBeVisible();

    await expect
      .poll(async () => (await readActuals(request)).length, { timeout: 20_000 })
      .toBe(1);

    const [spontaneousDrop] = await readActuals(request);
    expect(spontaneousDrop?.setId).not.toBe("set-5");
    expect(spontaneousDrop?.setId).not.toBe("set-6");
    expect(spontaneousDrop?.setType).toBe("drop");
    expect(spontaneousDrop?.actual).toEqual({ reps: 10 });
  });

  test("a spontaneous drop logged offline reaches the server as a drop, exactly once, on reconnect", async ({
    page,
    request,
    context,
  }) => {
    await openLogging(page);
    await addSpontaneousDrop(page);
    await expect(confirms(page)).toHaveCount(7);

    await setOffline(context, true);

    await confirms(page).nth(SPONTANEOUS_DROP_INDEX).click();
    // Logged locally at once (story 13: queued, not lost) — the strip is what
    // says it has not reached the server yet.
    await expect(confirms(page).nth(SPONTANEOUS_DROP_INDEX)).toHaveAccessibleName("Logged");
    await expect(page.getByText(/1 of 7 sets logged/i)).toBeVisible();

    // Nothing has reached the server while offline — read through a request
    // context the page's own offline emulation does not touch.
    expect(await readActuals(request)).toHaveLength(0);

    await setOffline(context, false);

    await expect
      .poll(async () => (await readActuals(request)).length, { timeout: 20_000 })
      .toBe(1);

    const [flushed] = await readActuals(request);
    expect(flushed?.setType).toBe("drop");
    expect(flushed?.actual).toEqual({ reps: 10 });

    // Reload after reconnect: still exactly one row, not a retry-duplicate.
    await page.reload();
    await expect(page.getByRole("button", { name: "Back to Today" })).toBeVisible({
      timeout: 20_000,
    });
    await expect(page.getByText(/1\s*\/\s*7/)).toBeVisible();
    expect(await readActuals(request)).toHaveLength(1);
  });
});
