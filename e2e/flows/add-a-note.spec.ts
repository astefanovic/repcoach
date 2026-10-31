import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

import { expectConnected, resetServer, setOffline, snapshotText } from "../driver.ts";

const DEV_SERVER_HTTP_URL = "http://127.0.0.1:4010";

/**
 * "Add a note": free text against an Entry, that reaches the coach (issue #130).
 *
 * The training record so far has only had two kinds of thing on it: a set,
 * and a set's actual. Neither has anywhere to put "left elbow twinged on set
 * 3" — a passing observation about an exercise that is not itself a metric
 * and does not fit a set row. #130 wires exactly that: from an Entry's "+"
 * sheet (the same sheet the drop-set/superset/etc. options already live on),
 * "Add a note" opens a second sheet with a text box and a "Save note"
 * button, and the saved note becomes plain text sitting directly under that
 * Entry's exercise name — no card, no dialog to reopen, just visible on the
 * Logging screen the way the exercise name itself is.
 *
 * What this file is checking, and why each part matters:
 *
 * - **The note reaches the coach, not just the screen.** A note that only
 *   updated local UI state would be indistinguishable, to the user, from one
 *   that actually got recorded — until the day it mattered and wasn't there.
 *   `GET /__test__/context-notes` is the read lever built for this (mirroring
 *   `/__test__/logged-actuals` for sets): every stored Context note, and an
 *   Entry-anchored one carries both `entryId` and `loggedSessionId`. Text
 *   showing up on screen is necessary but not sufficient; this asserts both.
 * - **It is offline-first, like every other write on this surface.** ADR
 *   0009's outbox pattern is not special-cased to sets — a note typed with
 *   dead hands and no signal must be captured immediately and synced later,
 *   the same guarantee `g1-offline-outbox.spec.ts` proves for logged sets.
 *   The visible half of that promise is the "queued" label the issue
 *   describes: present while the write is in flight/offline, gone once
 *   synced. A note that silently vanished offline, or that gave no signal it
 *   was still owed to the server, would both be failures of that promise.
 * - **"Swap this exercise" is not accidentally wired too.** The "+" sheet
 *   already offers other options the issue explicitly does not touch; a
 *   regression here would mean #130's change bled into a sibling feature
 *   that has no server-side support yet. A quick negative check on that one
 *   sibling option guards against that without inventing a whole other flow.
 *
 * Text assertions are case-insensitive throughout, per the CSS
 * `text-transform: uppercase` gotcha documented in the other Logging flows
 * (`innerText` reports the transformed case; the DOM text Playwright matches
 * does not).
 */

const openLogging = async (page: Page) => {
  await page.goto("/");
  await expectConnected(page);
  await expect(page.getByRole("heading", { name: "Today", exact: true })).toBeVisible();
  // The whole session row is the button; see log-straight-session.spec.ts.
  await page.getByRole("button", { name: /^Session 1/ }).click();
  await expect(page.getByRole("button", { name: "Back to Today" })).toBeVisible({ timeout: 20_000 });
};

/** The seed's first Entry with a "+" sheet — see log-drop-set.spec.ts. */
const EXERCISE_NAME = "Back Squat";
const NOTE_TEXT = "left elbow twinged on set 3";

const openMoreSheet = async (page: Page) => {
  await page.getByRole("button", { name: new RegExp(`^More for ${EXERCISE_NAME}$`, "i") }).click();
};

const openNoteSheet = async (page: Page) => {
  await openMoreSheet(page);
  await page.getByText(/^add a note$/i).click();
  await expect(page.getByText(new RegExp(`note\\s*·\\s*${EXERCISE_NAME}`, "i"))).toBeVisible();
};

const saveNoteButton = (page: Page) => page.getByRole("button", { name: /^save note$/i });

type ContextNote = {
  readonly id: string;
  readonly recordedAt: string;
  readonly text: string;
  readonly entryId?: string;
  readonly loggedSessionId?: string;
};

const readNotes = async (request: APIRequestContext): Promise<readonly ContextNote[]> => {
  const response = await request.get(`${DEV_SERVER_HTTP_URL}/__test__/context-notes`);
  expect(response.ok()).toBe(true);
  return ((await response.json()) as { readonly notes: readonly ContextNote[] }).notes;
};

