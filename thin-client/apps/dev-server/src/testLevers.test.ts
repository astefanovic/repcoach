import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { describe, expect, it } from "vitest";

import type { Proposal, ProposalRevisionStatus } from "@repcoach/contracts";

import { DeliberationRunner } from "./deliberationRunner.ts";
import { Store } from "./store.ts";
import { makeDeliberationLevers } from "./testLevers.ts";

/**
 * The dev-only levers the rung-2 (Playwright) author drives the Revise
 * journeys with (issue #77). The canned deliberator returns instantly, so a
 * browser can never observe the states ADR 0013 §5 puts on the card —
 * "queued", "running", or a Cancel landing on either. These levers give the
 * dev-server the two knobs that make those states hold still long enough to
 * be seen from outside: hold/release the deliberator, and drive quota low/
 * available so a Revise queues rather than firing.
 *
 * Asserted through the runner's public `revisionStates` — never runner
 * internals — because that is exactly what the client's card renders from.
 */

const PENDING_PROPOSAL: Proposal = {
  id: "prop-lever-1" as never,
  origin: "coach-proposal",
  status: "pending",
  summary: "ORIGINAL: 5-day upper/lower split",
  rationale: "ORIGINAL-RATIONALE: volume trend supports 5 days",
  createdAt: "2026-07-01T00:00:00.000Z",
};

const statusOf = (runner: DeliberationRunner["Service"], proposalId: string) =>
  SubscriptionRef.get(runner.revisionStates).pipe(Effect.map((states) => states.get(proposalId)));

/**
 * Polls `revisionStates` until the Proposal reaches `expected`, or gives up.
 * `undefined` is a legitimate target: it is how "no run in flight" reads, and
 * it is what both the cancelled and the completed paths settle on.
 */
const waitForStatus = (
  runner: DeliberationRunner["Service"],
  proposalId: string,
  expected: ProposalRevisionStatus | undefined,
) =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < 200; attempt++) {
      const status = yield* statusOf(runner, proposalId);
      if (status === expected) return;
      yield* Effect.sleep("10 millis");
    }
    const actual = yield* statusOf(runner, proposalId);
    throw new Error(`expected ${proposalId} to reach "${expected}", last saw "${String(actual)}"`);
  });

