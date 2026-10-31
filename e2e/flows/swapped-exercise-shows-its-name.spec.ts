import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

import { expectConnected, resetServer, setOffline } from "../driver.ts";

const DEV_SERVER_HTTP_URL = "http://127.0.0.1:4010";

/**
 * "When I swapped last workout I got an id instead of the exercise name."
 *
 * The owner swapped an Entry mid-workout and the Entry's title read as a raw
 * id (something like `2c345288 6ade 4859 …`) instead of the exercise. An
 * exercise CREATED in the picker gets a UUID-style id, and it is the one
 * exercise the Logging surface cannot know the name of without reading the
 * catalog — so it is the fixture that exposes a catalog read that failed or
 * lost a race and never came back.
 *
 * The claim, from every angle a phone produces it: the swapped Entry's heading
 * is the name the user typed, the `swapped from Back Squat` line is there, and
 * nothing on the Logging surface reads like an id — not on first render, not
 * after a reload, not after a reload whose connection dropped while the page
 * was coming up, and not after a reload attempted with no network at all.
 *
 * Black-box: visible text, accessible names, and `/__test__/entry-swaps` to
 * know the swap reached the server before reloading.
 */

const CREATED = "Safety Bar Box Squat";

/** `2c345288-6ade-…` or `2c345288 6ade …` — an id, whichever way it's rendered. */
const ID_LIKE = /[0-9a-f]{8}[- ][0-9a-f]{4}/i;

interface EntrySwap {
  readonly entryId: string;
  readonly exerciseId: string;
}

const readSwaps = async (request: APIRequestContext): Promise<ReadonlyArray<EntrySwap>> => {
  const response = await request.get(`${DEV_SERVER_HTTP_URL}/__test__/entry-swaps`);
  expect(response.ok()).toBe(true);
  return ((await response.json()) as { readonly swaps: ReadonlyArray<EntrySwap> }).swaps;
};

const todayHeading = (page: Page) => page.getByRole("heading", { name: "Today", exact: true });
const backToToday = (page: Page) => page.getByRole("button", { name: "Back to Today" });
const createdHeading = (page: Page) => page.getByRole("heading", { name: CREATED, exact: true });

const startSession1 = async (page: Page) => {
  await page.goto("/");
  await expectConnected(page);
  await expect(todayHeading(page)).toBeVisible();
  await page.getByRole("button", { name: /^Session 1/ }).click();
  await expect(backToToday(page)).toBeVisible({ timeout: 20_000 });
};

/** Re-arrive at the Logging surface after a reload, however routing landed. */
const ensureOnLogging = async (page: Page) => {
  await expectConnected(page);
  if (await backToToday(page).isVisible().catch(() => false)) return;
  await expect(todayHeading(page)).toBeVisible();
  await page.getByRole("button", { name: /^Session 1/ }).click();
  await expect(backToToday(page)).toBeVisible({ timeout: 20_000 });
};

/**
 * Swap Back Squat (`entry-1`) to an exercise the catalog lacks, created from
 * the swap picker's `Create “<name>”` row, and wait for the server to hold it.
 */
const swapBackSquatToCreated = async (page: Page, request: APIRequestContext): Promise<string> => {
  await page.getByRole("button", { name: /^More for Back Squat$/i }).click();
  const sheet = page.getByRole("dialog", { name: /Back Squat/i });
  await expect(sheet).toBeVisible();
  await sheet.getByRole("button", { name: /Swap this exercise/i }).click();
  await expect(sheet).toBeHidden();

  const picker = page.getByText("Exercise catalog");
  await expect(picker).toBeVisible();
  await page.getByPlaceholder("Search the catalog").fill(CREATED);
  await page.getByRole("button", { name: new RegExp(`^Create\\s*[“"]${CREATED}[”"]`) }).click();
  await expect(picker).toHaveCount(0);

  await expect
    .poll(async () => (await readSwaps(request)).filter((swap) => swap.entryId === "entry-1").length, {
      timeout: 20_000,
    })
    .toBe(1);
  const swap = (await readSwaps(request)).find((candidate) => candidate.entryId === "entry-1");
  return swap!.exerciseId;
};

/**
 * The swapped Entry reads as the created name, says what it was swapped from,
 * and no text or accessible name on the surface looks like an id.
 */
