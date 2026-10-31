import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

import { expectConnected, resetServer } from "../driver.ts";

const DEV_SERVER_HTTP_URL = process.env["REPCOACH_DEV_SERVER_HTTP_URL"] ?? "http://127.0.0.1:4010";
const AGENT_MODE = process.env["REPCOACH_AGENT_MODE"]?.trim() ?? "canned";

/**
 * Intake against the REAL agents (issue #95) — replayed, or live.
 *
 * Every other flow in this directory runs against the canned layers, which is
 * the right default: the suite has to stay fast, deterministic and free. But it
 * means rung 2 proves the wiring *around* the agents and nothing about them —
 * the prompts, the output contract and the decode boundary went straight from
 * rung-1 stand-ins to a human on a phone. This file is the rung that was
 * missing, and it runs on demand:
 *
 *   $env:REPCOACH_AGENT_MODE='replay'; pnpm --filter @repcoach/e2e test
 *   $env:REPCOACH_AGENT_MODE='live';   pnpm --filter @repcoach/e2e test
 *
 * Skipped otherwise, and the skip is load-bearing: with canned agents this
 * would pass while proving nothing, which is worse than not running.
 *
 * ## What it may and may not assert
 *
 * A real coach writes its own prose, so **nothing here asserts on generated
 * content** — no headline, no exercise name, no token total, no rationale
 * sentence. `intake-cold-start.spec.ts` can assert those because a canned
 * fixture fixes them; here they are exactly what varies, and a spec that
 * asserted them would be red every time the model phrased something
 * differently, which is the classic way an agent-backed suite gets marked
 * "flaky" and switched off.
 *
 * What is left is everything a real coach must satisfy regardless of what it
 * writes, which turns out to be most of the contract:
 *
 * - a cold draft comes back at all, and is numbered `draft 1`;
 * - it decodes — the app renders a plan rather than the failure card, which is
 *   the whole point: a reply that broke `IntakeAgentTurnPayload` would land
 *   here as "the draft didn't come back";
 * - an answered turn advances the revision, so the session was really held open
 *   and resumed rather than re-seeded;
 * - "Review the sources" produces something acceptable, meaning the sweep
 *   session ran, its verdicts decoded, and trust was derived from them;
 * - Accept materialises a Plan server-side — the strongest available proof that
 *   what the model drafted was structurally valid all the way to the store,
 *   which is where #93's invented-exercise-id defect actually surfaced.
 *
 * ## Failures are made legible, not left as timeouts
 *
 * A live session that could not start (an expired token, exhausted quota) shows
 * up in the browser as a heading that never appears — a locator timeout, which
 * reads as flake and sends the next reader to debug the client. So every step
 * runs through `step()`, which on failure reads `GET /__test__/agent-sessions`
 * and attaches what the server's agents actually did. The report then says *the
 * intake-session session failed: session could not start* instead of describing
 * a missing element.
 */

interface AgentSessionEntry {
  readonly stage: string;
  readonly outcome: "ok" | "failed" | "refused";
  readonly detail?: string;
  readonly costUsd: number;
  readonly cumulativeCostUsd: number;
}

interface AgentSessionSnapshot {
  readonly mode: string;
  readonly sessions: number;
  readonly cumulativeCostUsd: number;
  readonly entries: ReadonlyArray<AgentSessionEntry>;
}

const readAgentSessions = async (request: APIRequestContext): Promise<AgentSessionSnapshot> => {
  const response = await request.get(`${DEV_SERVER_HTTP_URL}/__test__/agent-sessions`);
  expect(response.ok()).toBe(true);
  return (await response.json()) as AgentSessionSnapshot;
};

const describeSessions = (snapshot: AgentSessionSnapshot): string =>
  [
    `mode=${snapshot.mode} sessions=${snapshot.sessions} spend=$${snapshot.cumulativeCostUsd.toFixed(4)}`,
    ...snapshot.entries.map(
      (entry) => `  ${entry.stage}: ${entry.outcome}${entry.detail === undefined ? "" : ` — ${entry.detail}`}`,
    ),
  ].join("\n");

