import { expect, test, type APIRequestContext, type Locator, type Page } from "@playwright/test";

import { expectConnected, resetServer, setOffline } from "../driver.ts";

const DEV_SERVER_HTTP_URL = "http://127.0.0.1:4010";

/**
 * Intake, cold start to populated Today (issue #82 item 1 / user story 1,
 * ADR 0014, `ui-surfaces.md` → Intake).
 *
 * #70's spec asked for exactly one end-to-end Intake flow — form → a turn →
 * "Review the sources" → the swept Proposal card → Accept — and it was never
 * written. It could not have been: until #82 the dev-server ran
 * `UnwiredIntakeSessionAgent`, so every cold draft failed and *no path past the
 * form was reachable from a browser at all*. The single flow a new user cannot
 * skip was the single flow nothing tested.
 *
 * ## What the canned coach does and does not license
 *
 * #82 scripts the coach **at the server boundary**, which is the only place the
 * adversarial contract allows a lever (`docs/agents/testing.md`; never a client
 * hook). The dev-server now runs `CannedIntakeSessionAgent` +
 * `CannedIntakeSweepAgent`, and both are deterministic *functions of the whole
 * transcript* rather than fixed reels: the first revision is visibly **caused**
 * by the answer it was given (the draft loses Back Squat, gains Leg Press, and
 * the headline names why), and the sweep's three canned URLs are chosen to drive
 * all three verdict branches — one corpus hit, one blog post removed with its
 * reason, one surviving retrieved-unverified.
 *
 * That licenses this file to assert on **structure, ordering, and the presence
 * and identity of the artifacts** — a draft that changed, a revision number that
 * advanced, a badge that replaced a provisional marker, a disclosure that names
 * a URL and a reason. #82 is explicit that it does **not** license assertions on
 * generated prose, so nothing here asserts that the coach wrote a good plan;
 * only that the plan on screen is the one the user argued it into, and that the
 * card says what was done to it. Where a string *is* asserted verbatim it is
 * because a canned fixture fixes it (the removal reason, the three URLs, the
 * token totals) or because a settled spec fixes it (the empty-state copy, the
 * unchanged-prescription sentence).
 *
 * ## What this file proves, journey by journey
 *
 * - **Entry is Today's empty state, not a URL.** Cold start is reached the way a
 *   user reaches it — Plan → the session's `⋯` → `Delete session` until the list
 *   is empty — because `/intake` entered directly skips the invitation *and* the
 *   offline check, which are part of the journey rather than scaffolding around
 *   it. ADR 0014 §8 and `ui-surfaces.md` put that check **on the empty state and
 *   only there**: discovering the coach is unreachable *after* entering a
 *   chrome-free takeover means the takeover exists only to apologise. So offline,
 *   the hero swaps for the manual path and states the constraint ("the coach runs
 *   on your home server") rather than the symptom — and the invitation is *gone*,
 *   not merely dimmed. `setOffline` from `../driver.ts` is the lever.
 * - **The form spends the user's patience only on facts a model cannot guess**
 *   (§1). Submit is gated on Goal and days/week *only*; equipment is untouched
 *   here and working weights are submitted blank, because "I haven't been
 *   training" is a common and honest answer.
 * - **It does not read as a chat, and the assertion is positive rather than a
 *   grep for chat bubbles.** Exactly one open question is on screen at a time,
 *   and an answered turn does not become a message — it collapses into a
 *   **revision ledger** whose line is *what the answer did to the plan*, with
 *   `you answered: …` subordinate underneath. The draft carries a **revision
 *   number** (`draft 1` → `draft 2` → `verified`), which is the cheapest signal
 *   that the thing on screen is the *same object as a turn ago, changed*. The
 *   load-bearing form of the claim is that draft 1's content is **replaced**:
 *   Back Squat is not on screen below Leg Press, it is not on screen at all
 *   (measured before the ledger is expanded, since the ledger legitimately names
 *   it in the change line — that is a changelog entry, not an accumulated
 *   message).
 * - **`[provisional]` is a tap-to-reveal button, not a hover tooltip.** A phone
 *   has no hover, so a `title=` promising later verification is undiscoverable on
 *   the device this ships to — and the promise *is* the feature
 *   (`ui-surfaces.md`, amending ADR 0014 §3). Asserted as a `button` role whose
 *   tap reveals a source that was not on screen before it.
 * - **"Review the sources" is a distinct act from Accept, with the single
 *   adversarial sweep between them** (§5). Putting the sweep behind Accept would
 *   have the user agree to a plan and then have its rationale rewritten
 *   underneath, possibly stripping the very source that convinced them.
 * - **The swept card discloses its own edits, names the removed source AND the
 *   reason, and governs the justification only.** A disclosure without the reason
 *   is worthless, so both the URL and "the claim traces to a blog post citing
 *   itself" are asserted. The removed line survives **uncited** rather than being
 *   deleted ("degrade to uncited, never fabricate"), the sets and reps are
 *   unchanged, and the card says so *only because* something was removed — with
 *   nothing struck through that sentence denies an accusation nobody made.
 * - **The Intake Proposal is never pending on Today and never in the Coach badge
 *   before Accept** (§6). It is decided in place, before Today is ever populated.
 *   This is the sharpest claim in the file and it cannot be made from inside the
 *   takeover, which renders no Today and no badge — so it is made from a **second
 *   page** on the same context, looking at Today and at Coach's badge while the
 *   swept card sits unaccepted in the first, and backed server-side by the Plan
 *   still having no Sessions.
 * - **Accept exits to a populated Today** with the chrome restored, and the Plan
 *   exists server-side. "The takeover closed" is not evidence a Plan was created,
 *   so `GET /__test__/plan` is read on both sides of the click.
 *
 * ## What is not covered here, and why
 *
 * - **The activity line.** See the skipped test at the foot of this file: #74
 *   records that the cold wait *cannot* have one as the runner stands, and the
 *   sweep wait — which can — has no hold lever, so its growing list is
 *   unobservable rather than merely hard to catch.
 * - **The Proposal card's own actions** (Accept/Revise/Dismiss on Today) belong
 *   to `revise-a-proposal.spec.ts` (#77) and are not duplicated.
 * - **Whether the swept card should carry *disclosure controls* is undecided,
 *   and is deliberately not asserted either way.** On Today and Coach the
 *   `[Proposal]` header is a `button` with collapsed working behind it; in the
 *   takeover neither it nor "what checking the sources changed" is a control at
 *   all — the card has no disclosures, because the draft is already fully
 *   expanded above it and a triangle would open onto what the user is looking
 *   at. §5/§6 say the swept output "renders as the real Proposal card, badges
 *   and all" and do not say whether the affordances were part of "and all" — so
 *   this file locates the marker by role on Today (`proposalHeaders`) and by
 *   text in the takeover (`intakeProposalMarker`), and treats the difference as
 *   a live question rather than quietly ruling on it. `acceptTheFirstPlan` is
 *   the handle used wherever the real claim is "a Proposal is being offered".
 * - **A `REQUIRED` field that arrives pre-answered.** Days-a-week lands with
 *   `4` already selected, so the gate has only the Goal left to hold and a user
 *   can complete Intake having actively answered *one* question, not the two
 *   §1 describes. The gate test asserts the default rather than papering over
 *   it, because it is the sharper observation: whether pre-selecting the middle
 *   of the range is a kindness that saves a tap, or a silent assumption about
 *   how many days a stranger can train, is a design question the settled spec
 *   does not address. Recorded, not ruled on.
 *
 * Every test tears down through `POST /__test__/reset` alone, after restoring
 * online state — `reset` abandons anything in flight and restores every lever,
 * which is the operation teardown wants (see `revise-a-proposal.spec.ts`'s
 * `afterEach` for why releasing a gate instead is a real, hit failure). Nothing
 * here starts a workout, so the client-side in-flight-session pointer that
 * survives `reset` cannot strand a later run on a `Resume —` hero.
 */

