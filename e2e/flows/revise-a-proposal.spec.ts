import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

import { expectConnected, resetServer, setOffline } from "../driver.ts";

const DEV_SERVER_HTTP_URL = "http://127.0.0.1:4010";

/**
 * Revise: the user pushes back on a Proposal (issue #77, ADR 0013).
 *
 * Replaces `coaching-feed.spec.ts`, which was written against the pre-#42
 * information architecture (one "feed" of Proposals, driven by `getByTestId`)
 * and was left permanently skipped. #77 says it is to be *replaced by a new
 * flow against the settled IA*, not repaired — so the only thing carried over
 * is its one genuinely valuable claim, the server-side proof that Accept
 * mutates the Plan (`GET /__test__/plan`, load target up by 2.5). Everything
 * else here is new, and every assertion is on visible text or an ARIA role,
 * per the adversarial-author contract in docs/agents/testing.md.
 *
 * What this file proves, journey by journey — each one is a claim ADR 0013
 * makes that a user can check with their eyes:
 *
 * - §1 / #42: Revise expands **in place on the card** and submitting does not
 *   navigate. The failure mode being guarded against is a chat destination
 *   sneaking in; the observable form of that is "after Send, the user is
 *   somewhere other than Today".
 * - §5: the card **locks** — Accept/Dismiss/Revise gone, Cancel the only way
 *   out — and the spinner **says which kind of waiting it is**, queued vs
 *   running. A silent queue reads as a broken button, so the wording is the
 *   behaviour, not decoration.
 * - §5: **Cancel returns the card to normal** and does not poison the card —
 *   a fresh Revise is accepted afterwards. Covered on **both** branches, which
 *   §5 treats as genuinely different operations: a *running* run is
 *   interrupted and its result abandoned, a *queued* one is dropped from the
 *   queue and never fires at all. The second is the state `quota-low` exists
 *   to reach, and its distinctive failure is a late dispatch — the dropped run
 *   firing once quota recovers and revising the card behind the user's back.
 * - §2: a revision **replaces** the original as the pending head. Two pending
 *   Proposals side by side is rejected outright, so the assertion is a count:
 *   exactly one Proposal card on Today, ever.
 * - §9: the user's own prose **stays on the card** as the current turn, with
 *   earlier turns folded behind a "show earlier turns" control.
 * - ADR 0008: Accept and Dismiss still resolve a Proposal off Today. This is
 *   the regression the old skipped spec was protecting; Accept is additionally
 *   verified server-side, because "the card disappeared" is not evidence the
 *   Plan actually changed.
 *
 * ## Why the levers are needed
 *
 * The dev-server's deliberator is canned and answers effectively instantly, so
 * the in-flight states — the whole subject of §5 — flicker past far faster than
 * a browser can observe. #77 added two gates to the control channel for
 * exactly this, and they are the *external* lever the contract demands (server
 * side, never a client hook):
 *
 * - `hold-deliberation` / `release-deliberation` pins a dispatched run in
 *   **running**;
 * - `quota-low` / `quota-available` makes a requested run **queue** instead of
 *   dispatching, which is the only way to see the queued wording at all.
 *
 * Both are restored by `POST /__test__/reset`, which every test tears down
 * through. Reset also *abandons* whatever is in flight before reseeding, so a
 * test that dies while holding a run cannot wedge the next file — and teardown
 * must not release the gates itself. See the `afterEach` for why that
 * distinction is load-bearing rather than pedantic.
 */

const REVISE_PROSE = "I can only train three days a week, not five.";
const SECOND_REVISE_PROSE = "And keep the squat volume where it is.";

const SEEDED_SUMMARY = "Increase back squat working load by 2.5kg.";
const REVISED_SUMMARY = "Add a fourth back squat working set next session to build volume headroom.";

/**
 * Every Proposal card announces itself with a `[Proposal]` header button.
 *
 * **Do not anchor this regex.** The header is a disclosure control, and the
 * caret glyph is part of its accessible name, not decoration outside it — the
 * name reads `▾[Proposal]Increase back squat working load by 2.5kg.` expanded,
 * and `▸…` collapsed (as entries on Coach are). A `/^\[Proposal\]/` anchor
 * therefore matches nothing at all, and does so *silently*: the count comes
 * back 0 and reads as "the card isn't there" rather than "the selector is
 * wrong". Matching unanchored keeps it indifferent to which way the caret is
 * pointing, which is the right posture anyway — whether the card is expanded
 * is not what any of these counts are about.
 */
