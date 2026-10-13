import { expect, test, type Page } from "@playwright/test";

import { expectConnected, resetServer, setOffline } from "../driver.ts";

const DEV_SERVER_HTTP_URL = "http://127.0.0.1:4010";

/**
 * The Coach record (issue #82 user story 3, built by #79, reshaped by the run
 * history).
 *
 * `/coach` is the permanent record: #42 split one stream in two, Today carries
 * what is still owed a decision, and Coach carries everything the coach has
 * ever said. Nothing leaves it. What changed is the **unit**: the record is now
 * a rail of DELIBERATION RUNS, each opening into what came out of it, rather
 * than a flat list of Decisions. Every claim the flat version made still has to
 * hold — an item still expands into its own working, still states its own
 * outcome, still offers no actions — and three claims are new, because three
 * states of the coach had no representation at all before.
 *
 * Every assertion below is on visible text or an ARIA role, per the
 * adversarial-author contract in docs/agents/testing.md.
 *
 * ## What this file proves, journey by journey
 *
 * - **Newest first.** A record that lists its newest claim last is a record
 *   nobody reads past the fold. Asserting the *seeded* runs' order would only
 *   assert the seed's own timestamps, so this drives a genuinely new run onto
 *   the record (`/__test__/push-proposal`) and asserts it lands at the top — a
 *   claim about the ordering rule rather than about the fixture. The rule is
 *   load-bearing beyond tidiness here: it is what puts a run *in flight* at the
 *   top, which is the whole reason watching the coach work and reading what it
 *   did afterwards are one list.
 *
 * - **A run that said nothing is on the record, and says what it read.** This
 *   is the state the run row exists for. A restrained run writes no Decision
 *   rows (ADR 0011 §4/§5 — the coach notices without acting), so on a list of
 *   Decisions it was indistinguishable from a coach that never ran at all. The
 *   observable claim is that the run is present, is not presented as a failure,
 *   and states the window it read over — "read one session and said nothing" is
 *   a different sentence from "said nothing", and only the first is evidence
 *   the coach is working.
 *
 * - **A run that failed is on the record, with its reason, and says nothing was
 *   written.** The other half of the same problem: a failure that lives only in
 *   the runner's memory makes "the coach has been quiet" and "the coach has
 *   been crashing" read identically the next morning. A user who cannot tell
 *   those apart cannot calibrate any trust at all.
 *
 * - **A Decision expands into its real working, fetched per Decision.** #79:
 *   `measurements`, the named `rule` and `uncertainty` are fetched through
 *   `decisions.get` **when expanded**, not shipped with the list. The black-box
 *   shape of "not shipped with the list" is that none of the working is on
 *   screen while everything is collapsed, and it arrives only after the
 *   disclosure is opened. Two levels of disclosure now, and they ask different
 *   questions: opening a run asks what it did, opening a Decision asks how it
 *   got there.
 *
 * - **A block renders only when the run filled it in.** ui-surfaces.md →
 *   "Optionality is the design, not a compromise": no placeholder rows, no
 *   "none given", an absent field is an absent block all the way down to the
 *   store. The seed is built for precisely this contrast — one Observation with
 *   the full set of working and one Proposal with none — so this is asserted in
 *   **both** directions on one screen. One direction alone is not the claim: a
 *   surface that always renders the blocks passes the positive half, and one
 *   that never renders them passes the negative half.
 *
 * - **A Decision states its own outcome.** The record's substitute for actions
 *   is *what became of this*. Asserting the seeded string proves only that a
 *   seed string reaches the screen, so the two decidable outcomes are driven
 *   for real — Accept on Today, then read the record; Dismiss on Today, then
 *   read the record. Per ADR 0008 a dismissed Proposal is kept as context the
 *   coach learns from, so dismissal must read neutral.
 *
 * - **Offline, the record says it cannot be read.** ADR 0002/0008 make the
 *   record online-only. The failure this guards is the worst kind — the last
 *   thing received rendered as though it were current. Two distinct states,
 *   because they are two distinct lies to avoid: never-read must say it cannot
 *   be read, and already-read must mark itself as possibly stale. Neither may
 *   show a spinner that will never finish.
 *
 * - **Coach has no actions.** Accept/Dismiss/Revise live on the undecided item
 *   on Today; offering them again on the record would be offering to decide
 *   something twice. A count of zero is a real claim, and the likeliest
 *   regression here, since the Decision body is shared markup with Today's
 *   Proposal card (`coachItem`) — the surfaces are built not to drift, so the
 *   actions are exactly what could leak across.
 *
 * - **Spend stays out of the record.** ADR 0011 §8 keeps tokens, model and cost
 *   in Settings. The data is right there on the run ledger, one join away, so
 *   this is the kind of thing that leaks in by accident — and the moment it
 *   does, an explainability surface has become a telemetry one.
 *
 * ## Notes on the selectors
 *
 * A run node is a **disclosure button whose accessible name starts with its
 * cadence** — `SESSION REVIEW 8 JUL 18:20 …`. A Decision inside an opened run
 * is NOT a button: it is an article carrying a bracketed kind marker and its
 * own `show working` button, which is what is clicked to reach the working.
 * Two levels, two selectors; conflating them is how this file would silently
 * assert nothing.
 *
 * Block headings and the rail's own labels are matched case-insensitively. The
 * surface renders them upper-case, but that is a CSS transform on
 * sentence-case text elsewhere in this app (Today's `COACH OUTPUT` is
 * `{ name: "Coach output" }`), and which casing reaches the accessibility tree
 * is a styling decision, not behaviour. Pinning it would make this file fail on
 * a change no user could see.
 */