/* --------------------------------------------------------------- fixtures --- */

/** What the user types. The canned coach's summary line quotes it back. */
const GOAL = "get stronger and put on size";
/** Any non-empty answer converges the canned coach; this one reads like a chip. */
const ANSWER = "Bad lower back";

const COLD_HEADLINE = "Upper / lower, four days a week";
const REVISED_HEADLINE = "Upper / lower, four days a week — squatting swapped out";

/** The canned citation that survives the sweep as `corpus-verified`. */
const CORPUS_URL = "https://example.com/corpus/frequency-meta-analysis";
/** The one the sweep removes — the disclosure the swept card has to make. */
const BLOG_URL = "https://example.com/blog/lifting-twice-a-week";
const REMOVAL_REASON = "the claim traces to a blog post citing itself";

/* ---------------------------------------------------------------- helpers --- */

/**
 * Disclosure headers carry their caret glyph inside the accessible name, so
 * every such control is matched **unanchored** — a `/^\[Proposal\]/` anchor
 * matches nothing and fails silently, reading as "the card isn't there" rather
 * than "the selector is wrong". Same trap as `revise-a-proposal.spec.ts`.
 */
const proposalHeaders = (page: Page) => page.getByRole("button", { name: /\[Proposal\]/ });

/**
 * The same marker **inside the takeover**, where it is plain text rather than a
 * disclosure control — so this is `getByText`, and deliberately not a lapse.
 *
 * On Today and Coach the card header is a button because there is collapsed
 * working behind it. In the takeover the draft is already fully expanded
 * *above* the card, so a disclosure triangle would open onto exactly what the
 * user is looking at. Asserting a button here would be asserting a defect into
 * existence. See the file's findings note on what is genuinely undecided about
 * this — "renders as the real Proposal card, badges and all" (§5/§6) does not
 * say whether the disclosure affordance was part of "and all", and the two
 * surfaces have different reasons to differ.
 */
const intakeProposalMarker = (page: Page) => page.getByText(/\[Proposal\]/i);

/**
 * The stronger handle for "a Proposal is actually being offered": Accept.
 *
 * The marker is a label and could in principle be rendered by anything; the
 * presence of an Accept is what distinguishes *a decision is on the table* from
 * *still drafting*, which is the distinction §5 is about — convergence is a
 * separate act, and until it happens there is nothing to accept.
 */
const acceptTheFirstPlan = (page: Page) => page.getByRole("button", { name: /this is my plan/i });

