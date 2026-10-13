import { expect, test, type Page } from "@playwright/test";

import { STRIP, expectConnected, resetServer, setOffline } from "../driver.ts";

const DEV_SERVER_HTTP_URL = "http://127.0.0.1:4010";

/**
 * #80 — Plan edits survive a dead spot.
 *
 * #71 shipped Plan authoring on a direct RPC and wrote its own cut down: edits
 * did not queue. Offline, an edit was applied optimistically, failed to send,
 * and was rolled back — the user watched their edit land and then un-land, and
 * was told through an error banner that something they had seen happen had
 * not. This flow is the acceptance test for closing that: the Plan path now
 * rides the same outbox the logging path always did.
 *
 * **Why this is a new flow rather than an extension of `g1-offline-outbox`.**
 * The ticket names that spec as prior art, and it is — but it is itself
 * `describe.skip`ped and asserts on retired testids (`outbox-pending-count`,
 * `set-set-1-confirm-button`), because #50 replaced the whole shell. Restoring
 * it is #82's rung-2 re-commissioning. So this flow proves #80's claim
 * standing on its own, against the surface that actually exists, and does not
 * depend on #82 landing first.
 *
 * Black-box throughout, per the adversarial-author contract: it drives visible
 * accessible names and text, forces real offline via CDP, and verifies
 * server-side state through the `/__test__/*` control channel — never a client
 * hook, never client internals.
 */

const SEEDED_SESSION_TITLE = "Session 1";

interface ChangeRow {
  readonly summary: string;
  readonly dataWindow: { readonly operation?: string; readonly commandId?: string } | null;
}

/**
 * The Session row's own menu button, which is also the only place the row's
 * current title is readable as a value rather than as prose.
 *
 * Deliberately matched by *shape* (`More for …`) rather than by the seeded
 * title: once an edit lands the title is whatever the test just set, and the
 * Change ledger below the list quotes old titles inside its summaries
 * (`Renamed "Session 1" → "…"`), so any page-wide text match on a title finds
 * the ledger too.
 */
const sessionMenu = (page: Page) => page.getByRole("button", { name: /^More for / });

/** The Session row's current title, read off that button's accessible name. */
async function currentSessionTitle(page: Page): Promise<string> {
  const label = await sessionMenu(page).first().getAttribute("aria-label");
  return (label ?? "").replace(/^More for /, "");
}

/**
 * Waits until the Plan editor is genuinely usable before a test goes offline.
 *
 * The surface needs the Exercise catalog, which it fetches from the server, so
 * arriving on `/plan` already offline renders "Could not load the exercise
 * catalog" and no editor at all. That is #71/#72's behaviour and is outside
 * what #80 changes — this ticket is about edits made *in* a dead spot with the
 * editor already open, not about opening the editor from one. Without this
 * wait the flows race the catalog fetch and fail for a reason that has nothing
 * to do with the outbox.
 */
async function waitForEditor(page: Page): Promise<void> {
  await expect(sessionMenu(page).first()).toBeVisible({ timeout: 30_000 });
}

/** Renames the first Session through the real UI: menu -> Rename -> type -> save. */
async function renameSession(page: Page, to: string): Promise<void> {
  await sessionMenu(page).first().click();
  await page.getByRole("button", { name: "Rename", exact: true }).click();
  await page.getByRole("textbox").fill(to);
  await page.getByRole("button", { name: "Save name" }).click();
}