/** Runs one step, and on failure says what the agents did instead of what the DOM did not. */
const step = async (
  name: string,
  request: APIRequestContext,
  body: () => Promise<void>,
): Promise<void> => {
  try {
    await body();
  } catch (cause) {
    const snapshot = await readAgentSessions(request).catch(() => undefined);
    throw new Error(
      `Intake step "${name}" failed.\n\n` +
        `Agent sessions on the server:\n${snapshot === undefined ? "  (unreadable)" : describeSessions(snapshot)}\n\n` +
        `Browser-side failure:\n${String(cause)}`,
    );
  }
};

/** How many Prescribed Sessions the server holds — the cold-start precondition and the Accept proof. */
const readSessionCount = async (request: APIRequestContext): Promise<number> => {
  const response = await request.get(`${DEV_SERVER_HTTP_URL}/__test__/plan`);
  expect(response.ok()).toBe(true);
  const body = (await response.json()) as { readonly plan: { readonly sessions: ReadonlyArray<unknown> } };
  return body.plan.sessions.length;
};

/**
 * Empty the Plan the ordinary way — Plan → the session's `⋯` → `Delete
 * session` — because Today's empty state is the only door to Intake a user
 * walks through.
 *
 * Deliberately the same dance as `intake-cold-start.spec.ts`, and deliberately
 * not shared with it: that file documents at length why each guard is here (`⋯`
 * menus are not distinguishable by name; `count()` does not retry; the server's
 * own Session count is the only unambiguous "is it empty yet"). Lifting it into
 * a shared helper would move those hard-won reasons away from the file that
 * pays for them, and this spec would then depend on a helper tuned for a
 * different mode's timings.
 */
const emptyThePlan = async (page: Page, request: APIRequestContext): Promise<void> => {
  await page.goto("/plan");
  await expectConnected(page);

  const menus = page.getByRole("button", { name: /^More for / });
  const deleteItem = page.getByRole("button", { name: /Delete session/ });

  for (let guard = 0; guard < 12; guard += 1) {
    if ((await readSessionCount(request)) === 0) break;
    await expect(menus.first()).toBeVisible({ timeout: 15_000 });

    const before = await menus.count();
    let deleted = false;
    for (let index = 0; index < before; index += 1) {
      await menus.nth(index).click();
      if ((await deleteItem.count()) === 0) {
        await page.getByRole("button", { name: /^CLOSE$/i }).click();
        continue;
      }
      await deleteItem.click();
      await expect(deleteItem).toHaveCount(0);
      deleted = true;
      break;
    }

    expect(deleted, "no ⋯ menu on Plan offered `Delete session`").toBe(true);
    await expect(menus).not.toHaveCount(before);
  }

  expect(await readSessionCount(request)).toBe(0);
};

/**
 * How long one agent-backed wait may take. Replay answers instantly; a live
 * cold draft was 60–90s when the path was commissioned (#93) and a convergence
 * sweep 2–4 minutes, so the budget is generous rather than tuned — a wait that
 * expires early would report a model failure that did not happen.
 */
const WAIT_MS = AGENT_MODE === "live" ? 8 * 60_000 : 30_000;

