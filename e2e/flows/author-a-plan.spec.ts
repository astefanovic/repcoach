import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

import { expectConnected, resetServer, setOffline } from "../driver.ts";

const DEV_SERVER_HTTP_URL = "http://127.0.0.1:4010";

/**
 * Plan authoring, end to end (issue #82 item 2 / user story 2, against the
 * decisions #45 settled and ADR 0007 / ADR 0008 bound).
 *
 * #71/#72 shipped the whole authoring surface with no black-box coverage of it.
 * This is that coverage: the journey a user takes to write a session — create,
 * add an exercise, author a set run, group a superset, reorder, undo — asserted
 * on visible text and ARIA roles only, per the adversarial-author contract in
 * docs/agents/testing.md.
 *
 * Deliberately NOT this file's job: #80's offline replay, already covered by
 * `flows/offline-plan-edit.spec.ts`. That flow proves a Plan edit survives a
 * dead spot and replays once, in order. This one is the authoring journey with
 * the server present throughout, so the two do not overlap beyond both using
 * `renameSession` as their cheapest deterministic mutation.
 *
 * ## What this file proves, journey by journey
 *
 * - **The change ledger, and Undo.** This is the load-bearing one and it is
 *   first on purpose. #45 settled that there is *no save button*: every
 *   mutation auto-applies. ADR 0008's auto-apply is only trustworthy because
 *   the ledger exists to show what was applied and to take it back — so the
 *   ledger is not decoration, it is the thing that makes the absence of a save
 *   button survivable. Four claims follow, and each is separately checkable by
 *   a user: the ledger *does not exist* before an edit (an empty log is noise
 *   on a surface a user opens mostly to read); an edit writes exactly one
 *   `user-direct` Change; the ledger **does not offer an undo it cannot
 *   honour**; and **Undo restores the prior Plan, not just the log line**.
 *   That last one is proved through `GET /__test__/plan`, because a ledger
 *   that pops its own top row and leaves the Plan mutated would look identical
 *   on screen — and would be the exact failure that makes auto-apply a risk
 *   rather than a decision.
 *
 * - **Create a Prescribed Session, and add an Entry from the catalog.** ADR
 *   0007 makes Plan the *only* manual authoring path, so "create a session and
 *   put an exercise in it" is the minimum viable use of the surface. The
 *   assertion that the new session is what is being edited matters on its own:
 *   a create button that leaves you editing the previous session has made
 *   something the user now has to go and find.
 *
 * - **A Set run is one GROUP with a count, not N set rows.** #45's largest
 *   decision: `4 × 5–8 reps @ 80 kg` is a single object, ADR 0007's "N
 *   identical sets" sugar promoted from a convenience to *the* authoring unit,
 *   because it is the only shape that fits nested set editing at 412px and it
 *   is how a person says it out loud. "Logging expands groups into rows; the
 *   Plan never sees rows" is therefore a server-side claim, and it is asserted
 *   as one: after authoring four sets, the Entry holds **one** set object. A
 *   surface that quietly expanded the count into four rows would read
 *   identically on screen and would have thrown the decision away.
 *
 * - **Blocks are made by ADJACENCY, and a Block of one collapses.** #45
 *   rejected multi-select outright (it needs a selection mode, a toolbar and a
 *   cancel), so grouping is "Group with the exercise below" on an Entry's own
 *   menu — never a selection. The inverse, "Take out of <block>", carries the
 *   subtler half: a Block left holding one Entry is not a Block, and must
 *   collapse back to a plain Entry rather than linger as a superset of one.
 *
 * - **Reorder is a MODE, not a gesture, with exactly two levels.** #45 killed
 *   long-press-drag as undiscoverable at 412px and fighting the scroll
 *   container. The settled form is a per-list toggle that *replaces* each row's
 *   resting affordances with ↑/↓ rather than adding to them — so the claim
 *   worth asserting is the replacement, not the presence: if the arrows merely
 *   appeared alongside the `⋯` menus, the mode would have bought nothing and
 *   the resting state would carry arrow noise forever.
 *
 * ## What was skipped, and why
 *
 * **A Block left holding one Entry collapses back to a plain Entry** was
 * skipped for a defect this spec found rather than for anything undecided —
 * `Take out of superset` was a silent no-op (issue #85), now fixed by
 * `removeEntryFromBlock`. The test is no longer skipped.
 *
 * Two further claims were skipped on earlier passes for a different reason —
 * the metric steppers and the reorder arrows all announced themselves
 * identically, so the only way to target one would have been positional
 * indexing, and asserting "the third button" is asserting DOM structure, which
 * is the cheating this rung exists to prevent. Both have since been named
 * (`Increase reps to`, `Move superset up`) and both are now live tests. That
 * is the loop working: an unnameable control is a finding to hand back, never
 * a reason to reach for a test hook.
 */