test.describe("#80: a Plan edit made offline is not lost", () => {
  // Reset BEFORE as well as after: `reuseExistingServer` means the dev-server
  // may already be carrying state from a previous run or a hand-driven
  // session, and the Change-row counts below are only meaningful from zero.
  test.beforeEach(async ({ request }) => {
    await resetServer(request);
  });

  test.afterEach(async ({ request, context }) => {
    await setOffline(context, false);
    await resetServer(request);
  });

  test("an edit made offline stays applied, then reaches the server on reconnect as exactly one Change", async ({
    page,
    context,
    request,
  }) => {
    await page.goto("/plan");
    await expectConnected(page);
    await waitForEditor(page);

    // Nothing has edited the Plan yet — so any Change row at the end is one
    // this test caused, and the count is meaningful.
    const before = (await (await request.get(`${DEV_SERVER_HTTP_URL}/__test__/changes`)).json()) as {
      readonly changes: ReadonlyArray<ChangeRow>;
    };
    expect(before.changes).toHaveLength(0);

    // 1. Go genuinely offline (CDP), and confirm the client noticed. Editing
    //    from here is the gym dead spot the ticket is about.
    await setOffline(context, true);
    await expect(page.getByText(STRIP.notConnected).first()).toBeVisible({ timeout: 20_000 });

    // 2. Edit the Plan while there is no server to send to.
    expect(await currentSessionTitle(page)).toBe(SEEDED_SESSION_TITLE);
    await renameSession(page, "Renamed In A Dead Spot");

    // 3. The edit must STAY applied. This is the assertion that would have
    //    failed before #80: the old path rolled the optimistic Plan back when
    //    the send failed, so the new name appeared and then vanished.
    //
    //    Asserted on the Session row itself, not on page text — the Change
    //    ledger quotes the OLD title inside its summary line, so a page-wide
    //    "Session 1 is gone" check would be testing the ledger, not the Plan.
    await expect
      .poll(async () => currentSessionTitle(page), { timeout: 10_000 })
      .toBe("Renamed In A Dead Spot");

    // 4. ...and it must not be reported as a failure. An edit that is safely
    //    queued is not an error, and saying so is what makes the absence of a
    //    save button survivable (ADR 0008 auto-applies).
    const offlineBody = await page.evaluate(() => document.body.innerText);
    expect(offlineBody.toLowerCase()).not.toContain("not applied");
    expect(offlineBody.toLowerCase()).not.toContain("error");

    // 5. The strip owns the explanation: still offline, now carrying work.
    await expect(page.getByText(/offline · \d+ pending/).first()).toBeVisible();

    // 6. Reconnect. The flusher drains on the next session with no reload and
    //    no user action.
    await setOffline(context, false);
    await expectConnected(page, 30_000);

    // 7. The server ends with EXACTLY ONE Change row for the edit.
    //
    //    The Plan alone could not witness this: `renameSession` is idempotent
    //    by design (#71 — whole-value operations are what make replay safe),
    //    so applying it twice leaves a Plan identical to applying it once. A
    //    duplicate would show up only as a second record of an edit the user
    //    made once, which is why the Change rows are what this asserts on.
    await expect
      .poll(
        async () => {
          const body = (await (
            await request.get(`${DEV_SERVER_HTTP_URL}/__test__/changes`)
          ).json()) as { readonly changes: ReadonlyArray<ChangeRow> };
          return body.changes.length;
        },
        { timeout: 30_000 },
      )
      .toBe(1);

    const after = (await (await request.get(`${DEV_SERVER_HTTP_URL}/__test__/changes`)).json()) as {
      readonly changes: ReadonlyArray<ChangeRow>;
    };
    expect(after.changes[0]?.dataWindow?.operation).toBe("renameSession");
    // Carrying a commandId is what makes the server's exactly-once dedupe
    // reachable at all — the pre-#80 direct call minted a fresh one per retry.
    expect(after.changes[0]?.dataWindow?.commandId).toBeTruthy();

    // 8. The edit is the Plan's real state server-side, not just a local overlay.
    const planBody = (await (await request.get(`${DEV_SERVER_HTTP_URL}/__test__/plan`)).json()) as {
      readonly plan: { readonly sessions: ReadonlyArray<{ readonly name: string }> };
    };
    expect(planBody.plan.sessions[0]?.name).toBe("Renamed In A Dead Spot");

    // 9. And the strip settles back to nothing pending.
    await expect(page.getByText(STRIP.connected).first()).toBeVisible();
  });

  /**
   * Ordering is the guarantee a Plan edit needs that a logged Set does not:
   * two edits made in the same dead spot must land in the order they were
   * authored, or last-write-wins resolves to the wrong write.
   */
  test("two edits made offline replay in the order they were authored", async ({
    page,
    context,
    request,
  }) => {
    await page.goto("/plan");
    await expectConnected(page);
    await waitForEditor(page);

    await setOffline(context, true);
    await expect(page.getByText(STRIP.notConnected).first()).toBeVisible({ timeout: 20_000 });

    await renameSession(page, "First Offline Name");
    await expect.poll(async () => currentSessionTitle(page)).toBe("First Offline Name");
    await renameSession(page, "Second Offline Name");
    await expect.poll(async () => currentSessionTitle(page)).toBe("Second Offline Name");

    await setOffline(context, false);
    await expectConnected(page, 30_000);

    // Both edits arrive, and "last" means the one authored last — not
    // whichever request happened to finish first.
    await expect
      .poll(
        async () => {
          const body = (await (await request.get(`${DEV_SERVER_HTTP_URL}/__test__/plan`)).json()) as {
            readonly plan: { readonly sessions: ReadonlyArray<{ readonly name: string }> };
          };
          return body.plan.sessions[0]?.name;
        },
        { timeout: 30_000 },
      )
      .toBe("Second Offline Name");

    const body = (await (await request.get(`${DEV_SERVER_HTTP_URL}/__test__/changes`)).json()) as {
      readonly changes: ReadonlyArray<ChangeRow>;
    };
    expect(body.changes).toHaveLength(2);
  });
});