test.describe("Intake against the real agents @agents", () => {
  test.skip(
    AGENT_MODE === "canned",
    "runs only with REPCOACH_AGENT_MODE=replay|live — against canned agents this would pass without exercising one",
  );

  test.afterEach(async ({ request }) => {
    await resetServer(request);
  });

  test("the server really is running the real adapters", async ({ request }) => {
    // First, because everything below is vacuous otherwise. A harness that
    // reused an already-running canned dev-server would fail here rather than
    // silently reporting a green agent-backed run.
    const snapshot = await readAgentSessions(request);

    expect(snapshot.mode).toBe(AGENT_MODE);
  });

  test("a cold draft, a turn, a sweep and an Accept all survive a real coach's own output", async ({
    page,
    request,
  }) => {
    await step("reach Today's cold-start invitation", request, async () => {
      await emptyThePlan(page, request);
      await page.goto("/");
      await expectConnected(page);
      await expect(page.getByText(/no plan yet/i)).toBeVisible({ timeout: 15_000 });
      await page.getByRole("button", { name: /answer four questions/i }).click();
      await expect(page.getByPlaceholder("get stronger · put on size · stop hurting")).toBeVisible();
    });

    await step("the cold draft comes back and decodes", request, async () => {
      await page.getByPlaceholder("get stronger · put on size · stop hurting").fill("get stronger and put on size");
      await page.getByRole("button", { name: "4", exact: true }).click();
      await page.getByRole("button", { name: /full gym/i }).click();
      await page.getByRole("button", { name: /draft my plan/i }).click();

      // `draft 1` is app chrome, not model prose — the revision number is the
      // one thing about the draft this file is allowed to name. A reply that
      // failed to decode would show the failure card instead, so this single
      // assertion carries the whole "the contract still holds" claim.
      await expect(page.getByText(/draft 1/i)).toBeVisible({ timeout: WAIT_MS });
      await expect(page.getByText(/the draft failed/i)).toHaveCount(0);
      // Convergence is offered from the first draft (ADR 0014 §5).
      await expect(page.getByRole("button", { name: /review the sources/i })).toBeVisible();
    });

    await step("an answered turn advances the same draft", request, async () => {
      // Free text rather than a quick-reply chip: a real coach's chips are its
      // own words, and there may be none at all. The input is always present.
      const input = page.getByRole("textbox");
      await expect(input).toHaveCount(1);
      await input.fill("Bad lower back");
      await page.getByRole("button", { name: /^Send$/i }).click();

      // The session was held open and resumed: a runner that re-seeded per turn
      // would produce a first draft again, not a second revision.
      await expect(page.getByText(/draft 2/i)).toBeVisible({ timeout: WAIT_MS });
      await expect(page.getByText(/draft 1/i)).toHaveCount(0);
    });

    await step("the single sweep runs and produces something acceptable", request, async () => {
      await page.getByRole("button", { name: /review the sources/i }).click();

      // Accept existing at all means the sweep session ran, its verdicts
      // decoded, and trust was derived from them — ADR 0014 §5's "an unverified
      // plan cannot be accepted" is what makes this assertion load-bearing.
      await expect(page.getByRole("button", { name: /this is my plan/i })).toBeVisible({ timeout: WAIT_MS });
      await expect(page.getByText(/\[Proposal\]/i).first()).toBeVisible();
    });

    await step("Accept materialises a real Plan", request, async () => {
      expect(await readSessionCount(request)).toBe(0);

      await page.getByRole("button", { name: /this is my plan/i }).click();

      await expect(page.getByRole("heading", { name: "Today", exact: true })).toBeVisible({
        timeout: WAIT_MS,
      });
      // The proof #93 paid for: the coach once drafted exercise ids shaped
      // exactly like the catalog's real ones, the user converged, tapped
      // Accept, and the whole plan was rejected at the last tap. "The takeover
      // closed" is not evidence a Plan exists; the server's Session count is.
      expect(await readSessionCount(request)).toBeGreaterThan(0);
    });

    const snapshot = await readAgentSessions(request);

    // Every session the journey ran, and every one of them succeeded. Stated as
    // the whole log rather than a count so a failure names the stage and the
    // reason rather than reporting `3 !== 4`.
    expect(
      snapshot.entries.filter((entry) => entry.outcome !== "ok"),
      `some agent sessions did not succeed:\n${describeSessions(snapshot)}`,
    ).toEqual([]);
    // The journey is one held-open Intake (a draft plus a turn) and one sweep.
    expect(snapshot.entries.map((entry) => entry.stage)).toEqual([
      "intake-session",
      "intake-session",
      "intake-sweep",
    ]);
  });
});
