import * as Effect from "effect/Effect";
import { HttpRouter, HttpServerResponse } from "effect/unstable/http";

import { SEEDED_SESSION_ID, Store } from "./store.ts";
import type { AgentBacking } from "./agentMode.ts";
import type { ConnectionRegistry } from "./connectionRegistry.ts";
import type { DeliberationLevers } from "./testLevers.ts";

/**
 * Dev-only test-control channel (issue #16 / thin-client-implementation-plan
 * "Task 2"). This is the adversarial e2e author's external lever for
 * inducing offline/blip conditions on the server side — never a hook in the
 * client (see thin-client-implementation-plan.md "the adversarial
 * separation").
 *
 * - `POST /__test__/drop-socket` — force-closes every live connection
 *   (including upgraded WebSockets), simulating a dead link.
 * - `POST /__test__/pause-acks` — the store keeps accepting `logSetActual`
 *   writes but withholds the RPC response, simulating a half-open link.
 * - `POST /__test__/resume-acks` — lifts a `pause-acks` gate WITHOUT
 *   wiping the store (Task 4, issue #18): lets an adversarial test observe
 *   the previously-withheld response land against otherwise-untouched
 *   store state, which `reset`'s atomic wipe would otherwise race.
 * - `POST /__test__/reset` — clears the store back to its seed and resumes
 *   normal ack behavior.
 * - `GET /__test__/logged-actuals` — every applied `logSetActual` result
 *   (Task 4, issue #18): the adversarial e2e author's server-side read lever
 *   for asserting "no loss, no duplicates" without reaching into client
 *   internals.
 * - `GET /__test__/context-notes` — every stored Context note, anchored or not
 *   (issue #130): the read lever for "Add a note", mirroring
 *   `/__test__/logged-actuals` — a note is not a Set, so it needed its own.
 * - `GET /__test__/changes` — every recorded Change row with its data window
 *   (#80): the read lever for exactly-once on the *structural edit* path, where
 *   idempotent operations hide duplicate application from the Plan itself.
 * - `POST /__test__/mutate-prescribed-session` — mutates the seeded
 *   Prescribed Session's load target in place (Task 5, issue #19, G3): the
 *   lever a frozen-in-flight test uses to prove a prefetched/cached copy is
 *   unaffected by a later server-side prescription edit.
 * - `POST /__test__/shorten-rest` — rewrites the seeded Prescribed Session's
 *   prescribed rest down to a few seconds (#113 item 2), so a flow can watch
 *   the rest pill reach zero and keep counting without idling for the seeded
 *   2:00. Sets that prescribe no rest keep prescribing none, so the
 *   no-pill-without-a-prescription flow is unaffected. This is the lever the
 *   long-skipped "the pill dismisses itself at zero" test was waiting on.
 * - `POST /__test__/hold-deliberation` / `POST /__test__/release-deliberation`
 *   — gate the canned deliberator so a Revise run holds in `running` long
 *   enough for a browser to observe the locked card (issue #77, ADR 0013 §5).
 * - `POST /__test__/quota-low` / `POST /__test__/quota-available` — drive the
 *   runner's deferral queue (ADR 0011 §8) so a Revise sits in `queued`
 *   instead of dispatching. See `testLevers.ts`.
 * - `GET /__test__/agent-sessions` — which agents this server is running, and
 *   what every session it ran did (issue #95). This is the READ lever that
 *   makes an agent-backed flow's failure legible: without it, a live session
 *   that could not start surfaces in the report as a heading that never
 *   appeared, which reads as flake and sends the next person to debug the
 *   client. See `agentSessionLog.ts`.
 *
 * `POST /__test__/reset` also restores both levers to their defaults, so a
 * flow that fails mid-hold cannot wedge the next one.
 */
/**
 * What `/__test__/shorten-rest` rewrites prescribed rest to. Long enough that
 * a browser can read the pill before it reaches zero, short enough that
 * watching it go past zero costs a flow a few seconds rather than two minutes.
 */
const SHORTENED_REST_SEC = 5;