describe("dev-server deliberation test levers", () => {
  it("holds a Revise in `running` until released, then lets it complete", async () => {
    const { layer, levers } = makeDeliberationLevers(Store.layer);
    const TestLayer = layer.pipe(Layer.provideMerge(Store.layer));

    await Effect.runPromise(
      Effect.gen(function* () {
        const store = yield* Store;
        const runner = yield* DeliberationRunner;
        yield* store.pushProposalForTest(PENDING_PROPOSAL);

        yield* levers.holdRuns;
        yield* runner.reviseProposal({ proposalId: PENDING_PROPOSAL.id, prose: "too much volume" });

        yield* waitForStatus(runner, PENDING_PROPOSAL.id, "running");
        // Still held: the state must not fall through to idle on its own.
        yield* Effect.sleep("100 millis");
        expect(yield* statusOf(runner, PENDING_PROPOSAL.id)).toBe("running");

        yield* levers.releaseRuns;
        yield* waitForStatus(runner, PENDING_PROPOSAL.id, undefined);
      }).pipe(Effect.provide(TestLayer), Effect.scoped),
    );
  });

  it("queues a Revise while quota is low and fires it once quota is available again", async () => {
    const { layer, levers } = makeDeliberationLevers(Store.layer);
    const TestLayer = layer.pipe(Layer.provideMerge(Store.layer));

    await Effect.runPromise(
      Effect.gen(function* () {
        const store = yield* Store;
        const runner = yield* DeliberationRunner;
        yield* store.pushProposalForTest(PENDING_PROPOSAL);

        yield* levers.setQuotaLow;
        // Held as well, so the drained run parks in `running` instead of
        // completing between two polls — the same pairing a flow uses to
        // watch the spinner change word.
        yield* levers.holdRuns;
        yield* runner.reviseProposal({ proposalId: PENDING_PROPOSAL.id, prose: "too much volume" });
        yield* waitForStatus(runner, PENDING_PROPOSAL.id, "queued");

        yield* levers.setQuotaAvailable;
        yield* waitForStatus(runner, PENDING_PROPOSAL.id, "running");

        yield* levers.releaseRuns;
      }).pipe(Effect.provide(TestLayer), Effect.scoped),
    );
  });

  it("`resetLevers` abandons a queued run rather than letting it commit a revision", async () => {
    const { layer, levers } = makeDeliberationLevers(Store.layer);
    const TestLayer = layer.pipe(Layer.provideMerge(Store.layer));

    await Effect.runPromise(
      Effect.gen(function* () {
        const store = yield* Store;
        const runner = yield* DeliberationRunner;
        yield* store.pushProposalForTest(PENDING_PROPOSAL);
        const before = yield* store.listDecisionsForTest;

        yield* levers.setQuotaLow;
        yield* runner.reviseProposal({ proposalId: PENDING_PROPOSAL.id, prose: "too much volume" });
        yield* waitForStatus(runner, PENDING_PROPOSAL.id, "queued");

        // The teardown path: quota comes back, but nothing may commit — a
        // revision landing here is what leaves the NEXT flow staring at a
        // revised Proposal where the seeded one should be.
        yield* levers.resetLevers;
        yield* Effect.sleep("300 millis");

        const after = yield* store.listDecisionsForTest;
        expect(after.length).toBe(before.length);
      }).pipe(Effect.provide(TestLayer), Effect.scoped),
    );
  });

  it("`resetLevers` clears a held run and restores quota, so specs stay independent", async () => {
    const { layer, levers } = makeDeliberationLevers(Store.layer);
    const TestLayer = layer.pipe(Layer.provideMerge(Store.layer));

    await Effect.runPromise(
      Effect.gen(function* () {
        const store = yield* Store;
        const runner = yield* DeliberationRunner;
        yield* store.pushProposalForTest(PENDING_PROPOSAL);

        yield* levers.setQuotaLow;
        yield* levers.holdRuns;
        yield* runner.reviseProposal({ proposalId: PENDING_PROPOSAL.id, prose: "too much volume" });
        yield* waitForStatus(runner, PENDING_PROPOSAL.id, "queued");

        yield* levers.resetLevers;
        yield* waitForStatus(runner, PENDING_PROPOSAL.id, undefined);
      }).pipe(Effect.provide(TestLayer), Effect.scoped),
    );
  });

  it("a run started while held can still be cancelled, and a fresh Revise is accepted after", async () => {
    const { layer, levers } = makeDeliberationLevers(Store.layer);
    const TestLayer = layer.pipe(Layer.provideMerge(Store.layer));

    await Effect.runPromise(
      Effect.gen(function* () {
        const store = yield* Store;
        const runner = yield* DeliberationRunner;
        yield* store.pushProposalForTest(PENDING_PROPOSAL);

        yield* levers.holdRuns;
        yield* runner.reviseProposal({ proposalId: PENDING_PROPOSAL.id, prose: "first attempt" });
        yield* waitForStatus(runner, PENDING_PROPOSAL.id, "running");

        yield* runner.cancelRevision({ proposalId: PENDING_PROPOSAL.id });
        expect(yield* statusOf(runner, PENDING_PROPOSAL.id)).toBeUndefined();

        yield* runner.reviseProposal({ proposalId: PENDING_PROPOSAL.id, prose: "second attempt" });
        yield* waitForStatus(runner, PENDING_PROPOSAL.id, "running");

        // Leave nothing forked behind a permanent gate.
        yield* levers.resetLevers;
      }).pipe(Effect.provide(TestLayer), Effect.scoped),
    );
  });
});