test.describe("add a note", () => {
  test.beforeEach(async ({ request }) => {
    await resetServer(request);
  });

  test.afterEach(async ({ request, context }) => {
    await setOffline(context, false);
    await resetServer(request);
  });

  test("a note typed against an Entry appears inline under it, and reaches the coach", async ({
    page,
    request,
  }) => {
    await openLogging(page);

    // Not there before it is written.
    expect((await snapshotText(page)).toLowerCase()).not.toContain(NOTE_TEXT);

    await openNoteSheet(page);

    // Disabled until there is something to save.
    await expect(saveNoteButton(page)).toBeDisabled();

    await page.getByPlaceholder(/left elbow twinged on set 3/i).fill(NOTE_TEXT);
    await expect(saveNoteButton(page)).toBeEnabled();
    await saveNoteButton(page).click();

    // The note sheet closes — its title is no longer on screen.
    await expect(page.getByText(new RegExp(`note\\s*·\\s*${EXERCISE_NAME}`, "i"))).toBeHidden();

    // Plain inline text directly under the exercise name: no card, nothing to
    // reopen. Located the same way log-drop-set.spec.ts locates the drop
    // continuation under its parent — by text order in the rendered body.
    const body = (await snapshotText(page)).toLowerCase();
    const exerciseHeader = body.indexOf(EXERCISE_NAME.toLowerCase());
    const noteRow = body.indexOf(NOTE_TEXT);
    expect(exerciseHeader).toBeGreaterThan(-1);
    expect(noteRow).toBeGreaterThan(exerciseHeader);
    await expect(page.getByText(NOTE_TEXT, { exact: false })).toBeVisible();

    // And it reached the coach: an Entry-anchored note, not merely a local
    // string. `entryId` + `loggedSessionId` is the shape #130 wires — a
    // Context note with neither would be some other kind of note.
    await expect.poll(async () => (await readNotes(request)).length, { timeout: 20_000 }).toBe(1);
    const [note] = await readNotes(request);
    expect(note?.text).toBe(NOTE_TEXT);
    expect(note?.entryId).toBeTruthy();
    expect(note?.loggedSessionId).toBeTruthy();
  });

  test("a note typed offline is captured immediately, marked queued, and syncs on reconnect", async ({
    page,
    request,
    context,
  }) => {
    await openLogging(page);

    await setOffline(context, true);

    await openNoteSheet(page);
    await page.getByPlaceholder(/left elbow twinged on set 3/i).fill(NOTE_TEXT);
    await saveNoteButton(page).click();

    // Captured immediately, offline — the outbox pattern means the write
    // does not wait on the network to show up locally.
    await expect(page.getByText(NOTE_TEXT, { exact: false })).toBeVisible();

    const offlineBody = (await snapshotText(page)).toLowerCase();
    expect(offlineBody).not.toContain("error");
    expect(offlineBody).not.toContain("failed");

    // Marked as owed to the server while it is still in flight/offline.
    await expect(page.getByText(/queued/i).first()).toBeVisible();

    // Nothing has actually reached the coach yet — the capture is genuinely
    // queued, not merely fast.
    expect(await readNotes(request)).toHaveLength(0);

    await setOffline(context, false);
    await expectConnected(page);

    await expect.poll(async () => (await readNotes(request)).length, { timeout: 30_000 }).toBe(1);
    const [note] = await readNotes(request);
    expect(note?.text).toBe(NOTE_TEXT);
    expect(note?.entryId).toBeTruthy();
    expect(note?.loggedSessionId).toBeTruthy();

    // The "queued" marker clears once synced — a note that stayed marked
    // queued forever would be as dishonest as the outbox strip staying
    // stuck at "pending" after a drain (see g1-offline-outbox.spec.ts).
    await expect(page.getByText(/queued/i)).toHaveCount(0, { timeout: 10_000 });
    // The note text itself is unaffected by the marker clearing.
    await expect(page.getByText(NOTE_TEXT, { exact: false })).toBeVisible();
  });

  // This test used to guard that #130 had not accidentally wired swap. #131
  // wired it deliberately, so the guard is inverted rather than deleted: the
  // note path must leave the swap affordance alone, and "alone" now means
  // offered and live, not offered and dead. swap-this-exercise.spec.ts owns
  // the swap journey itself.
  test("'Swap this exercise' sits alongside the note item, wired rather than a dead tap", async ({
    page,
  }) => {
    await openLogging(page);

    await openMoreSheet(page);

    // The hint reads on the sheet ITEM itself, before any tap — a tap opens
    // the picker, so the assertion has to land pre-click, not after.
    const swap = page.getByRole("button", { name: /^swap this exercise/i });
    await expect(swap).toBeVisible();
    await expect(swap).not.toHaveAccessibleName(/not yet wired/i);
  });
});
