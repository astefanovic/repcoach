import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

import { expectConnected, resetServer, setOffline } from "../driver.ts";

const DEV_SERVER_HTTP_URL = "http://127.0.0.1:4010";

/**
 * A coach Proposal carries the Plan Change it proposes (issue #86, ADR 0008 /
 * ADR 0015).
 *
 * The bug this flow exists to keep dead: accepting a review-cadence Proposal
 * used to apply a **fixed stand-in** — +2.5 kg on every prescribed Set in the
 * whole Plan — regardless of what the Proposal said. A Proposal reading "add a
 * fourth back squat working set" raised every load in the Plan and added no
 * set. That failure is invisible from the card alone (the card said the right
 * thing; the Plan did the wrong thing), so every claim below that matters is
 * checked **at the server**, against the whole Plan rather than the one target
 * the Proposal is about.
 *
 * What this file proves, claim by claim:
 *
 * - The card shows the **change**, as a before → after diff against the
 *   standing Plan — not a restatement of the coach's prose. The prose and the
 *   effect being two different things is exactly what went wrong before, so
 *   the surface has to render the second one.
 * - Accepting applies **exactly** those operations. The assertion is
 *   deliberately about what did NOT move: the bench press, the plank, the leg
 *   press and its drop set are untouched. Under the stand-in all four changed.
 * - The acceptance lands in the Change ledger as a `coach-proposal` Change,
 *   `applied` (ADR 0008) — so the Plan's history says who authored the change,
 *   the same way it does for a user's own edit.
 * - A Proposal whose operations no longer apply — because the user edited the
 *   Plan out from under it — **says so, and does not offer an Accept that
 *   would be refused**. Nothing half-applies, and the Plan is untouched.
 *
 * ## Why the Plan surface appears in a Proposal flow
 *
 * The last claim needs a Proposal that has gone stale, and the honest way to
 * produce one is the way a user produces one: edit the Plan. Removing the
 * exercise the seeded Proposal is about is a real journey through the real
 * editor, and it needs no lever — which is the point. A `/__test__` hook that
 * manufactured a stale Proposal would prove the card renders a state, not that
 * the state is reachable.
 */

/** The seeded Proposal, and what it actually proposes. */
const SEEDED_SUMMARY = "Increase back squat working load by 2.5kg.";
const PRESCRIPTION_BEFORE = "2 × 5 reps @ 100 kg";
const PRESCRIPTION_AFTER = "2 × 5 reps @ 102.5 kg";

/** See `revise-a-proposal.spec.ts` on why this regex is deliberately unanchored. */
const proposalHeaders = (page: Page) => page.getByRole("button", { name: /\[Proposal\]/ });

const acceptButton = (page: Page) => page.getByRole("button", { name: /^Accept/ });

interface PlanBody {
  readonly plan: {
    readonly sessions: ReadonlyArray<{
      readonly blocks: ReadonlyArray<{
        readonly entries: ReadonlyArray<{
          readonly sets: ReadonlyArray<{ readonly target: Record<string, unknown> }>;
        }>;
      }>;
    }>;
  };
}

interface ChangeRow {
  readonly origin: string;
  readonly status: string;
  readonly summary: string;
}

/**
 * Every prescribed target in the Plan, in tree order, as comparable strings.
 *
 * Whole-Plan rather than one target on purpose. The deleted stand-in touched
 * every load there was, so a flow that only checked the squat would have passed
 * against the very bug it was written for.
 */
const readTargets = async (request: APIRequestContext): Promise<ReadonlyArray<string>> => {
  const response = await request.get(`${DEV_SERVER_HTTP_URL}/__test__/plan`);
  expect(response.ok()).toBe(true);
  const body = (await response.json()) as PlanBody;
  return body.plan.sessions.flatMap((session) =>
    session.blocks.flatMap((block) =>
      block.entries.flatMap((entry) => entry.sets.map((set) => JSON.stringify(set.target))),
    ),
  );
};

const readChanges = async (request: APIRequestContext): Promise<ReadonlyArray<ChangeRow>> => {
  const response = await request.get(`${DEV_SERVER_HTTP_URL}/__test__/changes`);
  expect(response.ok()).toBe(true);
  return ((await response.json()) as { readonly changes: ReadonlyArray<ChangeRow> }).changes;
};

const openToday = async (page: Page) => {
  await page.goto("/");
  await expectConnected(page);
  await expect(page.getByRole("heading", { name: "Today", exact: true })).toBeVisible();
  await expect(page.getByText(SEEDED_SUMMARY)).toBeVisible({ timeout: 15_000 });
};

/**
 * Remove the back squat through the real editor — menu → Remove exercise. The
 * Session menu is the "surface has finished arriving" proxy the authoring flow
 * already relies on; without it this races the catalog fetch.
 */