export const makeTestControlRoutesLayer = (
  registry: ConnectionRegistry,
  levers: DeliberationLevers,
  options?: { readonly agentBacking?: AgentBacking },
) =>
  HttpRouter.addAll([
    HttpRouter.route(
      "GET",
      "/__test__/agent-sessions",
      // Answers on a canned server too, and says `canned` — a flow that wants
      // real agents can then assert it is talking to one rather than passing
      // vacuously against the scripted layers, which is the failure mode a
      // 404-when-canned would have left wide open.
      Effect.suspend(() =>
        HttpServerResponse.json(
          options?.agentBacking === undefined
            ? { mode: "canned", sessions: 0, cumulativeCostUsd: 0, entries: [] }
            : options.agentBacking.snapshot(),
        ),
      ),
    ),
    HttpRouter.route(
      "POST",
      "/__test__/drop-socket",
      Effect.sync(() => {
        const droppedCount = registry.size();
        // Deferred to the next macrotask so this very request's own response
        // bytes have a chance to flush before its socket is among those
        // destroyed — `dropAll` is deliberately indiscriminate (issue #16
        // wants *every* live connection dropped, including this one), it
        // just shouldn't race its own reply.
        setImmediate(() => registry.dropAll());
        return droppedCount;
      }).pipe(Effect.flatMap((droppedCount) => HttpServerResponse.json({ droppedCount }))),
    ),
    HttpRouter.route(
      "POST",
      "/__test__/pause-acks",
      Effect.gen(function* () {
        const store = yield* Store;
        yield* store.pauseAcks;
        return yield* HttpServerResponse.json({ paused: true });
      }),
    ),
    HttpRouter.route(
      "POST",
      "/__test__/resume-acks",
      Effect.gen(function* () {
        const store = yield* Store;
        yield* store.resumeAcks;
        return yield* HttpServerResponse.json({ resumed: true });
      }),
    ),
    HttpRouter.route(
      "POST",
      "/__test__/reset",
      Effect.gen(function* () {
        const store = yield* Store;
        // Levers first: `resetLevers` abandons anything in flight, so no run
        // can commit into the store *after* it has been reseeded below.
        yield* levers.resetLevers;
        yield* store.reset;
        return yield* HttpServerResponse.json({ reset: true });
      }),
    ),
    HttpRouter.route(
      "POST",
      "/__test__/hold-deliberation",
      levers.holdRuns.pipe(Effect.andThen(HttpServerResponse.json({ held: true }))),
    ),
    HttpRouter.route(
      "POST",
      "/__test__/release-deliberation",
      levers.releaseRuns.pipe(Effect.andThen(HttpServerResponse.json({ released: true }))),
    ),
    HttpRouter.route(
      "POST",
      "/__test__/quota-low",
      levers.setQuotaLow.pipe(Effect.andThen(HttpServerResponse.json({ quotaLow: true }))),
    ),
    HttpRouter.route(
      "POST",
      "/__test__/quota-available",
      levers.setQuotaAvailable.pipe(Effect.andThen(HttpServerResponse.json({ quotaLow: false }))),
    ),
    HttpRouter.route(
      "POST",
      "/__test__/mutate-prescribed-session",
      Effect.gen(function* () {
        const store = yield* Store;
        const mutated = yield* store.mutatePrescribedSessionForTest(SEEDED_SESSION_ID);
        return yield* HttpServerResponse.json({ mutated: mutated._tag === "Some" });
      }),
    ),
    HttpRouter.route(
      "POST",
      "/__test__/shorten-rest",
      Effect.gen(function* () {
        const store = yield* Store;
        const shortened = yield* store.shortenPrescribedRestForTest(
          SEEDED_SESSION_ID,
          SHORTENED_REST_SEC,
        );
        // The value is reported back rather than left for the flow to
        // hard-code: the flow asserts the pill OPENS at whatever rest is
        // prescribed, and a constant duplicated on both sides of the wire
        // would let that assertion pass against the wrong number.
        return yield* HttpServerResponse.json({
          shortened: shortened._tag === "Some",
          restSec: SHORTENED_REST_SEC,
        });
      }),
    ),
    HttpRouter.route(
      "POST",
      "/__test__/open-prescribed-load",
      Effect.gen(function* () {
        const store = yield* Store;
        const opened = yield* store.openPrescribedLoadForTest(SEEDED_SESSION_ID);
        return yield* HttpServerResponse.json({ opened: opened._tag === "Some" });
      }),
    ),
    HttpRouter.route(
      "GET",
      "/__test__/logged-actuals",
      Effect.gen(function* () {
        const store = yield* Store;
        const actuals = yield* store.listActuals;
        return yield* HttpServerResponse.json({ actuals });
      }),
    ),
    HttpRouter.route(
      "GET",
      "/__test__/context-notes",
      Effect.gen(function* () {
        const store = yield* Store;
        const notes = yield* store.listContextNotes;
        return yield* HttpServerResponse.json({ notes });
      }),
    ),
    HttpRouter.route(
      "GET",
      "/__test__/entry-swaps",
      // #131, ADR 0019 — the read lever for a swap that reached the server,
      // mirroring `/__test__/logged-actuals` above (`getLoggedSession` is a
      // WS RPC, not a plain HTTP endpoint, so an e2e flow needs its own
      // `/__test__` lever the same way the actuals path already did).
      Effect.gen(function* () {
        const store = yield* Store;
        const swaps = yield* store.listEntrySwaps;
        return yield* HttpServerResponse.json({ swaps });
      }),
    ),
    HttpRouter.route(
      "POST",
      "/__test__/push-proposal",
      // Task 8 (issue #22): injects a new pending Proposal into the live
      // feed/proposals subscriptions, for the adversarial e2e author to
      // prove the feed updates without a reconnect.
      Effect.gen(function* () {
        const store = yield* Store;
        const id = `proposal-test-${Date.now()}`;
        yield* store.pushProposalForTest({
          id: id as never,
          origin: "coach-proposal",
          status: "pending",
          summary: "Test-injected proposal.",
          rationale: "Injected via /__test__/push-proposal for e2e verification.",
          createdAt: new Date().toISOString(),
        });
        return yield* HttpServerResponse.json({ id });
      }),
    ),
    HttpRouter.route(
      "GET",
      "/__test__/changes",
      // #80: the read lever for "a Plan edit replayed after a dead spot leaves
      // exactly ONE Change row". `/__test__/plan` cannot answer that — the
      // whole hazard is a *duplicated* application, and the operation union is
      // built to be idempotent, so a double-applied `renameSession` leaves a
      // Plan identical to a single-applied one while quietly writing the
      // user's history twice. The Change rows are where the difference shows.
      Effect.gen(function* () {
        const store = yield* Store;
        const decisions = yield* store.listDecisionsForTest;
        const changes = decisions
          .filter((decision) => decision.kind === "change")
          .map((decision) => ({
            id: decision.id,
            origin: decision.origin,
            status: decision.status,
            summary: decision.summary,
            dataWindow:
              decision.dataWindowJson === null
                ? null
                : (JSON.parse(decision.dataWindowJson) as unknown),
          }));
        return yield* HttpServerResponse.json({ changes });
      }),
    ),
    HttpRouter.route(
      "GET",
      "/__test__/plan",
      Effect.gen(function* () {
        const store = yield* Store;
        const plan = yield* store.getPlan;
        return yield* HttpServerResponse.json({ plan });
      }),
    ),
  ]);
