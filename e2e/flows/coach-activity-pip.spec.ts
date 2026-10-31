import { expect, test, type Page } from "@playwright/test";

import { expectConnected, resetServer } from "../driver.ts";

const DEV_SERVER_HTTP_URL = process.env["REPCOACH_DEV_SERVER_HTTP_URL"] ?? "http://127.0.0.1:4010";

/**
 * The Coach glyph's activity pip (issue #150, ADR 0021).
 *
 * Background: the Coach destination has always carried a numeric badge that
 * counts **decisions you owe an answer to** — and, by design (#42 user story
 * 36), nothing else. So two things had no representation on the destination at
 * all: a Deliberation run that finished while you were not looking, and a run
 * that failed (which otherwise survives only as a line of status-strip text
 * that is gone the moment you look away). The pip is the fix: a dot on the
 * glyph meaning "there is coach output you have not seen".
 *
 * The pip and the count are deliberately independent signals. This file proves
 * both halves of that:
 *
 *  1. the pip lights for a settled run and clears when you open Coach;
 *  2. driving a brand-new run onto the record re-lights the pip AND moves the
 *     decisions-owed count — separately, each still saying its own true thing.
 *
 * ## Selectors — black-box, per the adversarial-author contract
 *
 * The pip contributes the text "new activity" to the Coach link's accessible
 * name (the dot itself is `aria-hidden` — a bare dot announces nothing). So
 * "the pip is lit" is `the Coach link is named /coach.*new activity/i`, and
 * "the pip is dark" is the same name without that phrase. No test id, no class.
 *
 * The decisions-owed count renders as the only digits inside the Coach link,
 * so `countOnCoach` reads them off the accessible name. Its exact seeded value
 * is not asserted — only that pushing one Proposal moves it by exactly one,
 * which is the claim that the pip has not disturbed it.
 *
 * `/__test__/push-proposal` mints a genuine new "on demand" Deliberation run
 * that arrives over the live subscription (the same lever
 * `the-coach-record.spec.ts` uses to prove newest-first ordering) and, with
 * it, one new pending Proposal — so a single call exercises both signals.
 */

const coachLink = (page: Page) => page.getByRole("link", { name: /coach/i }).first();

const expectPipLit = async (page: Page) =>
  expect(coachLink(page)).toHaveAccessibleName(/new activity/i, { timeout: 20_000 });

const expectPipDark = async (page: Page) =>
  expect(coachLink(page)).not.toHaveAccessibleName(/new activity/i, { timeout: 20_000 });

/** The decisions-owed count: the digits in the Coach link's accessible name, 0 if none. */
const countOnCoach = async (page: Page): Promise<number> => {
  const name = (await coachLink(page).getAttribute("aria-label")) ?? (await coachLink(page).textContent()) ?? "";
  const digits = name.match(/\d+/);
  return digits === null ? 0 : Number(digits[0]);
};

const openTodayFresh = async (page: Page) => {
  await page.goto("/");
  await expectConnected(page);
  await expect(page.getByRole("heading", { name: "Today", exact: true })).toBeVisible();
};

const openCoachRecord = async (page: Page) => {
  await coachLink(page).click();
  // A run node announces itself with its cadence — waiting on one is how we
  // know the record actually rendered before we navigate away again.
  await expect(
    page.getByRole("button", { name: /(session review|cycle review|revision run|on demand)/i }).first(),
  ).toBeVisible({ timeout: 20_000 });
};

test.describe("The Coach activity pip", () => {
  test.afterEach(async ({ request }) => {
    await resetServer(request);
  });

  test("lights for an unseen run and clears once Coach has been opened", async ({ page }) => {
    await openTodayFresh(page);

    // The seed carries finished Deliberation runs and this browser has never
    // opened the record, so every one of them is unseen: the pip is lit.
    await expectPipLit(page);

    // Open the record, then come back to Today.
    await openCoachRecord(page);
    await page.goBack();
    await expect(page.getByRole("heading", { name: "Today", exact: true })).toBeVisible();

    // Nothing new has happened since, so the pip is dark.
    await expectPipDark(page);

    // And it stays dark across a reload — "seen" is remembered, not just a
    // React state that a refresh would clear.
    await page.reload();
    await expectConnected(page);
    await expectPipDark(page);
  });

  test("a new run re-lights the pip, and the decisions-owed count moves with it but separately", async ({
    page,
  }) => {
    await openTodayFresh(page);
    await openCoachRecord(page);
    await page.goBack();
    await expect(page.getByRole("heading", { name: "Today", exact: true })).toBeVisible();
    await expectPipDark(page);

    const countBefore = await countOnCoach(page);

    // A genuinely new run, minted now, arriving over the live subscription —
    // no reload.
    await page.request.post(`${DEV_SERVER_HTTP_URL}/__test__/push-proposal`);

    // The pip comes back: there is output on the record this browser has not
    // seen.
    await expectPipLit(page);

    // And the decisions-owed count went up by exactly one — the pip did not
    // replace it, corrupt it, or stop it tracking pending Proposals.
    await expect.poll(() => countOnCoach(page), { timeout: 20_000 }).toBe(countBefore + 1);

    // Opening the record clears the pip again; the count is untouched by that,
    // because opening Coach is not deciding anything.
    await openCoachRecord(page);
    await page.goBack();
    await expect(page.getByRole("heading", { name: "Today", exact: true })).toBeVisible();
    await expectPipDark(page);
    expect(await countOnCoach(page)).toBe(countBefore + 1);
  });
});