const SEEDED_OBSERVATION = "Squat load has held steady for 3 sessions.";
const SEEDED_PROPOSAL = "Increase back squat working load by 2.5kg.";
const INJECTED_PROPOSAL = "Test-injected proposal.";

/** Every run on the rail announces itself with its cadence and when it ran. */
const runNodes = (page: Page) =>
  page.getByRole("button", { name: /(session review|cycle review|revision run|on demand|intake)/i });

/** The seeded run that emitted both seeded Decisions. */
const runThatSpoke = (page: Page) => page.getByRole("button", { name: /2 decisions/i });
/** The seeded run that ran, judged, and emitted nothing. */
const runThatSaidNothing = (page: Page) => page.getByRole("button", { name: /said nothing/i });
/** The seeded run that died before committing. */
const runThatFailed = (page: Page) => page.getByRole("button", { name: /failed:/i });

/** A Decision's own disclosure, inside an opened run. */
const workingToggles = (page: Page) => page.getByRole("button", { name: /show working/i });

/** The four evidence blocks that exist only when the run filled them in. */
const MEASUREMENTS = /what i measured/i;
const NAMED_RULE = /the rule i applied/i;
const SOURCES = /^sources$/i;
const UNCERTAINTY = /where this could be wrong/i;
/** The provenance footer names the data window, and nothing it does not hold (#79). */
const PROVENANCE = /ran \d+ \w+ · \d+ sessions? read/i;

/** Opens the record and opens the seeded run that emitted the two seeded Decisions. */
const openRecord = async (page: Page) => {
  await page.goto("/coach");
  await expectConnected(page);
  await expect(runNodes(page).first()).toBeVisible({ timeout: 15_000 });
};

const openSeededRun = async (page: Page) => {
  await runThatSpoke(page).click();
  // Both seeded items are under it: the record is everything the coach has
  // said, not only what is undecided.
  await expect(page.getByText(SEEDED_OBSERVATION)).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText(SEEDED_PROPOSAL)).toBeVisible();
};

/** The `show working` button belonging to the Decision whose summary is `summary`. */
const workingToggleFor = (page: Page, summary: string) =>
  page.locator("article", { hasText: summary }).getByRole("button", { name: /working/i });

const openToday = async (page: Page) => {
  await page.goto("/");
  await expectConnected(page);
  await expect(page.getByRole("heading", { name: "Today", exact: true })).toBeVisible();
  await expect(page.getByText(SEEDED_PROPOSAL)).toBeVisible({ timeout: 15_000 });
};