const removeBackSquat = async (page: Page) => {
  await page.goto("/plan");
  await expectConnected(page);
  await expect(page.getByRole("heading", { name: "Plan", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: /^More for Session/ }).first()).toBeVisible({
    timeout: 30_000,
  });
  await page.getByRole("button", { name: "More for Back Squat", exact: true }).click();
  // Unanchored on the right: the menu item carries a count hint ("2 sets") as
  // part of its accessible name, so an `exact` match finds nothing — and finds
  // nothing *silently*, timing out as though the control were missing.
  await page.getByRole("button", { name: /^Remove exercise/ }).click();
  await expect(page.getByRole("button", { name: "More for Back Squat", exact: true })).toHaveCount(0);
};

test.describe("A Proposal carries the Change it proposes", () => {
  // Reset BEFORE as well as after: `reuseExistingServer` means the dev-server
  // may already carry state, and both the whole-Plan comparison and the Change
  // count below are only meaningful from the seed.
  test.beforeEach(async ({ request }) => {
    await resetServer(request);
  });

  test.afterEach(async ({ request, context }) => {
    // `reset` alone — see the note in `revise-a-proposal.spec.ts`'s afterEach.
    await setOffline(context, false);
    await resetServer(request);
  });

  test("the card shows the proposed change as a diff against the standing plan", async ({ page }) => {
    await openToday(page);

    // Not the coach's prose about the change — the change. Both halves are on
    // screen, so the user can see what they have now next to what they would
    // have, which is the comparison Accept is actually asking them to make.
    await expect(page.getByText("Proposed change")).toBeVisible();
    await expect(page.getByText("Session 1 · Back Squat")).toBeVisible();
    await expect(page.getByText(PRESCRIPTION_BEFORE)).toBeVisible();
    await expect(page.getByText(PRESCRIPTION_AFTER)).toBeVisible();
  });

  test("accepting applies exactly the proposed change and nothing else", async ({ page, request }) => {
    await openToday(page);

    const before = await readTargets(request);

    await acceptButton(page).click();
    await expect(proposalHeaders(page)).toHaveCount(0, { timeout: 15_000 });

    const after = await readTargets(request);

    // The two back-squat working sets moved, by exactly what the card said...
    expect(before.slice(0, 2)).toEqual([
      JSON.stringify({ reps: { min: 5, max: 5 }, load: { min: 100, max: 100 } }),
      JSON.stringify({ reps: { min: 5, max: 5 }, load: { min: 100, max: 100 } }),
    ]);
    expect(after.slice(0, 2)).toEqual([
      JSON.stringify({ reps: { min: 5, max: 5 }, load: { min: 102.5, max: 102.5 } }),
      JSON.stringify({ reps: { min: 5, max: 5 }, load: { min: 102.5, max: 102.5 } }),
    ]);
    // ...and NOTHING else in the Plan did. This is the whole flow: the stand-in
    // this replaced would have raised the bench, the leg press and the drop set
    // too, while the card said "back squat".
    expect(after.slice(2)).toEqual(before.slice(2));
    expect(after).toHaveLength(before.length);
  });

  test("accepting records a coach-proposal Change, applied", async ({ page, request }) => {
    await openToday(page);

    // Nothing has authored a Change yet — the seed carries none, so the row
    // counted after Accept is unambiguously the acceptance's own.
    expect(await readChanges(request)).toHaveLength(0);

    await acceptButton(page).click();
    await expect(proposalHeaders(page)).toHaveCount(0, { timeout: 15_000 });

    const changes = await readChanges(request);
    expect(changes).toHaveLength(1);
    // ADR 0008: a Change carries origin and status. The user's own edits are
    // `user-direct`; this one says the coach authored it and it landed.
    expect(changes[0]?.origin).toBe("coach-proposal");
    expect(changes[0]?.status).toBe("applied");
  });

  test("a Proposal the plan has outgrown says so, and does not offer an Accept that would be refused", async ({
    page,
    request,
  }) => {
    await openToday(page);
    await removeBackSquat(page);

    const before = await readTargets(request);

    await page.goto("/");
    await expectConnected(page);
    await expect(page.getByText(SEEDED_SUMMARY)).toBeVisible({ timeout: 15_000 });

    // The Proposal is still there — it is not silently dropped, because it is
    // still something the user may want to revise or dismiss. What is gone is
    // the promise that it applies.
    await expect(page.getByText(/no longer applies to your plan/i)).toBeVisible();
    await expect(page.getByText(PRESCRIPTION_AFTER)).toHaveCount(0);
    await expect(acceptButton(page)).toBeDisabled();

    // Revise and Dismiss remain — a stale Proposal is a decision the user still
    // has to make, not a dead card.
    await expect(page.getByRole("button", { name: "Revise", exact: true })).toBeEnabled();
    await expect(page.getByRole("button", { name: "Dismiss", exact: true })).toBeEnabled();

    // And nothing half-applied on the way here.
    expect(await readTargets(request)).toEqual(before);
  });
});