const SEEDED_SESSION_TITLE = "Session 1";

interface ChangeRow {
  readonly origin: string;
  readonly summary: string;
  readonly dataWindow: { readonly operation?: string } | null;
}

/**
 * Every `⋯` on this surface is a `More for <name>` button, and it is the only
 * place a row's own name is readable as a *value* rather than as prose. The
 * Change ledger quotes old titles inside its summaries (`Renamed "Session 1" →
 * …`), so a page-wide text match on a title finds the ledger too — matching by
 * shape avoids that entirely.
 */
const moreFor = (page: Page, name: string) =>
  page.getByRole("button", { name: `More for ${name}`, exact: true });

const sessionMenu = (page: Page) => page.getByRole("button", { name: /^More for Session/ });

/** The first Session row's current title, read off its menu button's name. */
async function currentSessionTitle(page: Page): Promise<string> {
  const label = await page.getByRole("button", { name: /^More for / }).first().getAttribute("aria-label");
  return (label ?? "").replace(/^More for /, "");
}

/**
 * The editor is not usable until the Exercise catalog has been fetched, and
 * every flow here either opens the catalog or edits something it describes.
 * Waiting on the Session menu is the cheapest visible proxy for "the surface
 * finished arriving"; without it the flows race the fetch and fail for reasons
 * that have nothing to do with authoring.
 */
async function openPlan(page: Page): Promise<void> {
  await page.goto("/plan");
  await expectConnected(page);
  await expect(page.getByRole("heading", { name: "Plan", exact: true })).toBeVisible();
  await expect(sessionMenu(page).first()).toBeVisible({ timeout: 30_000 });
}

/** Rename the first Session through the real UI: menu → Rename → type → save. */
async function renameSession(page: Page, to: string): Promise<void> {
  await page.getByRole("button", { name: /^More for / }).first().click();
  await page.getByRole("button", { name: "Rename", exact: true }).click();
  await page.getByRole("textbox").fill(to);
  await page.getByRole("button", { name: "Save name" }).click();
}

const readChanges = async (request: APIRequestContext): Promise<ReadonlyArray<ChangeRow>> => {
  const response = await request.get(`${DEV_SERVER_HTTP_URL}/__test__/changes`);
  expect(response.ok()).toBe(true);
  return ((await response.json()) as { readonly changes: ReadonlyArray<ChangeRow> }).changes;
};

interface PlanShape {
  readonly sessions: ReadonlyArray<{
    readonly name: string;
    readonly blocks: ReadonlyArray<{
      readonly entries: ReadonlyArray<{ readonly sets: ReadonlyArray<unknown> }>;
    }>;
  }>;
}

const readPlan = async (request: APIRequestContext): Promise<PlanShape> => {
  const response = await request.get(`${DEV_SERVER_HTTP_URL}/__test__/plan`);
  expect(response.ok()).toBe(true);
  return ((await response.json()) as { readonly plan: PlanShape }).plan;
};

/**
 * The shape of a session as nodes: one number per Block, being how many
 * Entries it holds.
 *
 * Deliberately counts rather than reads names: the entry's exercise-name field
 * is an implementation detail this author has not seen and must not guess at,
 * whereas grouping is entirely expressible as arity. Every claim about Blocks
 * below is a claim about arity anyway — that is what "a Block of one collapses"
 * means.
 *
 * Used **relatively**, never against a hardcoded baseline. Grouping merges two
 * nodes into one and taking an Entry out splits one into two; those deltas are
 * the decisions being tested, and they hold whatever the seed happens to be.
 * An absolute expectation here would be this spec asserting its own guess about
 * the fixture rather than asserting the behaviour — and it would fail for that
 * reason rather than for a real one.
 */
const nodeShape = (plan: PlanShape, sessionIndex = 0): ReadonlyArray<number> =>
  (plan.sessions[sessionIndex]?.blocks ?? []).map((block) => block.entries.length);

/** Every `[SUPERSET]` wrapper currently on screen. */
const supersetLabels = (page: Page) => page.getByText("[Superset]");

/**
 * The editor's Entries, in the order they appear, read off the accessible names
 * of their `⋯` menus.
 *
 * This is a reading of what a user (or a screen reader walking the page)
 * perceives as the order, not of the markup: the names are the app's own, and
 * the sequence is document order, which for a list is reading order. Session
 * rows share the `More for …` shape and are filtered out by name.
 */
