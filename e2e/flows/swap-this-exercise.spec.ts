import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

import { expectConnected, resetServer, setOffline } from "../driver.ts";

const DEV_SERVER_HTTP_URL = "http://127.0.0.1:4010";

/**
 * "Swap this exercise" (issue #131, ADR 0019).
 *
 * The per-Entry "+" affordance (`More for <Exercise>`) opens a bottom sheet;
 * "Swap this exercise" is the item this ticket wires. Tapping it opens the
 * same catalog picker the Plan editor uses; picking an exercise records the
 * swap as a pure actual-side annotation — the Entry renders the PERFORMED
 * exercise as its title, with a small "swapped from <prescribed>" line
 * underneath, and the prescribed exercise itself is never overwritten.
 *
 * Back Squat (`entry-1`) is the fixture, swapped to the already-seeded Leg
 * Press — an existing catalog exercise, so the swap works fully offline. The
 * seeded Session prescribes all four catalog exercises exactly once each
 * (`entry-1..4`), so whichever target is picked, its name is on screen
 * TWICE after the swap (the swapped Entry plus its own original one) — every
 * DOM assertion below is written for that, using `.first()` (entry-1 renders
 * before entry-4 — `log-straight-session.spec.ts` documents the same block
 * order) and the authoritative `entryId` check against `/__test__/entry-swaps`
 * rather than trusting name uniqueness.
 *
 * Five claims, one test each:
 * 1. The sheet renders "Swap this exercise" as wired (companion assertion to
 *    `log-unplanned-straight-set.spec.ts`'s own check of the same sheet).
 * 2. Picking an exercise swaps the Entry's displayed name and shows the
 *    prescribed one underneath — the coach's read-back claim, checked via
 *    `/__test__/entry-swaps` (performed) against `/__test__/plan` (prescribed,
 *    untouched) and `/__test__/changes` (no Change minted).
 * 3. Once any Set on the swapped Entry is logged, the affordance disables
 *    itself rather than disappearing (ADR 0019's already-logged-Sets rule).
 * 4. It survives a reload.
 * 5. It works fully offline and flushes on reconnect — one command, once.
 *
 * Text assertions are case-insensitive throughout (the surface's small-caps
 * chrome is a CSS transform; see docs/agents/testing.md).
 */

const CONFIRM_NAME = /^(Log as prescribed|Logged)$/;
const confirms = (page: Page) => page.getByRole("button", { name: CONFIRM_NAME });

interface EntrySwap {
  readonly commandId: string;
  readonly entryId: string;
  readonly exerciseId: string;
}

interface PlanShape {
  readonly sessions: ReadonlyArray<{
    readonly blocks: ReadonlyArray<{
      readonly entries: ReadonlyArray<{ readonly id: string; readonly exerciseId: string }>;
    }>;
  }>;
}

const readSwaps = async (request: APIRequestContext): Promise<ReadonlyArray<EntrySwap>> => {
  const response = await request.get(`${DEV_SERVER_HTTP_URL}/__test__/entry-swaps`);
  expect(response.ok()).toBe(true);
  return ((await response.json()) as { readonly swaps: ReadonlyArray<EntrySwap> }).swaps;
};

const readPlan = async (request: APIRequestContext): Promise<PlanShape> => {
  const response = await request.get(`${DEV_SERVER_HTTP_URL}/__test__/plan`);
  expect(response.ok()).toBe(true);
  return ((await response.json()) as { readonly plan: PlanShape }).plan;
};

const countChanges = async (request: APIRequestContext): Promise<number> => {
  const response = await request.get(`${DEV_SERVER_HTTP_URL}/__test__/changes`);
  expect(response.ok()).toBe(true);
  return ((await response.json()) as { readonly changes: ReadonlyArray<unknown> }).changes.length;
};

const openLogging = async (page: Page) => {
  await page.goto("/");
  await expectConnected(page);
  await expect(page.getByRole("heading", { name: "Today", exact: true })).toBeVisible();
  await page.getByRole("button", { name: /^Session 1/ }).click();
  await expect(page.getByRole("button", { name: "Back to Today" })).toBeVisible({ timeout: 20_000 });
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

/**
 * Opens the "+" sheet on Back Squat, taps Swap, and picks Leg Press from the
 * catalog picker. After this, "Leg Press" is the accessible name of TWO
 * Entries (the swapped one, first in DOM order, and its own original one,
 * last) — see the file doc for why.
 */
const swapBackSquatToLegPress = async (page: Page) => {
  await openBackSquatSheet(page);
  const dialog = backSquatDialog(page);
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: /Swap this exercise/i }).click();
  await expect(dialog).toBeHidden();

  const picker = page.getByText("Exercise catalog");
  await expect(picker).toBeVisible();
  await page.getByPlaceholder("Search the catalog").fill("Leg Press");
  await page.getByRole("listitem").filter({ hasText: "Leg Press" }).getByRole("button").first().click();
  await expect(picker).toHaveCount(0);
};