test.describe("The Coach record", () => {
  test.afterEach(async ({ request, context }) => {
    // Online first, then `reset` alone — the same teardown, for the same
    // reason, as `revise-a-proposal.spec.ts`: reset abandons anything in
    // flight and restores every lever before reseeding, and releasing a gate
    // by hand would instead let a held run *commit* into the race with the
    // reseed. Restoring the network first matters here specifically because
    // most of these tests end offline, and a context left offline would carry
    // into the next file.
    await setOffline(context, false);
    await resetServer(request);
  });

  test("lists runs newest-first", async ({ page, request }) => {
    await openRecord(page);
    const before = await runNodes(page).count();
    expect(before).toBeGreaterThan(1);

    // A genuinely new run, minted now, so this asserts the ordering *rule*
    // rather than the seed's own timestamps. It arrives over the live
    // subscription — no reload — which is also the only honest way to know
    // where a *new* run is placed.
    await request.post(`${DEV_SERVER_HTTP_URL}/__test__/push-proposal`);

    await expect(runNodes(page)).toHaveCount(before + 1, { timeout: 20_000 });

    // Top of the list, not appended to the bottom.
    const names = await runNodes(page).allInnerTexts();
    expect(names[0]).toMatch(/on demand/i);

    // And the seeded runs keep their own relative order — a new run being
    // inserted at the top is not the same claim as the list being sorted, and a
    // surface that only ever prepends new arrivals would pass the first
    // assertion while presenting a reloaded record in arbitrary order.
    const quietOrder = names.findIndex((name) => /said nothing/i.test(name));
    const failedOrder = names.findIndex((name) => /failed:/i.test(name));
    expect(quietOrder).toBeGreaterThanOrEqual(0);
    expect(failedOrder).toBeGreaterThan(quietOrder);

    await page.reload();
    await expect(runNodes(page)).toHaveCount(before + 1, { timeout: 20_000 });
    const afterReload = await runNodes(page).allInnerTexts();
    expect(afterReload[0]).toMatch(/on demand/i);
    expect(afterReload.findIndex((name) => /said nothing/i.test(name))).toBe(quietOrder);
    expect(afterReload.findIndex((name) => /failed:/i.test(name))).toBe(failedOrder);

    // The injected Proposal is under its own run, not floating loose — a
    // Decision belonging to no run would be invisible on this surface.
    await runNodes(page).first().click();
    await expect(page.getByText(INJECTED_PROPOSAL)).toBeVisible({ timeout: 20_000 });
  });

  test("a run that said nothing is on the record, and says what it read", async ({ page }) => {
    await openRecord(page);

    // Present at all — the claim that cannot be made from Decision rows,
    // because this run wrote none.
    await expect(runThatSaidNothing(page)).toBeVisible();

    // And it says what it read. Restraint the user can see is evidence the
    // coach is working; silence they cannot account for is indistinguishable
    // from a coach that is not running.
    await expect(runThatSaidNothing(page)).toContainText(/read 1 session/i);

    await runThatSaidNothing(page).click();
    await expect(
      page.getByText(/nothing cleared the bar for a change, so nothing was recorded/i),
    ).toBeVisible({ timeout: 20_000 });

    // Not a failure, and not an error. This is the anti-twitchy mechanism
    // working as designed (ADR 0011 §4), and dressing it in the vocabulary of
    // breakage would teach the user to distrust exactly the behaviour the
    // whole Observation mechanism exists to produce.
    await expect(runThatSaidNothing(page)).not.toContainText(/failed|error|problem/i);

    // It genuinely emitted nothing — no Decision appeared underneath it.
    await expect(workingToggles(page)).toHaveCount(0);
  });

  test("a run that failed says so, with its reason and what it did not write", async ({ page }) => {
    await openRecord(page);

    // The reason, not just the fact. "Something went wrong" tells the user
    // nothing they could not infer from the absence of advice.
    await expect(runThatFailed(page)).toContainText(/turn cap/i);

    await runThatFailed(page).click();

    // The part a user actually worries about when a coach breaks: whether
    // anything half-formed reached their plan (ADR 0011 §6 — nothing does).
    await expect(page.getByText(/nothing was recorded and your plan is unchanged/i)).toBeVisible({
      timeout: 20_000,
    });

    await expect(workingToggles(page)).toHaveCount(0);
  });

  test("a Decision's working is absent until it is expanded, then arrives in full", async ({
    page,
  }) => {
    await openRecord(page);

    // Everything collapsed: none of the working is on screen, and neither are
    // the summaries — the run node is the outer disclosure.
    await expect(page.getByText(MEASUREMENTS)).toHaveCount(0);
    await expect(page.getByText(NAMED_RULE)).toHaveCount(0);
    await expect(page.getByText(UNCERTAINTY)).toHaveCount(0);
    await expect(page.getByText(PROVENANCE)).toHaveCount(0);

    await openSeededRun(page);

    // The run is open and its Decisions are named — but the working still is
    // not here. This is the observable form of "fetched per Decision through
    // `decisions.get` when expanded, not shipped with the list" (#79): if the
    // list carried the working it would be here to render, and the surface
    // would have no reason to withhold it.
    await expect(page.getByText(MEASUREMENTS)).toHaveCount(0);
    await expect(page.getByText(NAMED_RULE)).toHaveCount(0);

    // The collapsed Decision says there is working to be had, without having it
    // — a Decision that discloses nothing is one nobody taps.
    await expect(workingToggles(page).first()).toBeVisible();

    await workingToggleFor(page, SEEDED_OBSERVATION).click();

    // Expanded: the seed's fully-worked Observation carries all of it.
    await expect(page.getByText(MEASUREMENTS)).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText(NAMED_RULE)).toBeVisible();
    await expect(page.getByText(SOURCES)).toBeVisible();
    await expect(page.getByText(UNCERTAINTY)).toBeVisible();

    // The provenance footer names what the data window genuinely holds —
    // cadence, when it ran, how much it read, roster version. #79 removed the
    // model id and token count #43 designed, because nothing persisted them
    // per Decision, and a footer naming a model would have been naming a guess.
    await expect(page.getByText(PROVENANCE)).toBeVisible();

    // A source carries its trust level. "Cited" and "cited and checked" are
    // different claims, and the badge is the only place a user can tell them
    // apart, so an unbadged citation is worse than none.
    await expect(page.getByText(/\[(verified|unverified)\]/i).first()).toBeVisible();

    // Collapsing puts it away again — the record is a list first, and an item
    // that cannot be closed turns the list into a wall.
    await workingToggleFor(page, SEEDED_OBSERVATION).click();
    await expect(page.getByText(MEASUREMENTS)).toHaveCount(0);
    await expect(page.getByText(SEEDED_OBSERVATION)).toBeVisible();

    // And so does the run, which is the outer half of the same claim.
    await runThatSpoke(page).click();
    await expect(page.getByText(SEEDED_OBSERVATION)).toHaveCount(0);
  });

  test("a block renders only when the run filled it in", async ({ page }) => {
    await openRecord(page);
    await openSeededRun(page);

    // The seed's Proposal is deliberately un-worked: no measurements, no
    // sources, no uncertainty, no provenance footer — only its reasoning. This
    // is the negative half of #79's optionality contract, and the failure it
    // guards is the one that looks harmless: an empty "Where this could be
    // wrong" heading, a "none given" row, a dash. A block that is always there
    // teaches the user to skip it, which costs the block its meaning on the
    // items that *did* fill it in.
    await workingToggleFor(page, SEEDED_PROPOSAL).click();
    await expect(page.getByText(/^reasoning$/i)).toBeVisible({ timeout: 20_000 });

    await expect(page.getByText(MEASUREMENTS)).toHaveCount(0);
    await expect(page.getByText(NAMED_RULE)).toHaveCount(0);
    await expect(page.getByText(SOURCES)).toHaveCount(0);
    await expect(page.getByText(UNCERTAINTY)).toHaveCount(0);
    await expect(page.getByText(PROVENANCE)).toHaveCount(0);

    // No placeholder standing in for the absent blocks, in any of its usual
    // disguises.
    await expect(page.getByText(/none given/i)).toHaveCount(0);
    await expect(page.getByText(/not (recorded|provided|available)/i)).toHaveCount(0);

    // And the positive half, on the same screen, so neither a surface that
    // always renders the blocks nor one that never does can pass this test.
    await workingToggleFor(page, SEEDED_OBSERVATION).click();
    await expect(page.getByText(MEASUREMENTS)).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText(UNCERTAINTY)).toBeVisible();
  });

  test("an undecided Decision says it is awaiting a decision on Today", async ({ page }) => {
    await openRecord(page);
    await openSeededRun(page);

    await expect(page.getByText(/awaiting your decision on today/i)).toBeVisible({
      timeout: 20_000,
    });

    // The Observation states its own, different outcome: it proposed nothing,
    // so there is nothing to await. Two Decisions, two outcomes, from one run —
    // which is what makes the outcome line informative rather than boilerplate.
    await expect(page.getByText(/no action proposed/i)).toBeVisible();
  });

  test("accepting on Today makes the record say the Proposal was applied", async ({ page }) => {
    await openToday(page);

    // Driving the transition, rather than reading a seeded outcome string, is
    // the whole point: the record's job is to say what *became* of an item, and
    // a seeded "accepted" proves only that a fixture rendered.
    await page.getByRole("button", { name: /^Accept/ }).click();
    await expect(page.getByText(SEEDED_PROPOSAL)).toHaveCount(0, { timeout: 15_000 });

    await openRecord(page);
    await openSeededRun(page);
    await expect(page.getByText(/accepted — applied to your plan/i)).toBeVisible({
      timeout: 20_000,
    });
    await expect(page.getByText(/awaiting your decision on today/i)).toHaveCount(0);
  });

  test("dismissing on Today leaves the Decision on the record, stated neutrally", async ({
    page,
  }) => {
    await openToday(page);

    await page.getByRole("button", { name: "Dismiss", exact: true }).click();
    await expect(page.getByText(SEEDED_PROPOSAL)).toHaveCount(0, { timeout: 15_000 });

    // ADR 0008: a rejected Proposal is kept as context the coach learns from.
    // So dismissal is not a deletion — the Decision is still on the record,
    // still under the run that produced it, still expandable, and its reasoning
    // still readable.
    await openRecord(page);
    await openSeededRun(page);
    await expect(page.getByText(/dismissed/i)).toBeVisible({ timeout: 20_000 });
    await workingToggleFor(page, SEEDED_PROPOSAL).click();
    await expect(page.getByText(/^reasoning$/i)).toBeVisible();

    // And it reads neutral, not as a failure. The vocabulary of failure is what
    // would make a user hesitate before dismissing the next one — which is
    // exactly the behaviour ADR 0008 does not want, since a dismissal is a
    // signal the coach is meant to receive.
    await expect(page.getByText(/rejected|error/i)).toHaveCount(0);
  });

  test("offline and never read, the record says it cannot be read — and shows no endless spinner", async ({
    page,
    context,
  }) => {
    // Reached by in-app navigation while offline, deliberately: a `goto` would
    // fail to fetch the document itself and test the dev server rather than the
    // surface. This is also the honest user path — the app was open, the link
    // dropped, the user tapped Coach.
    await openToday(page);
    await setOffline(context, true);

    await page.getByRole("link", { name: /Coach/ }).click();

    await expect(
      page.getByText(
        "Not connected to home — the record lives on the home server and cannot be read from here.",
      ),
    ).toBeVisible({ timeout: 20_000 });

    // Not a spinner that will never finish (#79). The record is online-only by
    // ADR 0002/0008, so "loading" is not a state it can be in while offline —
    // rendering one would promise an arrival that cannot happen.
    await expect(page.getByText(/loading the record/i)).toHaveCount(0);

    // And no content pretending to be the record.
    await expect(runNodes(page)).toHaveCount(0);
  });

  test("offline after reading, the record marks itself stale rather than passing as live", async ({
    page,
    context,
  }) => {
    await openRecord(page);
    await openSeededRun(page);

    await setOffline(context, true);

    // The distinct half of the offline contract: there *is* something on
    // screen, and the surface must not present the last thing it received as
    // current. Blanking it would be the other failure — throwing away readable
    // history over a dropped link — so the record stays and the caveat is
    // added.
    await expect(page.getByText("Not connected to home — this record may be out of date.")).toBeVisible(
      { timeout: 20_000 },
    );
    await expect(page.getByText(SEEDED_OBSERVATION)).toBeVisible();
    await expect(page.getByText(/loading the record/i)).toHaveCount(0);
  });

  test("the record offers no actions — it does not ask you to decide twice", async ({ page }) => {
    await openRecord(page);
    await openSeededRun(page);

    // Undecided on Today, and still undecided here: the Decision most likely to
    // grow an action button is the one that has one elsewhere.
    await expect(page.getByText(/awaiting your decision on today/i)).toBeVisible({
      timeout: 20_000,
    });

    await expect(page.getByRole("button", { name: /^Accept/ })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Dismiss", exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Revise", exact: true })).toHaveCount(0);
    await expect(page.getByPlaceholder("ask a question, object, or request a change")).toHaveCount(0);

    // Expanding the working too, so this is a claim about the surface rather
    // than about one collapsed state.
    await workingToggleFor(page, SEEDED_OBSERVATION).click();
    await expect(page.getByText(MEASUREMENTS)).toBeVisible({ timeout: 20_000 });
    await expect(page.getByRole("button", { name: /^Accept/ })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Dismiss", exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Revise", exact: true })).toHaveCount(0);

    // The actions are not merely absent from the record — they are still on
    // Today, where the decision belongs. Without this, deleting the actions
    // from both surfaces would pass.
    await openToday(page);
    await expect(page.getByRole("button", { name: /^Accept/ })).toBeVisible();
    await expect(page.getByRole("button", { name: "Dismiss", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Revise", exact: true })).toBeVisible();
  });

  test("the record shows how the coach reasoned, not what it cost", async ({ page }) => {
    await openRecord(page);
    await openSeededRun(page);
    await workingToggleFor(page, SEEDED_OBSERVATION).click();
    await expect(page.getByText(MEASUREMENTS)).toBeVisible({ timeout: 20_000 });

    // The stages ARE here: the deliberator drafting and the adversarial sweep
    // rewriting are how a Decision earned its way onto the record (ADR 0011
    // §1), and a record that hid the sweep would be hiding the trust floor.
    // Exact, because the failed run's reason names the deliberator too, and a
    // loose match would pass on that sentence rather than on the stage chips.
    await expect(page.getByText("deliberator", { exact: true })).toBeVisible();
    await expect(page.getByText("sweep", { exact: true })).toBeVisible();

    // What the run cost is not. ADR 0011 §8 puts tokens, model and cost in
    // Settings' spend section — and the data is one join away on the run
    // ledger, which is exactly why this leaks in by accident. The moment it
    // does, an explainability surface has become a telemetry one.
    await expect(page.getByText(/tokens?\b/i)).toHaveCount(0);
    await expect(page.getByText(/\$\d/)).toHaveCount(0);
    await expect(page.getByText(/claude-|sonnet|opus|haiku/i)).toHaveCount(0);
  });

  /**
   * Undecided, per issue #82 user story 5 — skipped rather than guessed.
   *
   * `superseded by a later version` is the one outcome in ui-surfaces.md's list
   * that this file cannot drive to. It is produced by a Revision run superseding
   * a Proposal (ADR 0013 §2), and the seed carries no already-superseded item —
   * which is correct, since the outcome is supposed to be *earned*. Driving it
   * would mean submitting a Revise on Today and then reading the record, and
   * that crosses into `revise-a-proposal.spec.ts`'s territory, which owns the
   * Revise journey.
   *
   * The run history sharpens the question rather than settling it. A Revision
   * run is now a node of its own carrying the user's own prose and the Answer it
   * produced, so "where does the superseded original live" has a third possible
   * answer — under its own earlier run, where it has always been — alongside
   * ui-surfaces.md's two (a separate item with its own outcome line, or folded
   * into its successor's collapsed lineage as on Today's card). The item-count
   * assertion this test would make differs between all three, and nothing
   * settles which. Unblocked by a decision, not by implementation work.
   */
  test.skip("a superseded Proposal states that it was superseded by a later version", () => {});
});