const proposalHeaders = (page: Page) => page.getByRole("button", { name: /\[Proposal\]/ });

const openToday = async (page: Page) => {
  await page.goto("/");
  await expectConnected(page);
  await expect(page.getByRole("heading", { name: "Today", exact: true })).toBeVisible();
  await expect(page.getByText(SEEDED_SUMMARY)).toBeVisible({ timeout: 15_000 });
};

/** Open the Revise box and submit `prose`. Leaves the card in flight. */
const submitRevise = async (page: Page, prose: string) => {
  await page.getByRole("button", { name: "Revise", exact: true }).click();
  const box = page.getByPlaceholder("ask a question, object, or request a change");
  await expect(box).toBeVisible();
  await box.fill(prose);
  await page.getByRole("button", { name: "Send", exact: true }).click();
};

/** Read the seeded session's first working-set load target, server-side. */
const readLoadTarget = async (request: APIRequestContext): Promise<number | undefined> => {
  const response = await request.get(`${DEV_SERVER_HTTP_URL}/__test__/plan`);
  expect(response.ok()).toBe(true);
  const body = (await response.json()) as {
    readonly plan: {
      readonly sessions: ReadonlyArray<{
        readonly blocks: ReadonlyArray<{
          readonly entries: ReadonlyArray<{
            readonly sets: ReadonlyArray<{ readonly target: { readonly load?: { readonly max?: number } } }>;
          }>;
        }>;
      }>;
    };
  };
  return body.plan.sessions[0]?.blocks[0]?.entries[0]?.sets[0]?.target.load?.max;
};