const expectNameNotId = async (page: Page, exerciseId: string) => {
  await expect(createdHeading(page)).toBeVisible({ timeout: 20_000 });
  await expect(createdHeading(page)).toHaveCount(1);
  await expect(page.getByText(/swapped from back squat/i)).toBeVisible();
  await expect(page.getByRole("button", { name: `More for ${CREATED}`, exact: true })).toHaveCount(1);

  // No heading, text node or control name carries the id, in either spelling.
  await expect(page.getByRole("heading", { name: ID_LIKE })).toHaveCount(0);
  await expect(page.getByRole("button", { name: ID_LIKE })).toHaveCount(0);
  await expect(page.getByText(ID_LIKE)).toHaveCount(0);
  const text = await page.evaluate(() => document.body.innerText);
  expect(text).not.toMatch(ID_LIKE);
  expect(text).not.toContain(exerciseId);
  expect(text.toLowerCase()).not.toContain(exerciseId.toLowerCase().replace(/-/g, " "));
};

test.describe("a swapped exercise shows its name, never an id", () => {
  test.beforeEach(async ({ request }) => {
    await resetServer(request);
  });

  test.afterEach(async ({ request, context }) => {
    await setOffline(context, false);
    await resetServer(request);
  });

  test("swapping to an exercise created in the picker titles the Entry with the typed name", async ({
    page,
    request,
  }) => {
    await startSession1(page);
    const exerciseId = await swapBackSquatToCreated(page, request);
    // The premise: a created exercise really does get an id that reads like one.
    expect(exerciseId).not.toBe(CREATED);
    await expectNameNotId(page, exerciseId);
  });

  test("after a reload, the swapped Entry still shows the created name", async ({ page, request }) => {
    await startSession1(page);
    const exerciseId = await swapBackSquatToCreated(page, request);

    await page.reload();
    await ensureOnLogging(page);
    await expectNameNotId(page, exerciseId);

    // And a second reload, for a race that only loses some of the time.
    await page.reload();
    await ensureOnLogging(page);
    await expectNameNotId(page, exerciseId);
  });

  test("after a reload whose connection drops while the page comes up, the name arrives once back online", async ({
    page,
    request,
    context,
  }) => {
    await startSession1(page);
    const exerciseId = await swapBackSquatToCreated(page, request);

    // The page's code loads, then the link dies before the socket and the
    // catalog read have settled — the phone-on-gym-wifi shape of the race.
    // (Cutting it any earlier strands the dev build's module graph half
    // fetched, which no service worker rescues — not the claim here.)
    await page.reload({ waitUntil: "load" });
    await setOffline(context, true);
    await page.waitForTimeout(3_000);
    await setOffline(context, false);

    await ensureOnLogging(page);
    await expectNameNotId(page, exerciseId);
  });

  test("after reloads whose socket the server drops while the page comes up, the name still arrives", async ({
    page,
    request,
  }) => {
    await startSession1(page);
    const exerciseId = await swapBackSquatToCreated(page, request);

    // A dead link right as the app opens its socket and asks for the catalog,
    // a few times over, at a few different moments: whichever read is in
    // flight dies with it, and the app has to ask again rather than settle
    // for an id. Several reloads, since a race only loses some of the time.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await page.reload({ waitUntil: "load" });
      for (const delayMs of [0, 150, 400, 900]) {
        await page.waitForTimeout(delayMs);
        await request.post(`${DEV_SERVER_HTTP_URL}/__test__/drop-socket`).catch(() => undefined);
      }
      await ensureOnLogging(page);
      await expectNameNotId(page, exerciseId);
    }
  });

  test("after a reload attempted offline, going back online shows the created name", async ({
    page,
    request,
    context,
  }) => {
    await startSession1(page);
    const exerciseId = await swapBackSquatToCreated(page, request);

    await setOffline(context, true);
    // With no service worker in the dev build the reload itself may fail to
    // load; either way the user comes back online and the app must recover.
    await page.reload().catch(() => undefined);
    await page.waitForTimeout(1_500);
    await setOffline(context, false);

    if (!(await backToToday(page).isVisible().catch(() => false))) {
      await page.goto("/").catch(() => undefined);
    }
    await ensureOnLogging(page);
    await expectNameNotId(page, exerciseId);
  });

  test("leaving the workout for Today and coming back still shows the created name", async ({ page, request }) => {
    await startSession1(page);
    const exerciseId = await swapBackSquatToCreated(page, request);

    await backToToday(page).click();
    await expect(todayHeading(page)).toBeVisible();
    // Nothing on Today should name the swapped exercise by its id either.
    expect(await page.evaluate(() => document.body.innerText)).not.toMatch(ID_LIKE);

    await page.getByRole("button", { name: /^Session 1/ }).click();
    await expect(backToToday(page)).toBeVisible({ timeout: 20_000 });
    await expectNameNotId(page, exerciseId);
  });
});