test.describe("swap this exercise", () => {
  test.afterEach(async ({ request, context }) => {
    await setOffline(context, false);
    await resetServer(request);
  });

  test('the sheet renders "Swap this exercise" as wired and enabled before any Set is logged', async ({
    page,
  }) => {
    await openLogging(page);
    await openBackSquatSheet(page);

    const dialog = backSquatDialog(page);
    const swap = dialog.getByRole("button", { name: /Swap this exercise/i });
    await expect(swap).toBeVisible();
    await expect(swap).not.toHaveAccessibleName(/not yet wired/i);
    await expect(swap).toBeEnabled();

    await dialog.getByRole("button", { name: "Close" }).click();
  });

  test("swapping updates the Entry's title, keeps the prescribed exercise legible underneath, and never touches the Plan", async ({
    page,
    request,
  }) => {
    await openLogging(page);
    const changesBefore = await countChanges(request);
    const planBefore = await readPlan(request);
    const entry1Before = planBefore.sessions
      .flatMap((session) => session.blocks.flatMap((block) => block.entries))
      .find((entry) => entry.id === "entry-1");

    await swapBackSquatToLegPress(page);

    // Performed exercise takes the title position; the prescribed one is
    // stated underneath, not hidden and not overwritten — a typography
    // decision, not a new card (#115's constraint). Now two Entries read
    // "Leg Press" — the swapped one (first) and its own original (last).
    await expect(page.getByRole("heading", { name: "Leg Press", exact: true })).toHaveCount(2);
    await expect(page.getByText(/swapped from back squat/i)).toBeVisible();
    await expect(page.getByRole("button", { name: /^More for Leg Press$/i })).toHaveCount(2);

    // The coach's read-back claim: prescribed (Plan, untouched) and performed
    // (the swap record) are both readable, and they disagree on purpose. The
    // `entryId` is the authoritative claim — name overlap is expected here.
    await expect.poll(async () => (await readSwaps(request)).length, { timeout: 20_000 }).toBe(1);
    const [swap] = await readSwaps(request);
    expect(swap?.entryId).toBe("entry-1");
    expect(swap?.exerciseId).not.toBe(entry1Before?.exerciseId);

    const planAfter = await readPlan(request);
    expect(planAfter).toEqual(planBefore);
    expect(await countChanges(request)).toBe(changesBefore);
  });

  test("once a Set on the swapped Entry is logged, the swap affordance disables itself rather than disappearing", async ({
    page,
  }) => {
    await openLogging(page);
    await swapBackSquatToLegPress(page);

    // Log the swapped Entry's first Set — entry-1 renders first in DOM order
    // (block-1, before block-2/3), so its row is the very first confirm
    // control on the whole grid.
    await confirms(page).first().click();
    await expect(confirms(page).first()).toHaveAccessibleName("Logged");

    // `.first()`: the swapped Entry (entry-1) renders before its own
    // original (entry-4) — see the file doc.
    await page.getByRole("button", { name: /^More for Leg Press$/i }).first().click();
    const dialogs = page.getByRole("dialog", { name: /Leg Press/i });
    await expect(dialogs.first()).toBeVisible();
    const swap = dialogs.first().getByRole("button", { name: /Swap this exercise/i });
    await expect(swap).toBeVisible();
    await expect(swap).toBeDisabled();
    await expect(swap).toHaveAccessibleName(/already logged/i);

    await dialogs.first().getByRole("button", { name: "Close" }).click();
  });

  test("a swap survives a reload", async ({ page, request }) => {
    await openLogging(page);
    await swapBackSquatToLegPress(page);
    await expect.poll(async () => (await readSwaps(request)).length, { timeout: 20_000 }).toBe(1);

    await page.reload();
    await ensureOnLogging(page);

    await expect(page.getByRole("heading", { name: "Leg Press", exact: true })).toHaveCount(2);
    await expect(page.getByText(/swapped from back squat/i)).toBeVisible();
    expect(await readSwaps(request)).toHaveLength(1);
  });

  test("a swap made offline is queued, renders immediately, and flushes exactly once on reconnect", async ({
    page,
    request,
    context,
  }) => {
    await openLogging(page);
    await setOffline(context, true);

    await swapBackSquatToLegPress(page);

    // Rendered immediately, before any server ack — the "queued" marker is
    // the only tell, same idiom the confirmed-set rows already use.
    await expect(page.getByRole("heading", { name: "Leg Press", exact: true })).toHaveCount(2);
    await expect(page.getByText(/swapped from back squat/i)).toBeVisible();
    await expect(page.getByText(/queued/i).first()).toBeVisible();

    await setOffline(context, false);
    await expectConnected(page);

    await expect.poll(async () => (await readSwaps(request)).length, { timeout: 20_000 }).toBe(1);
    const [swap] = await readSwaps(request);
    expect(swap?.entryId).toBe("entry-1");
  });
});