test.describe("Revise a Proposal", () => {
  test.afterEach(async ({ request, context }) => {
    // `reset` alone is the correct teardown, and deliberately so: it
    // **abandons** anything in flight — killing a held run before its commit —
    // then restores both levers, and only then reseeds.
    //
    // Do not "helpfully" release the gates first. `release-deliberation` means
    // *let the held run finish and commit its revision*, and it returns while
    // that commit is still in its tail — so the commit races the reseed and can
    // land after it, leaving the next flow to open Today onto a revised
    // Proposal where the seeded one belongs. That is a real failure that has
    // been hit. Abandoning is not a weaker release; it is the opposite
    // operation, and it is the one teardown wants.
    await setOffline(context, false);
    await resetServer(request);
  });

  test("Revise expands in place on the card and submitting keeps the user on Today", async ({ page }) => {
    await openToday(page);

    // Before: the card offers all three actions and no input.
    await expect(page.getByPlaceholder("ask a question, object, or request a change")).toHaveCount(0);
    await page.getByRole("button", { name: "Revise", exact: true }).click();

    // Expanded in place: the box appears *alongside* the card's own content —
    // the Proposal summary is still on screen, so this is not a navigation
    // dressed up as an expansion.
    const box = page.getByPlaceholder("ask a question, object, or request a change");
    await expect(box).toBeVisible();
    await expect(page.getByText(SEEDED_SUMMARY)).toBeVisible();
    await expect(page.getByRole("heading", { name: "Today", exact: true })).toBeVisible();

    // Send is inert until there is something to send: an empty Revise is not a
    // question, and firing a full Deliberation run on it would burn quota.
    await expect(page.getByRole("button", { name: "Send", exact: true })).toBeDisabled();
    await box.fill(REVISE_PROSE);
    await expect(page.getByRole("button", { name: "Send", exact: true })).toBeEnabled();
    await page.getByRole("button", { name: "Send", exact: true }).click();

    // Submitting does not navigate — no chat destination, no thread view
    // (ADR 0013, bounded by #42). Today's heading and its other sections are
    // still the surface the user is looking at.
    await expect(page.getByRole("heading", { name: "Today", exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Pick today's session" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Coach output" })).toBeVisible();
  });

  test("the card locks while the run is in flight, and the spinner says queued then running", async ({
    page,
    request,
  }) => {
    await openToday(page);

    // Pin the run before it is even dispatched: quota-low queues it, and the
    // hold catches it the moment quota recovers, so both wordings are
    // observable in one pass rather than raced against a canned deliberator.
    await request.post(`${DEV_SERVER_HTTP_URL}/__test__/quota-low`);
    await request.post(`${DEV_SERVER_HTTP_URL}/__test__/hold-deliberation`);

    await submitRevise(page, REVISE_PROSE);

    // Queued: the deferral queue is surfaced honestly rather than silently
    // delaying (ADR 0013 §5, ADR 0011 §8).
    await expect(page.getByText("Revising — waiting for a slot…")).toBeVisible({ timeout: 15_000 });

    // Locked: the three actions are gone, and Cancel is the only escape.
    // `/^Accept/` *is* safe to anchor — unlike the card header, the action
    // button carries no leading glyph; its whole accessible name is
    // `Accept — apply to plan`, and only the em dash is being avoided here.
    await expect(page.getByRole("button", { name: /^Accept/ })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Dismiss", exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Revise", exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Cancel", exact: true })).toBeVisible();

    // Quota recovers: the queued run drains into a dispatched one, and the
    // wording changes with it. A single spinner glyph for both states would
    // leave "waiting hours on quota" indistinguishable from "working on it".
    await request.post(`${DEV_SERVER_HTTP_URL}/__test__/quota-available`);
    await expect(page.getByText("Revising — running now…")).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText("Revising — waiting for a slot…")).toHaveCount(0);

    // Still locked while running.
    await expect(page.getByRole("button", { name: /^Accept/ })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Cancel", exact: true })).toBeVisible();

    // Let it land, and the card comes back to life.
    await request.post(`${DEV_SERVER_HTTP_URL}/__test__/release-deliberation`);
    await expect(page.getByText(REVISED_SUMMARY)).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole("button", { name: /^Accept/ })).toBeVisible();
  });

  test("cancelling a running run returns the card to normal, and a fresh Revise is accepted afterwards", async ({
    page,
    request,
  }) => {
    await openToday(page);

    await request.post(`${DEV_SERVER_HTTP_URL}/__test__/hold-deliberation`);
    await submitRevise(page, REVISE_PROSE);
    await expect(page.getByText("Revising — running now…")).toBeVisible({ timeout: 20_000 });

    await page.getByRole("button", { name: "Cancel", exact: true }).click();

    // Back to normal: the original Proposal, untouched, with all three actions
    // live again. Cancelling commits nothing (ADR 0013 §5), so the summary the
    // user is looking at is still the one they were arguing with.
    await expect(page.getByText(SEEDED_SUMMARY)).toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole("button", { name: /^Accept/ })).toBeVisible();
    await expect(page.getByRole("button", { name: "Dismiss", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Revise", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Cancel", exact: true })).toHaveCount(0);
    await expect(page.getByText("Revising — running now…")).toHaveCount(0);

    // And the card is not poisoned by the abandoned run: the "only one Revision
    // run in flight at a time" rule (§4) must not have been left latched on by
    // a run that never completed.
    await request.post(`${DEV_SERVER_HTTP_URL}/__test__/release-deliberation`);
    await submitRevise(page, SECOND_REVISE_PROSE);
    await expect(page.getByText(REVISED_SUMMARY)).toBeVisible({ timeout: 30_000 });
  });

  test("cancelling a queued run drops it from the queue, and it never fires when quota recovers", async ({
    page,
    request,
  }) => {
    await openToday(page);

    // Queued, not running: `quota-low` defers the run instead of dispatching
    // it, which is the other half of §5's escape contract. Nothing is held
    // here — there is nothing to hold, because nothing has dispatched.
    await request.post(`${DEV_SERVER_HTTP_URL}/__test__/quota-low`);
    await submitRevise(page, REVISE_PROSE);
    await expect(page.getByText("Revising — waiting for a slot…")).toBeVisible({ timeout: 15_000 });

    await page.getByRole("button", { name: "Cancel", exact: true }).click();

    // Back to normal, on the original Proposal.
    await expect(page.getByText(SEEDED_SUMMARY)).toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole("button", { name: /^Accept/ })).toBeVisible();
    await expect(page.getByRole("button", { name: "Dismiss", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Revise", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Cancel", exact: true })).toHaveCount(0);
    await expect(page.getByText("Revising — waiting for a slot…")).toHaveCount(0);

    // The real hazard on this branch: a cancelled-while-queued run that was
    // only *deferred*, not dropped, fires the moment quota recovers and
    // rewrites the card under a user who explicitly backed out. Nothing on
    // screen changes at the instant of that bug, so this needs a real beat
    // before the negative assertion — a bare `toHaveCount(0)` would pass
    // instantly and prove nothing. A fixed wait is the honest instrument for
    // "and then nothing happened".
    await request.post(`${DEV_SERVER_HTTP_URL}/__test__/quota-available`);
    await page.waitForTimeout(8_000);

    await expect(page.getByText(SEEDED_SUMMARY)).toBeVisible();
    await expect(page.getByText(REVISED_SUMMARY)).toHaveCount(0);
    await expect(proposalHeaders(page)).toHaveCount(1);
    await expect(page.getByRole("button", { name: "Revise", exact: true })).toBeVisible();
  });

  test("a revision replaces the original as the pending head, never two Proposals side by side", async ({
    page,
  }) => {
    await openToday(page);
    await expect(proposalHeaders(page)).toHaveCount(1);

    await submitRevise(page, REVISE_PROSE);

    await expect(page.getByText(REVISED_SUMMARY)).toBeVisible({ timeout: 30_000 });

    // The original is gone as a *pending head* — superseded, not sitting
    // beside its replacement (ADR 0013 §2/§3). It may still be readable as
    // history inside the exchange, which is why the count of Proposal cards,
    // not the absence of the old text, is the claim being made.
    await expect(proposalHeaders(page)).toHaveCount(1);
    // Unanchored again, for the same reason: the caret leads the element's text
    // as well as its accessible name. `toHaveText` with a regex is a search,
    // not a full match, so the summary need only appear somewhere within it.
    await expect(proposalHeaders(page)).toHaveText(new RegExp(REVISED_SUMMARY.slice(0, 40)));

    // Coach output still describes a single undecided item on Today.
    await expect(page.getByText("1 item")).toBeVisible();
  });

  test("the user's prose stays on the card, with earlier turns folded away", async ({ page }) => {
    await openToday(page);

    await submitRevise(page, REVISE_PROSE);
    await expect(page.getByText(REVISED_SUMMARY)).toBeVisible({ timeout: 30_000 });

    // The objection that produced the revision is visible on the card itself —
    // a revised Proposal is only comprehensible in light of it (§9), so it must
    // not be left behind a navigation to Coach.
    await expect(page.getByText(REVISE_PROSE)).toBeVisible();
    await expect(page.getByText("Exchange")).toBeVisible();
    // One turn only: nothing to fold yet.
    await expect(page.getByRole("button", { name: /Show earlier turns/ })).toHaveCount(0);

    // A second turn pushes the first one behind the fold: everything but the
    // current turn is collapsed by default (§9).
    await submitRevise(page, SECOND_REVISE_PROSE);
    await expect(page.getByText(SECOND_REVISE_PROSE)).toBeVisible({ timeout: 30_000 });

    const showEarlier = page.getByRole("button", { name: "Show earlier turns (2)" });
    await expect(showEarlier).toBeVisible();
    await expect(page.getByText(REVISE_PROSE)).toHaveCount(0);

    await showEarlier.click();
    await expect(page.getByText(REVISE_PROSE)).toBeVisible();
    await expect(page.getByRole("button", { name: "Hide earlier turns (2)" })).toBeVisible();
  });

  test("Accept resolves the Proposal off Today and mutates the Plan server-side", async ({
    page,
    request,
  }) => {
    await openToday(page);

    const before = await readLoadTarget(request);

    await page.getByRole("button", { name: /^Accept/ }).click();

    // Off Today: a decided item leaves Today and lives on in Coach (#42).
    await expect(proposalHeaders(page)).toHaveCount(0, { timeout: 15_000 });
    await expect(page.getByText(SEEDED_SUMMARY)).toHaveCount(0);

    // Carried over from the retired coaching-feed spec: "the card went away" is
    // not evidence the Plan changed. The seeded Proposal raises the working
    // load by 2.5, and that is checked at the server, not in the client.
    const after = await readLoadTarget(request);
    expect(after).toBe((before ?? 0) + 2.5);
  });

  test("Dismiss resolves the Proposal off Today without touching the Plan", async ({ page, request }) => {
    await openToday(page);

    const before = await readLoadTarget(request);

    await page.getByRole("button", { name: "Dismiss", exact: true }).click();

    await expect(proposalHeaders(page)).toHaveCount(0, { timeout: 15_000 });
    await expect(page.getByText(SEEDED_SUMMARY)).toHaveCount(0);

    expect(await readLoadTarget(request)).toBe(before);
  });
});