/**
 * The draft's plan headline — **first match only, and that is not a shortcut.**
 *
 * Once a turn has been answered the headline is legitimately on screen twice:
 * as the draft's hero, and again inside the revision ledger's change line
 * (`Now "Upper / lower … — squatting swapped out"; Lower A: Back Squat → Leg
 * Press`). That second occurrence is the ledger doing its job — the line is
 * *what the answer did to the plan*, and naming the new headline is how it says
 * the plan was renamed rather than replaced — so narrowing the string to dodge
 * it would be asserting against the feature. It is the same duplication the
 * not-a-chat test handles from the other side, by measuring `Back Squat`'s
 * absence *before* the ledger is expanded.
 */
const headline = (page: Page, text: string) =>
  page.getByText(new RegExp(text.replace(/\//g, "\\/"), "i")).first();

/**
 * Expand a disclosure only if it is currently collapsed. The caret is visible
 * text, so it is a legitimate black-box read of the control's own state — and
 * blindly clicking would *collapse* an already-open one, which is a failure mode
 * that reads like missing content.
 */
const expand = async (disclosure: Locator): Promise<void> => {
  await expect(disclosure).toBeVisible();
  if (((await disclosure.textContent()) ?? "").includes("▸")) await disclosure.click();
};

/** How many Prescribed Sessions the server holds — the cold-start precondition. */
const readSessionCount = async (request: APIRequestContext): Promise<number> => {
  const response = await request.get(`${DEV_SERVER_HTTP_URL}/__test__/plan`);
  expect(response.ok()).toBe(true);
  const body = (await response.json()) as { readonly plan: { readonly sessions: ReadonlyArray<unknown> } };
  return body.plan.sessions.length;
};

/**
 * Empty the Plan the ordinary way: Plan → the session's `⋯` → `Delete session`.
 * There is no control-channel lever for this and none is wanted — the point of
 * entering through Today's empty state is that it is a path a user walks.
 *
 * Two things make this fiddlier than it looks, and both were paid for once:
 *
 * - **`⋯` menus are not distinguishable by name.** Every one of them is
 *   `More for <thing>` — the session's is `More for Session 1` only because the
 *   session happens to be *called* "Session 1", and it would read `More for
 *   <its name>` after a rename or a fresh create. The Entry menus in the editor
 *   share the shape exactly (`More for Back Squat`). So the menu is not
 *   identified by its label at all: each is opened and identified by **what the
 *   sheet offers** — `Delete session` is a session's affordance and nothing
 *   else's — and a sheet that turns out to belong to an exercise is dismissed
 *   through its own `CLOSE` and skipped.
 * - **The loop condition must be the Plan, not the row count.** `count()` does
 *   not retry, so reading it straight after a delete can catch the list before
 *   it has re-rendered and send the loop back around onto a row that is already
 *   gone. The server's own Session count is the unambiguous answer to "is the
 *   Plan empty yet", and it is a legitimate black-box read — the same
 *   `/__test__/plan` lever the flows use for the Accept proof.
 * - **"The server has Sessions" and "the client has drawn them" are different
 *   times.** `count()` not retrying cuts the other way too: on a cold navigation
 *   the Plan list is briefly empty, so a bare count taken the instant `/plan`
 *   opens finds no `⋯` at all and the identify-the-sheet pass below has nothing
 *   to iterate — which surfaced as "no ⋯ menu offered `Delete session`" on
 *   whichever tests happened to load slowest. The rows are therefore *waited
 *   for* whenever the server says there is something to draw. Nothing waits when
 *   the Plan is already empty: the loop exits on the server count first, so a
 *   helper called against an empty Plan is a no-op rather than a 15-second wait
 *   for a row that is correctly absent.
 */
const emptyThePlan = async (page: Page, request: APIRequestContext): Promise<void> => {
  await page.goto("/plan");
  await expectConnected(page);

  const menus = page.getByRole("button", { name: /^More for / });
  const deleteItem = page.getByRole("button", { name: /Delete session/ });

  for (let guard = 0; guard < 12; guard += 1) {
    if ((await readSessionCount(request)) === 0) break;

    // The server says there is at least one Session, so the row for it is
    // coming; counting before it lands is what produced the false "no menu
    // offered Delete session".
    await expect(menus.first()).toBeVisible({ timeout: 15_000 });

    const before = await menus.count();
    let deleted = false;

    for (let index = 0; index < before; index += 1) {
      await menus.nth(index).click();
      // `Delete session` is what makes this a *session's* sheet.
      if ((await deleteItem.count()) === 0) {
        await page.getByRole("button", { name: /^CLOSE$/i }).click();
        continue;
      }
      await deleteItem.click();
      // Let the sheet go before anything is counted again.
      await expect(deleteItem).toHaveCount(0);
      deleted = true;
      break;
    }

    expect(deleted, "no ⋯ menu on Plan offered `Delete session`").toBe(true);
    // And let the list settle to the smaller Plan before the next pass.
    await expect(menus).not.toHaveCount(before);
  }

  expect(await readSessionCount(request)).toBe(0);
};

/** Land on Today's cold-start invitation, having emptied the Plan first. */
const openColdToday = async (page: Page, request: APIRequestContext): Promise<void> => {
  await emptyThePlan(page, request);
  await page.goto("/");
  await expectConnected(page);
  await expect(page.getByText(/no plan yet/i)).toBeVisible({ timeout: 15_000 });
};

/** Today → the invitation → the Intake form. */
const enterIntake = async (page: Page, request: APIRequestContext): Promise<void> => {
  await openColdToday(page, request);
  await page.getByRole("button", { name: /answer four questions/i }).click();
  await expect(page.getByPlaceholder("get stronger · put on size · stop hurting")).toBeVisible();
};

/**
 * Answer the form with the minimum the gate allows — Goal and days/week, no
 * equipment chip and no working weights — and submit.
 */
const submitTheForm = async (page: Page): Promise<void> => {
  await page.getByPlaceholder("get stronger · put on size · stop hurting").fill(GOAL);
  // `4` is already pressed on arrival; tapping it is the user re-confirming the
  // default rather than choosing, and it is done explicitly here so the rest of
  // the file does not depend on a default it is not the business of these
  // journeys to assert. (The gate test owns that claim.)
  await page.getByRole("button", { name: "4", exact: true }).click();
  await page.getByRole("button", { name: /full gym/i }).click();
  await page.getByRole("button", { name: /draft my plan/i }).click();
  await expect(headline(page, COLD_HEADLINE)).toBeVisible({ timeout: 30_000 });
};

/**
 * Answer the coach's open question in free text.
 *
 * Free text rather than the quick-reply chip on purpose. ADR 0014 §2 says a chip
 * "is an answer, not a second channel: tapping it submits the same turn it would
 * have typed" — but whether the tap *submits* or stages the answer into the
 * input is not fixed by any settled doc, and a spec that guessed would be
 * asserting an implementation detail either way. The chips are asserted to
 * **exist** as buttons (the closed-set affordance §2 calls for) in the draft-1
 * test; driving the turn goes through the input, which every settled doc agrees
 * is always present alongside and never behind a toggle.
 *
 * The textbox is addressed by role and asserted to be the *only* one: the form
 * has collapsed to its pinned one-line summary, so a second textbox on screen
 * would mean it had not.
 */
const answerTheQuestion = async (page: Page): Promise<void> => {
  const input = page.getByRole("textbox");
  await expect(input).toHaveCount(1);
  await input.fill(ANSWER);
  await page.getByRole("button", { name: /^Send$/i }).click();
  await expect(headline(page, REVISED_HEADLINE)).toBeVisible({ timeout: 30_000 });
};

/** Converge: fire the single adversarial sweep and wait for the swept card. */
const reviewTheSources = async (page: Page): Promise<void> => {
  await page.getByRole("button", { name: /review the sources/i }).click();
  await expect(acceptTheFirstPlan(page)).toBeVisible({ timeout: 30_000 });
  await expect(intakeProposalMarker(page).first()).toBeVisible();
};

/* ------------------------------------------------------------------ flows --- */

test.describe("Intake, cold start to populated Today", () => {
  test.afterEach(async ({ request, context }) => {
    // Online first, then `reset` alone — it abandons anything in flight and
    // restores every lever before reseeding, which is what teardown wants.
    await setOffline(context, false);
    await resetServer(request);
  });

  test("Today's empty state is the door to Intake, and offline it swaps the door for the manual path", async ({
    page,
    context,
    request,
  }) => {
    await openColdToday(page, request);
    expect(await readSessionCount(request)).toBe(0);

    // Online: the invitation, and the manual path standing beside it rather
    // than instead of it (#42's standing alternative).
    await expect(page.getByText(/let the coach write your first plan/i)).toBeVisible();
    await expect(page.getByRole("button", { name: /answer four questions/i })).toBeVisible();
    await expect(page.getByRole("button", { name: /write the plan yourself/i })).toBeVisible();

    // Offline: ADR 0014 §8's check lives HERE and only here. The takeover has
    // no status strip and no chrome, so a user who got inside it and then
    // discovered the coach was unreachable would have entered a full-screen
    // mode that exists only to apologise. The hero swaps for the manual path
    // and states the constraint — the server, not the symptom.
    await setOffline(context, true);
    await expect(page.getByText(/the coach is out of reach right now/i)).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText(/the coach runs on your home server/i)).toBeVisible();
    await expect(page.getByRole("button", { name: /write the first plan myself/i })).toBeVisible();
    await expect(page.getByText(/can revise it later/i)).toBeVisible();

    // And the invitation is GONE, not merely dimmed: an offline empty state
    // that still dangles "answer four questions" dead-ends the one flow in the
    // app that cannot degrade gracefully.
    await expect(page.getByRole("button", { name: /answer four questions/i })).toHaveCount(0);

    // It comes back when the server does — the constraint is a live condition,
    // not a one-way door.
    await setOffline(context, false);
    await expect(page.getByRole("button", { name: /answer four questions/i })).toBeVisible({
      timeout: 30_000,
    });
  });

  test("the form gates submit on the first two answers only, and working weights are skippable", async ({
    page,
    request,
  }) => {
    await enterIntake(page, request);

    // Chrome-free takeover (#42, ADR 0014): no destinations, no status strip.
    // The glyphs are part of each destination's accessible name, which is what
    // keeps this from colliding with "Draft my plan".
    await expect(page.getByRole("button", { name: /◎ Today/ })).toHaveCount(0);
    await expect(page.getByRole("button", { name: /≡ Plan/ })).toHaveCount(0);
    await expect(page.getByRole("button", { name: /⚙ Settings/ })).toHaveCount(0);
    await expect(page.getByText(/synced|offline/i)).toHaveCount(0);
    // Abandonment is free at every point, so the exit is always on screen.
    await expect(page.getByRole("button", { name: /leave/i })).toBeVisible();
    await expect(page.getByText(/nothing is saved until you accept a plan/i)).toBeVisible();

    const submit = page.getByRole("button", { name: /draft my plan/i });
    await expect(submit).toBeDisabled();

    // **Days-a-week arrives pre-answered.** This is the more interesting half
    // of the claim, and it is why the gate has only one field left to hold: the
    // chip row lands with exactly one chip pressed and it is `4`, so a field
    // marked REQUIRED is already satisfied before the user has read it. That is
    // the difference between "four questions" and "three questions and a
    // default you might not notice" — see the file's findings note, which
    // records the question without ruling on it.
    await expect(page.getByRole("button", { name: /^[23456]$/, pressed: true })).toHaveCount(1);
    await expect(page.getByRole("button", { name: "4", exact: true, pressed: true })).toBeVisible();

    // So the Goal alone unlocks submit — with equipment untouched and the
    // working-weights field left blank. That much of §1 holds exactly as
    // written: the gate is the first two fields ONLY, and "I haven't been
    // training" is a common and honest answer the coach absorbs as one of its
    // judgment calls rather than a hole in the form.
    await page.getByPlaceholder("get stronger · put on size · stop hurting").fill(GOAL);
    await expect(page.getByPlaceholder("squat 100, bench 70 — or leave it blank")).toBeEmpty();
    await expect(submit).toBeEnabled();

    await submit.click();

    // The form collapses into the pinned one-line summary the plan is answering
    // to (§4) — including the fact that no lifts were given, which is the input
    // the coach is being trusted to have absorbed rather than ignored.
    await expect(page.getByText(new RegExp(GOAL, "i"))).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText(/4 days/i)).toBeVisible();
    await expect(page.getByText(/no current lifts given/i)).toBeVisible();
  });

  test("the cold draft carries a revision number, one open question, and the calibration note", async ({
    page,
    request,
  }) => {
    await enterIntake(page, request);
    await submitTheForm(page);

    // The draft, numbered. Without the number four revisions do start to read
    // as four messages (`ui-surfaces.md`, amending §2).
    await expect(page.getByText(/draft 1/i)).toBeVisible();
    await expect(page.getByText(/lower a/i)).toBeVisible();
    await expect(page.getByText(/upper a/i)).toBeVisible();
    await expect(page.getByText(/back squat/i)).toBeVisible();
    await expect(page.getByText(/bench press/i)).toBeVisible();

    // The calibration note arrives WITH the draft, not before the form, and is
    // not behind an "OK" — §7 is explicit that putting the honest-disclosure
    // principle behind a dismiss is the single treatment that contradicts its
    // own content. Its presence as plain page text is the assertion.
    await expect(page.getByText(/calibration/i).first()).toBeVisible();
    await expect(page.getByText(/the first few weeks are calibration/i)).toBeVisible();

    // Exactly one open question on screen, with its closed-set quick replies
    // sitting in the input's own block (§2).
    await expect(page.getByText(/anything you need me to work around\?/i)).toBeVisible();
    await expect(page.getByRole("button", { name: /nothing — all good/i })).toBeVisible();
    await expect(page.getByRole("button", { name: /bad lower back/i })).toBeVisible();
    await expect(page.getByRole("button", { name: /cranky shoulder/i })).toBeVisible();
    // One question means one place to answer: a second Send would mean a second
    // question was on screen at the same time.
    await expect(page.getByRole("button", { name: /^Send$/i })).toHaveCount(1);

    // Convergence is offered from the first draft — the questions are optional
    // and an impatient first-time user is allowed to tap straight through (§5,
    // and the reason the sweep is scoped to the citations the plan actually
    // accumulated).
    await expect(page.getByRole("button", { name: /review the sources/i })).toBeVisible();

    // Spend appears only once a run has RETURNED; rendering the cold draft's
    // cost while it is still drafting reads as a live counter and is a lie. The
    // canned coach's cold draft is 4200 + 900 tokens.
    await expect(page.getByText(/5\.1k tokens/i)).toBeVisible();

    // Red appears exactly once, on the swept Proposal — so nothing here is one.
    await expect(intakeProposalMarker(page)).toHaveCount(0);
    await expect(acceptTheFirstPlan(page)).toHaveCount(0);
  });

  test("an answered turn revises the draft in place and collapses into a ledger, never a message", async ({
    page,
    request,
  }) => {
    await enterIntake(page, request);
    await submitTheForm(page);
    await expect(page.getByText(/draft 1/i)).toBeVisible();

    await answerTheQuestion(page);

    // The revision number advanced, and the OLD one is gone. This is the whole
    // not-a-chat claim in its positive form: the draft is the same object,
    // changed — not a new draft appended below the previous one.
    await expect(page.getByText(/draft 2/i)).toBeVisible();
    await expect(page.getByText(/draft 1/i)).toHaveCount(0);

    // The plan was revised, not extended: Leg Press is in and Back Squat is out
    // of the DRAFT. The scoping there is load-bearing, and the obvious stronger
    // version of it is wrong.
    //
    // A page-wide `getByText(/back squat/i)` count of 0 can never pass, and
    // should not: the ledger's collapsed disclosure carries its own change line
    // in its accessible text, so `Back Squat → Leg Press` is readable whether
    // or not the ledger is expanded — which is the ledger working exactly as
    // designed, since the whole point of the collapsed line is to be legible as
    // a changelog. The ledger naming Back Squat is **evidence for this claim,
    // not against it**: it is a record of the removal, not a message that
    // accumulated below the draft. (A reader hitting the 2-element count later
    // will assume it is a bug. It is the feature.)
    //
    // So the claim is scoped to the prescription. Back Squat's sets — the only
    // 100 kg and the only 5-rep target in this fixture — are gone, and Leg
    // Press's are there in their place. `.first()` for the headline's reason:
    // Leg Press appears in the drafted session and again in the change line.
    await expect(page.getByText(/leg press/i).first()).toBeVisible();
    await expect(page.getByText(/3 × 10 reps @ 80 kg/).first()).toBeVisible();
    await expect(page.getByText(/5 reps @ 100 kg/)).toHaveCount(0);

    // The question is gone because it was answered, and nothing replaced it —
    // the canned coach has what it needs after one turn.
    await expect(page.getByText(/anything you need me to work around\?/i)).toHaveCount(0);
    await expect(page.getByText(/nothing else to ask/i)).toBeVisible();

    // The answered turn became a LEDGER, whose line is what the answer did to
    // the plan, with `you answered: …` subordinate underneath. That inversion
    // is what makes the collapsed ledger readable as a changelog rather than as
    // a folded transcript (`ui-surfaces.md`).
    const ledger = page.getByRole("button", { name: /how this draft got here/i });
    await expand(ledger);
    await expect(page.getByText(/back squat.*→.*leg press/i)).toBeVisible();
    await expect(page.getByText(new RegExp(`you answered:\\s*${ANSWER}`, "i"))).toBeVisible();

    // A turn's cost is visibly a fraction of the draft's — the useful half of
    // "turns are cheap" (§2/§4). 5100 tokens became 5600, and the footer counts
    // the turn.
    await expect(page.getByText(/5\.6k tokens/i)).toBeVisible();
    await expect(page.getByText(/1 turn/i)).toBeVisible();

    // The exchange stays open: "change anything else you want" is only true if
    // there is still somewhere to type it.
    await expect(page.getByRole("textbox")).toHaveCount(1);
  });

  test("[provisional] is a tap-to-reveal button, and the sweep discharges it into real badges", async ({
    page,
    request,
  }) => {
    await enterIntake(page, request);
    await submitTheForm(page);

    // §3 keeps interim citations and marks them provisional: stripping them
    // would hide the coach's reasoning at the exact moment the user is deciding
    // whether to argue with it. One marker per cited rationale line.
    const provisional = page.getByRole("button", { name: /provisional/i });
    await expect(provisional).toHaveCount(3);

    // A phone has no hover, so the promise of later verification cannot live in
    // a `title=`. Tap-to-reveal is the same decision in an interaction the
    // target device actually has — and the observable form of "reveal" is that
    // the source was not on screen until it was tapped.
    await expect(page.getByText(CORPUS_URL)).toHaveCount(0);
    await provisional.first().click();
    await expect(page.getByText(CORPUS_URL)).toBeVisible();

    await answerTheQuestion(page);
    await reviewTheSources(page);

    // The promise is discharged in public (§5): the revision number becomes
    // `verified`, every provisional marker is gone, and the survivors carry
    // genuine trust badges instead.
    await expect(page.getByText(/verified/i).first()).toBeVisible();
    await expect(page.getByText(/draft 2/i)).toHaveCount(0);
    await expect(page.getByRole("button", { name: /provisional/i })).toHaveCount(0);
    await expect(page.getByText(/corpus-verified/i).first()).toBeVisible();
    await expect(page.getByText(/retrieved-unverified/i).first()).toBeVisible();
    await expect(page.getByText(CORPUS_URL)).toBeVisible();
  });

  test("Review the sources is a distinct act from Accept, and the swept card discloses what it removed and why", async ({
    page,
    request,
  }) => {
    await enterIntake(page, request);
    await submitTheForm(page);
    await answerTheQuestion(page);

    // Two acts, not one. Before convergence there is no Proposal to accept, and
    // no Accept on screen — putting the sweep behind Accept would have the user
    // agree to a plan and then have its rationale rewritten underneath (§5).
    await expect(intakeProposalMarker(page)).toHaveCount(0);
    await expect(acceptTheFirstPlan(page)).toHaveCount(0);

    await reviewTheSources(page);

    // Accept only exists on the far side of the sweep, and the exchange is
    // still reopenable from the card.
    await expect(acceptTheFirstPlan(page)).toBeVisible();
    await expect(page.getByRole("button", { name: /keep tweaking/i })).toBeVisible();

    // The card discloses its own edits, and it names BOTH the source that did
    // not hold and the reason. A disclosure without the reason is worthless —
    // "one source was removed" is an apology; the blog post citing itself is an
    // argument the user can check.
    // A section title, not a disclosure — the takeover's card has no disclosure
    // controls at all, which is the same call as the `[Proposal]` marker and is
    // recorded in the same finding. Nothing to expand: the disclosure is simply
    // open, which for the one screen where the user is deciding whether to
    // trust any of this is arguably the stronger treatment.
    await expect(page.getByText(/what checking the sources changed/i)).toBeVisible();
    await expect(page.getByText(/one source didn't hold up and was removed/i)).toBeVisible();
    await expect(page.getByText(BLOG_URL)).toBeVisible();
    await expect(page.getByText(new RegExp(REMOVAL_REASON, "i"))).toBeVisible();

    // The line whose source was struck SURVIVES, uncited: degrade to uncited,
    // never fabricate (ADR 0011 §1). Deleting it would quietly shrink the
    // plan's reasoning and leave the user with no way to see that it had.
    await expect(page.getByText(/two days would also work/i)).toBeVisible();

    // The sweep governs the justification, never the prescription (§5) — the
    // sets and reps are what the user converged on, and the revised lower-body
    // exercise they argued for is still there at the numbers it had.
    await expect(page.getByText(/3 × 10 reps @ 80 kg/)).toBeVisible();
    await expect(page.getByText(/3 × 8-10 reps @ 60 kg/)).toBeVisible();

    // And the card says so — but only BECAUSE something was removed. With
    // nothing struck through, this sentence denies an accusation nobody made,
    // which is why it is conditional rather than boilerplate.
    await expect(page.getByText(/the sets and reps you settled on are unchanged/i)).toBeVisible();
  });

  test("the Intake Proposal is never pending on Today and never in the Coach badge before Accept", async ({
    page,
    context,
    request,
  }) => {
    // The baseline is read BEFORE the takeover, and it is read rather than
    // assumed. Emptying the Plan deletes Sessions; it does not resolve the
    // seed's own pending Proposal, so Coach legitimately badges `1` throughout
    // — and §6 is not a claim about the badge being empty. It is a claim about
    // *this* Proposal never entering it. Asserting a zero baseline would pass
    // only by accident of the fixture and would go quietly vacuous the day the
    // seed grows a second Proposal; a delta cannot.
    await openColdToday(page, request);
    // Whitespace-normalised, because the two readings are compared as strings
    // and the destination's label and its count are separate nodes.
    const readCoachBadge = async (target: Page): Promise<string> =>
      ((await target.getByRole("link", { name: /Coach/ }).textContent()) ?? "")
        .replace(/\s+/g, " ")
        .trim();
    const badgeBefore = await readCoachBadge(page);

    await page.getByRole("button", { name: /answer four questions/i }).click();
    await expect(page.getByPlaceholder("get stronger · put on size · stop hurting")).toBeVisible();
    await submitTheForm(page);
    await answerTheQuestion(page);
    await reviewTheSources(page);

    // The swept Proposal is on screen, undecided, in the takeover.
    await expect(acceptTheFirstPlan(page)).toBeVisible();

    // ADR 0014 §6: it is decided IN PLACE, before Today is ever populated — so
    // it must not leak out as a pending item first. That cannot be asserted
    // from inside the takeover, which renders neither Today nor the badge, so a
    // second page on the same context is opened to look at both while the card
    // sits unaccepted in the first. This is the sharpest claim in the file: the
    // failure it guards is a first-time user landing on a Today that already
    // has homework, before they have a Plan.
    const observer = await context.newPage();
    await observer.goto("/");
    await expectConnected(observer);
    await expect(observer.getByText(/no plan yet/i)).toBeVisible({ timeout: 15_000 });

    // Nothing of the swept card has leaked out. The phrase chosen has to be one
    // that cannot appear on an *empty* Today, which rules out the obvious
    // "your first plan" — Today's own invitation reads "Let the coach write
    // your first plan", so matching it would flag the cold-start hero as a
    // leaked Proposal. `Accept — this is my plan` is the card's and only the
    // card's, and the drafted session names double as proof the Plan itself has
    // not materialised.
    await expect(acceptTheFirstPlan(observer)).toHaveCount(0);
    await expect(observer.getByText(/lower a/i)).toHaveCount(0);
    await expect(observer.getByText(/upper a/i)).toHaveCount(0);
    await expect(proposalHeaders(observer)).toHaveCount(0);
    // And the badge is UNCHANGED — whatever the seed left pending is still all
    // that is pending. An Intake Proposal that leaked into the count would move
    // this number, which is the whole of §6's badge promise and none of the
    // fixture's incidental arithmetic.
    await expect.poll(() => readCoachBadge(observer), { timeout: 15_000 }).toBe(badgeBefore);

    // Server-side, the same claim from the other end: interim turns and the
    // sweep write nothing (§2), so no Plan exists until Accept.
    expect(await readSessionCount(request)).toBe(0);

    await observer.close();
  });

  test("Accept exits the takeover to a populated Today, with the Plan really created", async ({
    page,
    request,
  }) => {
    await enterIntake(page, request);
    await submitTheForm(page);
    await answerTheQuestion(page);
    await reviewTheSources(page);

    expect(await readSessionCount(request)).toBe(0);

    await acceptTheFirstPlan(page).click();

    // Out of the takeover, chrome restored (§6).
    await expect(page.getByRole("heading", { name: "Today", exact: true })).toBeVisible({
      timeout: 30_000,
    });
    await expect(page.getByRole("link", { name: /≡ Plan/ })).toBeVisible();
    await expect(page.getByText(/no plan yet/i)).toHaveCount(0);

    // Populated with the sessions the user argued the coach into, each
    // startable. The whole row is the button, so `Start` matches only
    // unanchored — a trap that has cost other authors time here.
    await expect(page.getByRole("button", { name: /^Lower A/ })).toBeVisible();
    await expect(page.getByRole("button", { name: /^Upper A/ })).toBeVisible();
    await expect(page.getByRole("button", { name: /^Lower A.*2 exercises · 5 sets.*Start/ })).toBeVisible();

    // "The takeover closed" is not evidence a Plan was created. Accept commits
    // the Decision and applies the Change; the Plan is the thing that has to
    // exist afterwards, and it is read at the server.
    expect(await readSessionCount(request)).toBe(2);
  });

  /**
   * SKIPPED — waiting on a server lever, not on a decision about the UI.
   *
   * ADR 0014 §4 puts a live activity line "driven by real tool events" under the
   * cold wait, and `ui-surfaces.md` sharpens it to a *growing* list (past steps
   * stay, dimmed) because a single string swapped in place is precisely the
   * "spinner with extra words" §4 warned against. Neither half is observable
   * from a browser today, for two separate reasons:
   *
   * - **The cold wait cannot have one as the runner stands** (#74, found while
   *   porting): `intake.events` is keyed on the session id and `intake.start` is
   *   what mints it, so no subscriber can exist while the cold draft is being
   *   written. #70's own suite records this. The shipped wait therefore says
   *   what it is doing in words and fabricates nothing — which is §4's actual
   *   rule — and closing the gap means the runner minting the id *before* it
   *   drafts. That is a server change in #70's territory.
   * - **The sweep wait can have one, and does — but it is unobservable.** The
   *   canned sweep emits one event per citation and returns instantly, so the
   *   growing list flickers past faster than a browser can see it, exactly as
   *   the Proposal card's in-flight lock did before #77 added
   *   `hold-deliberation`. That lever gates `DeliberationAgent.run` only; there
   *   is no equivalent for `IntakeSweepAgent`, so this is not a state that is
   *   merely hard to reach — it is one with no lever at all.
   *
   * Unblocked by a `/__test__/hold-intake-sweep` (+ release) pair on the control
   * channel, at which point this asserts the list GROWS: an earlier step is
   * still on screen when a later one appears, and the count it narrates matches
   * the number of verdicts the card then discloses.
   */
  test.skip("the sweep wait reports real tool events as a growing list", async () => {});

  /**
   * A cold draft that fails must return the form WITH ITS VALUES INTACT — ADR
   * 0014 §8 calls losing the weights the user just typed the one unforgivable
   * version of this failure, and the copy for it ("the draft didn't come back —
   * the coach lost its connection partway through … your answers are still
   * here") is already observable.
   *
   * Whether it could be *induced* from outside the client was an open question
   * when this was written, and this test was the honest attempt rather than a
   * fake. **It works** — recorded here because the reasoning is worth keeping,
   * not because the answer is still in doubt.
   *
   * No control-channel lever fails an Intake run: `hold-deliberation` gates
   * `DeliberationAgent.run` and never touches `IntakeSessionAgent`, `quota-low`
   * drives the deferral queue Intake is explicitly **exempt** from (§4), and the
   * canned coach cannot be made to fail. So the lever is the connection itself,
   * and dropping it *while the user is mid-form* turns out not to be a
   * contrivance at all: it is the commonest real version of this failure, and it
   * is the one the shipped copy names ("the coach lost its connection partway
   * through"). §8's most important promise therefore has black-box reach as the
   * app stands, and no `/__test__/fail-intake-draft` route is needed to defend
   * it.
   */
  test("a failed cold draft returns the form with every value intact", async ({ page, context, request }) => {
    await enterIntake(page, request);

    const goalField = page.getByPlaceholder("get stronger · put on size · stop hurting");
    const weightsField = page.getByPlaceholder("squat 100, bench 70 — or leave it blank");
    await goalField.fill(GOAL);
    await page.getByRole("button", { name: "4", exact: true }).click();
    await page.getByRole("button", { name: /full gym/i }).click();
    await weightsField.fill("squat 100, bench 70");

    // The connection dies between typing and submitting.
    await setOffline(context, true);
    await page.getByRole("button", { name: /draft my plan/i }).click();

    await expect(page.getByText(/the draft failed/i)).toBeVisible({ timeout: 30_000 });
    // #111: the copy no longer claims "nothing was charged" — a cold draft that
    // reached the model is billed regardless of what the client rendered.
    await expect(
      page.getByText(/nothing was saved and no plan was created, but if the coach got as far as drafting/i),
    ).toBeVisible();

    // The unforgivable version of this failure is the one where the user has to
    // type it all again.
    await expect(goalField).toHaveValue(GOAL);
    await expect(weightsField).toHaveValue("squat 100, bench 70");
    await expect(page.getByRole("button", { name: /try again/i })).toBeVisible();

    // And it is a retry, not a restart: with the server back, the same answers
    // draft the same plan.
    await setOffline(context, false);
    await page.getByRole("button", { name: /try again/i }).click();
    await expect(headline(page, COLD_HEADLINE)).toBeVisible({ timeout: 30_000 });
  });
});