/**
 * Click a named stepper until the value it steps reaches `target`.
 *
 * The increment is deliberately not assumed — it is read back off the set-group
 * sentence between clicks, which is the same thing a user does with their eyes.
 * The cap turns "this stepper does not move that number" into a failure with
 * the actual value in it, rather than a Playwright timeout on the last click.
 */
async function stepUntil(
  page: Page,
  control: string,
  read: () => Promise<number | undefined>,
  target: number,
): Promise<void> {
  for (let clicks = 0; clicks < 60; clicks += 1) {
    if ((await read()) === target) return;
    await page.getByRole("button", { name: control, exact: true }).click();
  }
  expect(await read()).toBe(target);
}

async function entryOrder(page: Page): Promise<ReadonlyArray<string>> {
  const menus = await page.getByRole("button", { name: /^More for / }).all();
  const names = await Promise.all(menus.map(async (menu) => menu.getAttribute("aria-label")));
  return names
    .filter((name): name is string => name !== null && !name.startsWith("More for Session"))
    .map((name) => name.replace(/^More for /, ""));
}

test.describe("Authoring a Plan", () => {
  // Reset BEFORE as well as after. `reuseExistingServer` means the dev-server
  // may already carry state from an earlier run or a hand-driven session, and
  // every Change-row count below is only meaningful counted from zero.
  test.beforeEach(async ({ request }) => {
    await resetServer(request);
  });

  test.afterEach(async ({ request, context }) => {
    // `reset` alone, and deliberately so — see the note in
    // `revise-a-proposal.spec.ts`'s afterEach. Nothing here holds a gate, but
    // the rule is the same one: reset abandons what is in flight and then
    // reseeds, and teardown must not "helpfully" let anything finish first.
    await setOffline(context, false);
    await resetServer(request);
  });

  test("the ledger appears only once an edit is made, never offers an undo it cannot honour, and restores the prior Plan when it does", async ({
    page,
    request,
  }) => {
    await openPlan(page);

    // 1. Nothing has been applied, so there is nothing to show. #45 puts the
    //    ledger on screen because auto-apply needs a receipt — an empty
    //    receipt is noise on a surface opened mostly to read.
    await expect(page.getByRole("heading", { name: "Applied changes" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Undo last" })).toHaveCount(0);
    expect(await readChanges(request)).toHaveLength(0);

    expect(await currentSessionTitle(page)).toBe(SEEDED_SESSION_TITLE);

    // 2. One edit. Rename is the cheapest mutation on the surface that has a
    //    single unambiguous before/after value, which is what makes it the
    //    right instrument for a claim about *the ledger* rather than about
    //    renaming.
    await renameSession(page, "Heavy Lower");
    await expect.poll(async () => currentSessionTitle(page), { timeout: 10_000 }).toBe("Heavy Lower");

    // 3. The receipt appears, and it is undoable. There is no save button
    //    anywhere on this surface — asserted, because a save button appearing
    //    later would silently invert #45's whole authoring model.
    await expect(page.getByRole("heading", { name: "Applied changes" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Undo last" })).toBeVisible();
    await expect(page.getByRole("button", { name: /^Save$/i })).toHaveCount(0);

    // 4. Exactly one Change, and it carries the origin ADR 0008 requires. The
    //    origin is what lets Coach and Plan tell "you did this" from "the coach
    //    proposed this"; a `user-direct` edit recorded as anything else would
    //    surface later as the coach claiming credit for the user's work.
    await expect.poll(async () => (await readChanges(request)).length, { timeout: 15_000 }).toBe(1);
    const applied = await readChanges(request);
    expect(applied[0]?.origin).toBe("user-direct");
    expect(applied[0]?.dataWindow?.operation).toBe("renameSession");

    // 5. And it is NOT undoable — correctly, which is why this is asserted
    //    rather than worked around.
    //
    //    Undo is the inverse operation replayed as a new edit, so an edit can
    //    only be undone if its inverse is expressible. The seeded session has
    //    no *stored* name — "Session 1" is a positional default, not a value —
    //    so the very first rename has no prior name to restore, and the ledger
    //    says so on the row instead of offering a button that would do nothing
    //    or, worse, guess.
    //
    //    This is the more valuable half of the ledger's honesty. A ledger that
    //    renders `Undo last` unconditionally and fails on click is worse than
    //    no ledger, because it invites the user to rely on a way back that is
    //    not there — and ADR 0008's auto-apply is precisely a bet that there
    //    is always a way back.
    await expect(page.getByText("Not undoable")).toBeVisible();
    await expect(page.getByRole("button", { name: "Undo last" })).toBeDisabled();

    // 6. A second rename DOES have an inverse: there is now a stored name to
    //    restore. The button comes to life on its own, with no reload.
    await renameSession(page, "Heavy Lower II");
    await expect.poll(async () => currentSessionTitle(page), { timeout: 10_000 }).toBe("Heavy Lower II");
    await expect(page.getByRole("button", { name: "Undo last" })).toBeEnabled();

    // 7. Undo. On screen the previous name comes back...
    await page.getByRole("button", { name: "Undo last" }).click();
    await expect.poll(async () => currentSessionTitle(page), { timeout: 15_000 }).toBe("Heavy Lower");

    // 8. ...and — the actual claim — so does the Plan on the server. #45's
    //    wording is exact: "undo restores the prior Plan, not just the log
    //    line". An implementation that popped the ledger row and left the Plan
    //    renamed would be indistinguishable from this one at step 7, and would
    //    hand the user a Plan that disagrees with its own history. `GET
    //    /__test__/plan` is the only place that difference is visible.
    await expect
      .poll(async () => (await readPlan(request)).sessions[0]?.name, { timeout: 15_000 })
      .toBe("Heavy Lower");

    // Note on what is NOT asserted here: whether Undo *itself* writes a Change
    // (an inverse row) or retracts the original is not settled by #45 or ADR
    // 0008 — both are defensible and the settled specs say only that the Plan
    // is restored. Asserting a count either way would be inventing a decision.
  });

  test("a new Prescribed Session is created empty, is the one being edited, and takes an exercise from the catalog", async ({
    page,
    request,
  }) => {
    await openPlan(page);
    expect((await readPlan(request)).sessions).toHaveLength(1);

    await page.getByRole("button", { name: "New prescribed session" }).click();

    // The new session is what you are now editing. A create button that leaves
    // the previous session selected has made something the user must then go
    // and hunt for — and on a phone that hunt is a scroll past the whole
    // session list (finding 2 of #45's handed-forward pair).
    await expect(page.getByText("Editing")).toBeVisible();

    // It is empty: the seeded four exercises belong to Session 1, and none of
    // them are here. This doubles as the proof that the editor followed the
    // selection rather than staying put.
    await expect(moreFor(page, "Back Squat")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Add exercise from catalog" })).toBeVisible();

    // The catalog is a sheet, and it is searchable — ADR 0007 makes Entries
    // come *from the catalog*, never from free text, which is what keeps an
    // Exercise's declared metrics (reps · load, duration) authoritative.
    await page.getByRole("button", { name: "Add exercise from catalog" }).click();
    // Matched as plain text, not as a heading: the sheet renders its title as
    // ordinary text, so there is no landmark or heading announcing what just
    // took over the screen. That is a finding of the same class as the unnamed
    // steppers — a sheet a screen reader cannot announce the identity of — and
    // it is recorded here rather than papered over, because asserting the
    // heading role would just make the spec red for a reason the settled spec
    // never actually decided.
    await expect(page.getByText("Exercise catalog")).toBeVisible();
    await page.getByPlaceholder("Search the catalog").fill("Back Squat");

    // The row itself, not the `Rename Back Squat` control beside it (#102
    // added renaming to every catalog row). Scoped to the sheet's list rather
    // than matched page-wide, which is also what keeps this stable once the
    // exercise is in the Session behind the sheet.
    await page
      .getByRole("listitem")
      .filter({ hasText: "Back Squat" })
      .getByRole("button")
      .first()
      .click();

    // The sheet closes onto the entry it just added.
    await expect(page.getByText("Exercise catalog")).toHaveCount(0);
    await expect(moreFor(page, "Back Squat")).toBeVisible();
    // The Exercise's declared metrics come with it — the Entry does not get to
    // invent what it measures.
    await expect(page.getByText("Reps · Load").first()).toBeVisible();

    // Server-side: two sessions, and the new one holds exactly one Entry in
    // one Block. "The screen shows an exercise" is not evidence the Plan grew.
    await expect.poll(async () => (await readPlan(request)).sessions.length, { timeout: 15_000 }).toBe(2);
    expect(nodeShape(await readPlan(request), 1)).toEqual([1]);

    // ...and adding it was an edit like any other, with a receipt.
    await expect(page.getByRole("heading", { name: "Applied changes" })).toBeVisible();
    const changes = await readChanges(request);
    expect(changes.every((change) => change.origin === "user-direct")).toBe(true);
  });

  test("a Set run is authored as one group carrying a count, never as N set rows", async ({
    page,
    request,
  }) => {
    await openPlan(page);

    // The seeded Back Squat already demonstrates the unit: two sets, ONE
    // sentence. If the *surface* dealt in set rows this would read as two
    // lines, and nested set editing at 412px would be the design #45 rejected.
    const setGroup = page.getByRole("button", { name: /\d+ × / }).first();
    await expect(setGroup).toHaveText(/2 × 5 reps @ 100 kg/);

    // How many set-group sentences the whole session shows, captured rather
    // than hardcoded. This is the number that must not move: authoring more
    // sets must not turn one sentence into N.
    const sentences = page.getByRole("button", { name: /\d+ × / });
    const sentencesBefore = await sentences.count();
    expect((await readPlan(request)).sessions[0]?.blocks[0]?.entries[0]?.sets).toHaveLength(2);

    // NOT asserted: that the group is one stored object. #45's "the Plan never
    // sees rows" is a claim about the authoring surface, not about
    // persistence — the model stores a `PrescribedSet` per set and the editor
    // presents them as a group. Asserting the storage shape would be this spec
    // inventing a promise the settled spec never made, and pinning an internal
    // it has no business knowing.

    // Tapping the sentence expands it into the metric editor (#45: "tapping
    // the sentence expands it into sets / metric targets / rest / effort").
    //
    // Matched case-insensitively, and that is not fussiness. These labels look
    // upper-case on screen but the text nodes are `sets` / `reps` / `load` /
    // `rest` / `effort` — the capitals are a CSS transform, as they are on
    // Coach's block headings and across most of the app's small-caps chrome.
    // `getByText("Sets", { exact: true })` therefore matches NOTHING, and does
    // so silently: the failure reads "element not found", i.e. "the editor
    // didn't open", rather than "your string was cased wrong". Any assertion
    // in this suite against text that renders upper-case should be a
    // case-insensitive regex for that reason.
    await setGroup.click();
    await expect(page.getByText(/^sets$/i)).toBeVisible();
    await expect(page.getByText(/^load$/i)).toBeVisible();
    await expect(page.getByText(/^rest$/i)).toBeVisible();
    await expect(page.getByText(/^effort$/i)).toBeVisible();

    // Only the COUNT is authored here — this test is about the group being the
    // unit, and the count is the part that decision rides on. The full worked
    // example from the ticket, `4 × 5–8 reps @ 80 kg`, is authored end to end
    // in its own test below.
    //
    // The stepper is reached through the metric it steps, which is the only
    // user-facing way to say *which* number is being changed — a screen-reader
    // user hearing four identical "Increase" buttons on a nested editor has no
    // more information than a spec indexing by position does.
    const increaseSets = page.getByRole("button", { name: /increase sets/i });
    await increaseSets.click();
    await increaseSets.click();

    // The sentence is the receipt: still ONE sentence, count now four. This is
    // the whole of #45's authoring unit expressed black-box — the count is
    // edited, not the rows, and the surface never grows a row per set.
    await expect(sentences.first()).toHaveText(/4 × 5 reps @ 100 kg/);
    await expect(sentences).toHaveCount(sentencesBefore);

    // Server-side, the real consequence: the Entry now prescribes four sets
    // where it prescribed two. "The sentence says 4" is not evidence the Plan
    // asks for four sets — the count is the thing Logging will expand, so it
    // has to have actually landed.
    await expect
      .poll(
        async () => (await readPlan(request)).sessions[0]?.blocks[0]?.entries[0]?.sets.length,
        { timeout: 15_000 },
      )
      .toBe(4);

    await expect(page.getByRole("heading", { name: "Applied changes" })).toBeVisible();
  });

  /**
   * The ticket's worked example, authored end to end: `4 × 5–8 reps @ 80 kg`.
   *
   * Previously skipped because the metric editor's steppers all announced
   * themselves identically, so neither the load nor the rep-range ceiling could
   * be named. They now do (`Decrease load`, `Increase reps to`), and the
   * range toggle says what it makes (`Make reps a range`) — so the whole
   * example is reachable and is written out here, because "four sets of 5–8 at
   * 80 kg" is the sentence the ticket used to describe the unit and it should
   * be a thing the suite has actually done rather than approximated.
   *
   * The remaining gap is real but is a design question, not a coverage one, so
   * it is recorded rather than skipped: **there is still no way to type a
   * number.** This test reaches 80 kg by clicking `Decrease load` until the
   * sentence says 80 — which it can do, because it reads the sentence between
   * clicks. A user authoring a 140 kg deadlift from a 20 kg default is holding
   * the button and counting. #45 settled the stepper without settling whether a
   * typed entry sits beside it, and daily use is what should decide it.
   */
  test("a Set run is authored all the way to four sets of 5-8 reps at 80 kg", async ({
    page,
    request,
  }) => {
    await openPlan(page);

    const sentence = () => page.getByRole("button", { name: /\d+ × / }).first();
    const readSentence = async () => (await sentence().textContent()) ?? "";
    // The en-dash and the hyphen are both plausible renderings of a range and
    // the settled spec does not choose between them, so neither does this.
    const readFloor = async () => Number((await readSentence()).match(/(\d+)\s*[-–]\s*\d+ reps/)?.[1]);
    const readCeiling = async () => Number((await readSentence()).match(/\d+\s*[-–]\s*(\d+) reps/)?.[1]);
    const readLoad = async () => Number((await readSentence()).match(/@\s*([\d.]+) kg/)?.[1]);

    await expect(sentence()).toHaveText(/2 × 5 reps @ 100 kg/);
    await sentence().click();

    // Sets: 2 → 4.
    await stepUntil(page, "Increase sets", async () => Number((await readSentence()).match(/(\d+) ×/)?.[1]), 4);

    // Reps: a single target becomes a range, then BOTH ends are placed.
    //
    // `Make reps a range` opens the range DOWNWARD from the current value, not
    // upward: a single target of 5 becomes `2–5`, at `min = max − 3 × step`.
    // That is defensible — the number you already entered is more likely to be
    // the target you care about than the floor of a range you have not written
    // yet — but it is not what the label suggests, and it means neither end can
    // be left alone. Stepping only the ceiling here yields `2–8`, which is a
    // different prescription authored by accident. Ceiling first, then floor,
    // so the two never have to cross.
    await page.getByRole("button", { name: "Make reps a range" }).click();
    await expect(sentence()).toHaveText(/\d+\s*[-–]\s*\d+ reps/);
    await stepUntil(page, "Increase reps to", readCeiling, 8);
    await stepUntil(page, "Increase reps from", readFloor, 5);

    // Load: 100 → 80.
    await stepUntil(page, "Decrease load", readLoad, 80);

    // The whole prescription in one sentence, which is the point of the unit.
    await expect(sentence()).toHaveText(/4 × 5\s*[-–]\s*8 reps @ 80 kg/);

    // And it landed: four prescribed sets, server-side.
    await expect
      .poll(
        async () => (await readPlan(request)).sessions[0]?.blocks[0]?.entries[0]?.sets.length,
        { timeout: 15_000 },
      )
      .toBe(4);
  });

  test("an Entry groups with the Block below it by adjacency, absorbing into it", async ({
    page,
    request,
  }) => {
    await openPlan(page);

    // The seed is one lone Entry (Back Squat), then a superset of Bench Press
    // and Plank, then another lone Entry (Leg Press) — node shape [1, 2, 1].
    //
    // Worth stating plainly, because reading it off the screen gets it wrong:
    // the `[SUPERSET]` label renders AFTER Back Squat's set rows, so an
    // `innerText` dump looks like it opens a container that swallows Back Squat
    // and Bench Press. It does not — it is a margin mark for the block that
    // FOLLOWS it, not a tag opening before its children. Every assertion below
    // is nonetheless a delta rather than a baseline, so a reseed can make them
    // uninteresting but cannot make them lie.
    const shapeBefore = nodeShape(await readPlan(request));
    const supersetsBefore = await supersetLabels(page).count();

    // Grouping is by ADJACENCY, from the Entry's own menu — never by selecting
    // two things. #45 rejected multi-select outright: it needs a selection
    // mode, a toolbar and a cancel, and adjacency is the whole feature for a
    // v1. The observable form of that decision is that this menu item exists at
    // all and that nothing had to be selected first.
    //
    // Back Squat's neighbour below is the seeded Block, so the wording is "the
    // group below" rather than "the exercise below". The label naming which of
    // the two it is doing is the only way an adjacency rule stays legible
    // without a selection to look at — the user has to be told what "below"
    // resolved to, because they never pointed at it.
    await moreFor(page, "Back Squat").click();
    await expect(page.getByRole("button", { name: /^Group with the/ })).toBeVisible();
    await page.getByRole("button", { name: "Group with the group below" }).click();

    // It ABSORBS rather than nesting: one fewer node, and the Block it joined
    // is now three Entries wide. #45 chose adjacency partly so that "circuits
    // can exceed two exercises" — a superset that could only ever pair would
    // make a three-exercise circuit unauthorable, and a Block-inside-a-Block
    // would break the settled "exactly two levels".
    await expect
      .poll(async () => nodeShape(await readPlan(request)).length, { timeout: 15_000 })
      .toBe(shapeBefore.length - 1);
    expect(nodeShape(await readPlan(request)).filter((arity) => arity === 3)).toHaveLength(1);

    // No NEW bracket — it joined the existing one rather than drawing a second.
    await expect(supersetLabels(page)).toHaveCount(supersetsBefore);

    // Every Entry is still there: grouping is a statement about the Block,
    // never about the exercises inside it.
    await expect(moreFor(page, "Back Squat")).toBeVisible();
    await expect(moreFor(page, "Bench Press")).toBeVisible();
    await expect(moreFor(page, "Plank")).toBeVisible();

    // One structural edit, one receipt, the user's own.
    await expect.poll(async () => (await readChanges(request)).length, { timeout: 15_000 }).toBe(1);
    expect((await readChanges(request))[0]?.origin).toBe("user-direct");
  });

  /**
   * Issue #85: `Take out of <block>` sends `removeEntryFromBlock`, which lands
   * the Entry in a fresh straight Block of its own and runs the vacated Block
   * through the same collapse rule `removeEntry`/`moveEntryToBlock` already
   * obey (#45).
   *
   * The load-bearing assertion is the second one: the `[SUPERSET]` bracket
   * must be **gone**, not merely narrowed to one exercise. A Block that failed
   * to collapse looks like a bracket drawn around a single lonely exercise
   * with no obvious way to be rid of it — and that is the outcome #45 ruled
   * out with "a Block of one collapses back to a plain Entry", so a spec that
   * only counted nodes would let it through.
   */
  test("a Block left holding one Entry collapses back to a plain Entry", async ({
    page,
    request,
  }) => {
    await openPlan(page);

    const shapeBefore = nodeShape(await readPlan(request));
    const supersetsBefore = await supersetLabels(page).count();

    // Taking Bench Press out leaves its Block holding Plank alone, and a
    // superset of one is not a superset.
    await moreFor(page, "Bench Press").click();
    await page.getByRole("button", { name: /^Take out of/ }).click();

    // One MORE node server-side: the Entry that left became a node in its own
    // right. And the bracket is GONE — see the note above for why that is the
    // assertion that distinguishes a collapse from a lingering Block.
    await expect
      .poll(async () => nodeShape(await readPlan(request)).length, { timeout: 15_000 })
      .toBe(shapeBefore.length + 1);
    await expect(supersetLabels(page)).toHaveCount(supersetsBefore - 1);
    expect(nodeShape(await readPlan(request)).every((arity) => arity === 1)).toBe(true);

    // Both Entries survive the ungrouping, and it was one recorded edit.
    await expect(moreFor(page, "Bench Press")).toBeVisible();
    await expect(moreFor(page, "Plank")).toBeVisible();
    await expect.poll(async () => (await readChanges(request)).length, { timeout: 15_000 }).toBe(1);
  });

  test("Reorder is a mode whose arrows REPLACE each row's resting affordances", async ({ page }) => {
    await openPlan(page);

    // Resting: the `⋯` menus are the row's affordance and there are no arrows
    // anywhere. #45 killed long-press-drag as undiscoverable at 412px, but the
    // cost it refused to pay for the replacement was permanent arrow noise on
    // a nested list — so "no arrows at rest" is half the decision.
    await expect(moreFor(page, "Back Squat")).toBeVisible();
    await expect(page.getByRole("button", { name: /^Move / })).toHaveCount(0);

    await page.getByRole("button", { name: "Reorder exercises" }).click();

    // On: arrows appear and the menus are GONE. Not "arrows appear alongside" —
    // that is the design #45 rejected, and it would pass a weaker assertion.
    await expect(page.getByRole("button", { name: /^Move / }).first()).toBeVisible();
    await expect(moreFor(page, "Back Squat")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Done reordering" })).toBeVisible();

    // Off again, and the surface returns to rest. A mode you cannot leave is a
    // mode that eats the surface.
    await page.getByRole("button", { name: "Done reordering" }).click();
    await expect(page.getByRole("button", { name: /^Move / })).toHaveCount(0);
    await expect(moreFor(page, "Back Squat")).toBeVisible();

    // The session list carries its own independent toggle, with its own
    // wording — the mode is per-list, so turning on reordering for exercises
    // must not put the session list into it too.
    await expect(page.getByRole("button", { name: "Reorder", exact: true })).toBeVisible();
  });

  test("Prescribed Sessions reorder by stepping a row down the list", async ({ page, request }) => {
    await openPlan(page);
    await renameSession(page, "First");

    await page.getByRole("button", { name: "New prescribed session" }).click();
    await expect.poll(async () => (await readPlan(request)).sessions.length, { timeout: 15_000 }).toBe(2);

    // Named by its row, so there is no positional assumption left here at all:
    // this is the arrow a user would say out loud as "move First down".
    await page.getByRole("button", { name: "Reorder", exact: true }).click();
    await page.getByRole("button", { name: "Move First down" }).click();
    await page.getByRole("button", { name: "Done", exact: true }).click();

    // The order is the Plan's, not the screen's: ADR 0007 makes the Plan an
    // *ordered* list of Prescribed Sessions, and that order is what Today
    // offers to start.
    await expect
      .poll(async () => (await readPlan(request)).sessions[1]?.name, { timeout: 15_000 })
      .toBe("First");
  });

  /**
   * #45's sharpest reordering claim: reordering has exactly TWO levels, and the
   * outer unit is the NODE — a Block moves as one, carrying its Entries, while
   * an Entry inside a Block moves only among its siblings.
   *
   * This was skipped on the previous pass because the move controls all
   * announced themselves as a bare `Move up` / `Move down`, leaving positional
   * indexing as the only way to say *which* arrow — which would assert DOM
   * order rather than anything a user can perceive, and would go on passing if
   * the two levels were silently flattened. The controls now name their node
   * (`Move Back Squat up`, `Move superset up`), so the claim is writable, and
   * it is written here as two moves that a flat list could not produce.
   */
  test("reordering moves a Block as one node, and an Entry only among its siblings", async ({
    page,
    request,
  }) => {
    await openPlan(page);

    const before = await entryOrder(page);
    const shapeBefore = nodeShape(await readPlan(request));

    await page.getByRole("button", { name: "Reorder exercises" }).click();

    // Both levels are on screen at once, and they are distinguishable: the
    // Block carries its own control as a node, and the Entries inside it carry
    // theirs as siblings. Exactly two levels — an Entry outside a Block has no
    // second-level control to offer.
    await expect(page.getByRole("button", { name: "Move superset up" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Move Bench Press down" })).toBeVisible();

    // 1. Move the Block up, past the lone Entry above it. If the outer unit
    //    were the Entry rather than the node, this would drag one exercise out
    //    of the superset or slide Back Squat into the middle of it. It must
    //    instead step over Back Squat whole.
    await page.getByRole("button", { name: "Move superset up" }).click();
    await page.getByRole("button", { name: "Done reordering" }).click();

    const afterNodeMove = await entryOrder(page);

    // The Block's two Entries are now BOTH above Back Squat, and still next to
    // each other. Stated as relative positions rather than as a whole expected
    // array: "moved as one" is a claim about the two of them travelling
    // together, and that is exactly what adjacency-plus-both-ahead says.
    expect(afterNodeMove.indexOf("Bench Press")).toBeLessThan(afterNodeMove.indexOf("Back Squat"));
    expect(afterNodeMove.indexOf("Plank")).toBeLessThan(afterNodeMove.indexOf("Back Squat"));
    expect(Math.abs(afterNodeMove.indexOf("Bench Press") - afterNodeMove.indexOf("Plank"))).toBe(1);

    // Reordering is a move, not a restructure: the same nodes with the same
    // arities, in a different order. Nothing was grouped or ungrouped by
    // stepping a Block past its neighbour.
    expect([...nodeShape(await readPlan(request))].sort()).toEqual([...shapeBefore].sort());
    expect(afterNodeMove.length).toBe(before.length);

    // 2. Now the inner level. Moving Bench Press down swaps it with Plank —
    //    its sibling — and must NOT carry it out of the Block. A1/A2 order in a
    //    superset is prescription, not presentation, which is the whole reason
    //    this second level exists at all.
    await page.getByRole("button", { name: "Reorder exercises" }).click();
    await page.getByRole("button", { name: "Move Bench Press down" }).click();
    await page.getByRole("button", { name: "Done reordering" }).click();

    const afterSiblingMove = await entryOrder(page);
    expect(afterSiblingMove.indexOf("Plank")).toBeLessThan(afterSiblingMove.indexOf("Bench Press"));

    // Still inside the Block: both still ahead of Back Squat, still adjacent,
    // and the node shape is still untouched. An Entry that escaped its Block
    // would show up here as an arity change even though the visible order
    // looked plausible.
    expect(afterSiblingMove.indexOf("Bench Press")).toBeLessThan(
      afterSiblingMove.indexOf("Back Squat"),
    );
    expect(
      Math.abs(afterSiblingMove.indexOf("Bench Press") - afterSiblingMove.indexOf("Plank")),
    ).toBe(1);
    expect([...nodeShape(await readPlan(request))].sort()).toEqual([...shapeBefore].sort());

    // Two moves, two receipts. Order is prescription, so reordering is an edit
    // like any other and gets recorded like one.
    await expect.poll(async () => (await readChanges(request)).length, { timeout: 15_000 }).toBe(2);
  });
});
