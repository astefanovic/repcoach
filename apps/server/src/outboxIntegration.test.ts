import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as Socket from "effect/unstable/socket/Socket";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { Connection, Outbox, Rpc } from "@repcoach/client-runtime";
import { CommandId, EntryId, ExerciseId, LoggedSessionId, SessionId, SetId } from "@repcoach/contracts";

import { makeDevServer } from "./server.ts";
import { fetchWithRetry, waitForServerReady } from "./testing/testServerReady.ts";

const { Connectivity, ConnectionDriverModule, DevServerConnectionTarget, SupervisorModule, Wakeups } =
  Connection;
type SupervisorState = Connection.SupervisorConnectionState;

/**
 * Task 4 (issue #18, G1) rung-1 evidence run against the *real* dev-server
 * (same boot pattern as `clientIntegration.test.ts`): proves flush is
 * exactly-once from the client's view, a duplicate flush attempt doesn't
 * double-apply server-side (idempotent `commandId`), and the half-open-link
 * (`pause-acks`) path holds a flushed item pending until acks resume, then
 * drains to exactly one server-side actual.
 *
 * #80 extended it to the second command kind the outbox now carries. The Plan
 * cases below deliberately mirror the logging ones rather than inventing a
 * separate seam — if generalising the outbox was the right call, the same
 * evidence should hold for both kinds, and the tests should look the same.
 */
describe("outbox against the Task 2 dev-server (Node, real socket)", () => {
  let baseUrl: string;
  let wsBaseUrl: string;
  let serverFiber: Fiber.Fiber<never, never>;

  beforeAll(async () => {
    const { layer, nodeServer } = makeDevServer({ port: 0 });
    const listening = new Promise<void>((resolve) => {
      nodeServer.once("listening", () => resolve());
    });
    serverFiber = Effect.runFork(Layer.launch(layer) as Effect.Effect<never, never>);
    await listening;

    const address = nodeServer.address();
    if (address === null || typeof address === "string") {
      throw new Error("expected an AddressInfo from the dev-server's Node HTTP server");
    }
    baseUrl = `http://127.0.0.1:${address.port}`;
    wsBaseUrl = `ws://127.0.0.1:${address.port}`;
    await waitForServerReady(baseUrl);
  });

  afterAll(async () => {
    await Effect.runPromise(Fiber.interrupt(serverFiber));
  });

  const webSocketConstructorLayer = Layer.succeed(
    Socket.WebSocketConstructor,
    (url: string | URL) => new WebSocket(url) as unknown as globalThis.WebSocket,
  );

  const dependencies = Layer.mergeAll(
    Connectivity.layer({ status: Effect.succeed("online"), changes: Stream.empty }),
    Wakeups.layer({ changes: Stream.empty }),
    ConnectionDriverModule.layer.pipe(
      Layer.provide(Rpc.sessionLayer.pipe(Layer.provide(webSocketConstructorLayer))),
    ),
  );

  const makeConnectedSupervisor = Effect.gen(function* () {
    const supervisor = yield* SupervisorModule.make(
      new DevServerConnectionTarget({
        environmentId: "dev-server",
        label: "Local dev-server",
        httpBaseUrl: baseUrl,
        wsBaseUrl,
      }),
      { initiallyDesired: true },
    );
    yield* SubscriptionRef.changes(supervisor.state).pipe(
      Stream.filter((state: SupervisorState) => state.phase === "connected"),
      Stream.runHead,
      Effect.map(Option.getOrThrow),
    );
    return supervisor;
  });

  const testItem = (commandId: string, loggedSessionId: LoggedSessionId) => ({
    kind: "logSetActual" as const,
    commandId: CommandId.make(commandId),
    loggedSessionId,
    sessionId: SessionId.make("session-seed-1"),
    entryId: EntryId.make("entry-1"),
    setId: SetId.make("set-1"),
    setType: "working" as const,
    actual: { reps: 5, load: 100 },
  });

  it("flushes an enqueued item exactly-once and removes it from the outbox on ack", async () => {
    await fetchWithRetry(`${baseUrl}/__test__/reset`, { method: "POST" });

    const outcome = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const supervisor = yield* makeConnectedSupervisor;
          const session = yield* SubscriptionRef.get(supervisor.session).pipe(
            Effect.map(Option.getOrThrow),
          );
          const { loggedSessionId } = yield* session.client["session.start"]({
            prescribedSessionId: SessionId.make("session-seed-1"),
          });
          const manager = yield* Outbox.makeOutboxManager(Outbox.makeInMemoryOutboxStorage());
          yield* Effect.forkScoped(Outbox.runFlusher(supervisor, manager));

          yield* manager.enqueue(testItem("cmd-exactly-once", loggedSessionId));

          const drained = yield* SubscriptionRef.changes(manager.queued).pipe(
            Stream.filter((items) => items.length === 0),
            Stream.runHead,
          );
          return Option.isSome(drained);
        }),
      ).pipe(Effect.provide(dependencies)),
    );

    expect(outcome).toBe(true);

    const body = (await (await fetchWithRetry(`${baseUrl}/__test__/logged-actuals`)).json()) as {
      readonly actuals: ReadonlyArray<{ readonly commandId: string }>;
    };
    expect(body.actuals.map((a) => a.commandId)).toEqual(["cmd-exactly-once"]);
  });

  it("a duplicate flush attempt (re-delivery) does not double-apply server-side", async () => {
    await fetchWithRetry(`${baseUrl}/__test__/reset`, { method: "POST" });

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const supervisor = yield* makeConnectedSupervisor;
          const session = yield* SubscriptionRef.get(supervisor.session).pipe(
            Effect.map(Option.getOrThrow),
          );
          const { loggedSessionId } = yield* session.client["session.start"]({
            prescribedSessionId: SessionId.make("session-seed-1"),
          });
          const input = testItem("cmd-duplicate", loggedSessionId);
          // Simulate the outbox replaying the same commandId twice (e.g. the
          // first ack was lost in transit even though the write landed).
          yield* session.client["logging.logSetActual"](input);
          yield* session.client["logging.logSetActual"](input);
        }),
      ).pipe(Effect.provide(dependencies)),
    );

    const body = (await (await fetchWithRetry(`${baseUrl}/__test__/logged-actuals`)).json()) as {
      readonly actuals: ReadonlyArray<{ readonly commandId: string }>;
    };
    expect(body.actuals.filter((a) => a.commandId === "cmd-duplicate")).toHaveLength(1);
  });

  it("half-open link: a flushed item is NOT removed while acks are paused, and resuming acks drains it to exactly one server-side actual", async () => {
    await fetchWithRetry(`${baseUrl}/__test__/reset`, { method: "POST" });
    const pauseResponse = await fetchWithRetry(`${baseUrl}/__test__/pause-acks`, { method: "POST" });
    expect(pauseResponse.ok).toBe(true);

    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const supervisor = yield* makeConnectedSupervisor;
          const session = yield* SubscriptionRef.get(supervisor.session).pipe(
            Effect.map(Option.getOrThrow),
          );
          const { loggedSessionId } = yield* session.client["session.start"]({
            prescribedSessionId: SessionId.make("session-seed-1"),
          });
          const manager = yield* Outbox.makeOutboxManager(Outbox.makeInMemoryOutboxStorage());
          yield* Effect.forkScoped(Outbox.runFlusher(supervisor, manager));

          yield* manager.enqueue(testItem("cmd-half-open", loggedSessionId));
          // Give the flusher a beat to send the (unacked) request.
          yield* Effect.sleep("1 second");
          const stillPending = (yield* SubscriptionRef.get(manager.queued)).length;

          yield* Effect.promise(() => fetchWithRetry(`${baseUrl}/__test__/resume-acks`, { method: "POST" }));

          // The withheld ack should now land, and the flusher should drain
          // the item off the client-side queue.
          yield* SubscriptionRef.changes(manager.queued).pipe(
            Stream.filter((items) => items.length === 0),
            Stream.runHead,
          );

          return { stillPending };
        }),
      ).pipe(Effect.provide(dependencies)),
    );
    expect(result.stillPending).toBe(1);

    const body = (await (await fetchWithRetry(`${baseUrl}/__test__/logged-actuals`)).json()) as {
      readonly actuals: ReadonlyArray<{ readonly commandId: string }>;
    };
    expect(body.actuals.filter((a) => a.commandId === "cmd-half-open")).toHaveLength(1);
  });

  // --- #80: the Plan-edit command kind ------------------------------------

  interface ChangeRow {
    readonly summary: string;
    readonly dataWindow: { readonly operation?: string; readonly commandId?: string } | null;
  }

  const listChanges = async (): Promise<ReadonlyArray<ChangeRow>> => {
    const body = (await (await fetchWithRetry(`${baseUrl}/__test__/changes`)).json()) as {
      readonly changes: ReadonlyArray<ChangeRow>;
    };
    return body.changes;
  };

  const planEdit = (commandId: string, name: string) =>
    ({
      kind: "applyPlanEdit" as const,
      commandId: CommandId.make(commandId),
      operation: {
        _tag: "renameSession" as const,
        sessionId: SessionId.make("session-seed-1"),
        name,
      },
    }) satisfies Outbox.NewQueuedPlanEdit;

  it("flushes an enqueued Plan edit exactly-once and removes it from the outbox on ack", async () => {
    await fetchWithRetry(`${baseUrl}/__test__/reset`, { method: "POST" });

    const drained = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const supervisor = yield* makeConnectedSupervisor;
          const manager = yield* Outbox.makeOutboxManager(Outbox.makeInMemoryOutboxStorage());
          yield* Effect.forkScoped(Outbox.runFlusher(supervisor, manager));

          yield* manager.enqueue(planEdit("cmd-plan-once", "Renamed by the outbox"));

          return yield* SubscriptionRef.changes(manager.queued).pipe(
            Stream.filter((items) => items.length === 0),
            Stream.runHead,
          );
        }),
      ).pipe(Effect.provide(dependencies)),
    );

    expect(Option.isSome(drained)).toBe(true);

    const changes = await listChanges();
    const mine = changes.filter((c) => c.dataWindow?.commandId === "cmd-plan-once");
    expect(mine).toHaveLength(1);
    expect(mine[0]?.dataWindow?.operation).toBe("renameSession");
  });

  /**
   * The ticket's strongest single assertion, at rung 1: a replayed Plan edit
   * leaves **exactly one Change row**.
   *
   * The Plan alone cannot witness this. `renameSession` is idempotent by
   * design (#71 — whole-value operations are what make replay safe), so
   * applying it twice leaves a Plan byte-identical to applying it once. The
   * duplicate would show up only in the user's history, as two records of an
   * edit they made once. That is what `planEditsByCommandId` prevents, and
   * what the old direct-RPC path could never reach, because it minted a fresh
   * commandId per attempt.
   */
  it("a replayed Plan edit does not double-apply: one commandId, exactly one Change row", async () => {
    await fetchWithRetry(`${baseUrl}/__test__/reset`, { method: "POST" });

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const supervisor = yield* makeConnectedSupervisor;
          const session = yield* SubscriptionRef.get(supervisor.session).pipe(
            Effect.map(Option.getOrThrow),
          );
          const input = {
            operation: planEdit("cmd-plan-replay", "Renamed once").operation,
            commandId: CommandId.make("cmd-plan-replay"),
          };
          // The outbox replaying the same command after a lost ack.
          yield* session.client["plan.applyUserChange"](input);
          yield* session.client["plan.applyUserChange"](input);
        }),
      ).pipe(Effect.provide(dependencies)),
    );

    const changes = await listChanges();
    expect(changes.filter((c) => c.dataWindow?.commandId === "cmd-plan-replay")).toHaveLength(1);
  });

  /**
   * Order is the one guarantee a Plan edit needs that a logged Set does not.
   * "Add exercise" is `addEntry` then `replaceEntrySets` naming the Entry the
   * first one creates, so a queue that drained out of order would deliver an
   * operation against a Plan that cannot satisfy it — and the second edit
   * would be permanently rejected rather than merely retried.
   */
  it("drains queued Plan edits in enqueue order", async () => {
    await fetchWithRetry(`${baseUrl}/__test__/reset`, { method: "POST" });

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const supervisor = yield* makeConnectedSupervisor;
          const manager = yield* Outbox.makeOutboxManager(Outbox.makeInMemoryOutboxStorage());
          yield* Effect.forkScoped(Outbox.runFlusher(supervisor, manager));

          yield* manager.enqueue(planEdit("cmd-order-1", "First name"));
          yield* manager.enqueue(planEdit("cmd-order-2", "Second name"));
          yield* manager.enqueue(planEdit("cmd-order-3", "Third name"));

          yield* SubscriptionRef.changes(manager.queued).pipe(
            Stream.filter((items) => items.length === 0),
            Stream.runHead,
          );
        }),
      ).pipe(Effect.provide(dependencies)),
    );

    // Last write wins, and "last" must mean the one enqueued last.
    const planBody = (await (await fetchWithRetry(`${baseUrl}/__test__/plan`)).json()) as {
      readonly plan: { readonly sessions: ReadonlyArray<{ readonly name: string }> };
    };
    expect(planBody.plan.sessions[0]?.name).toBe("Third name");

    const changes = await listChanges();
    const ordered = ["cmd-order-1", "cmd-order-2", "cmd-order-3"].map((id) =>
      changes.find((c) => c.dataWindow?.commandId === id),
    );
    expect(ordered.every((c) => c !== undefined)).toBe(true);
  });

  // --- #130: the addEntryNote command kind --------------------------------

  const noteItem = (commandId: string, loggedSessionId: LoggedSessionId) => ({
    kind: "addEntryNote" as const,
    commandId: CommandId.make(commandId),
    loggedSessionId,
    entryId: EntryId.make("entry-1"),
    text: "left elbow twinged on set 3",
    recordedAt: "2026-08-19T08:00:00.000Z",
  });

  it("flushes an enqueued note exactly-once, and a replayed commandId does not double-apply", async () => {
    await fetchWithRetry(`${baseUrl}/__test__/reset`, { method: "POST" });

    const notes = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const supervisor = yield* makeConnectedSupervisor;
          const session = yield* SubscriptionRef.get(supervisor.session).pipe(
            Effect.map(Option.getOrThrow),
          );
          const { loggedSessionId } = yield* session.client["session.start"]({
            prescribedSessionId: SessionId.make("session-seed-1"),
          });
          const manager = yield* Outbox.makeOutboxManager(Outbox.makeInMemoryOutboxStorage());
          yield* Effect.forkScoped(Outbox.runFlusher(supervisor, manager));

          yield* manager.enqueue(noteItem("cmd-note-exactly-once", loggedSessionId));
          yield* SubscriptionRef.changes(manager.queued).pipe(
            Stream.filter((items) => items.length === 0),
            Stream.runHead,
          );

          // Simulate the outbox replaying the same commandId a second time
          // (e.g. the ack was lost in transit even though the write landed)
          // — a genuine second flush, not merely a re-render.
          yield* session.client["contextNotes.add"]({
            commandId: CommandId.make("cmd-note-exactly-once"),
            loggedSessionId,
            entryId: EntryId.make("entry-1"),
            text: "left elbow twinged on set 3",
            recordedAt: "2026-08-19T08:00:00.000Z",
          });

          const logged = yield* session.client["logging.getLoggedSession"]({ loggedSessionId });
          return logged.notes;
        }),
      ).pipe(Effect.provide(dependencies)),
    );

    expect(notes.filter((n) => n.id === "cmd-note-exactly-once")).toHaveLength(1);
    expect(notes[0]?.entryId).toBe("entry-1");
    expect(notes[0]?.text).toBe("left elbow twinged on set 3");
  });

  // --- UAT: the editEntryNote command kind --------------------------------

  /**
   * The end-to-end shape of "editing, not appending": add a note, then edit
   * it through the queue, and the Entry still has exactly ONE note carrying
   * the new text.
   *
   * The count is the whole assertion. The bug this replaces was not a wrong
   * string on screen — it was a second note beside the first, which is both
   * what the user saw under the exercise name and what the coach would have
   * read as two separate observations.
   *
   * It also proves the edit could not have been modelled as a re-sent
   * `addEntryNote`: that path is `ON CONFLICT(id) DO NOTHING`, so under the
   * same id it would leave the ORIGINAL text here and pass a same-count
   * check while doing nothing at all.
   */
  it("flushes a note rewrite: the entry keeps one note, carrying the new text", async () => {
    await fetchWithRetry(`${baseUrl}/__test__/reset`, { method: "POST" });

    const notes = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const supervisor = yield* makeConnectedSupervisor;
          const session = yield* SubscriptionRef.get(supervisor.session).pipe(
            Effect.map(Option.getOrThrow),
          );
          const { loggedSessionId } = yield* session.client["session.start"]({
            prescribedSessionId: SessionId.make("session-seed-1"),
          });
          const manager = yield* Outbox.makeOutboxManager(Outbox.makeInMemoryOutboxStorage());
          yield* Effect.forkScoped(Outbox.runFlusher(supervisor, manager));

          yield* manager.enqueue(noteItem("cmd-note-to-edit", loggedSessionId));
          // Both enqueued before either drains, which is the offline case:
          // a note typed and then refined in a dead spot arrives as an add
          // followed by its rewrite, in `seq` order.
          yield* manager.enqueue({
            kind: "editEntryNote" as const,
            commandId: CommandId.make("cmd-note-edit"),
            loggedSessionId,
            entryId: EntryId.make("entry-1"),
            noteId: "cmd-note-to-edit",
            text: "left elbow twinged, fine after the warmup",
          });
          yield* SubscriptionRef.changes(manager.queued).pipe(
            Stream.filter((items) => items.length === 0),
            Stream.runHead,
          );

          const logged = yield* session.client["logging.getLoggedSession"]({ loggedSessionId });
          return logged.notes;
        }),
      ).pipe(Effect.provide(dependencies)),
    );

    expect(notes).toHaveLength(1);
    expect(notes[0]?.id).toBe("cmd-note-to-edit");
    expect(notes[0]?.text).toBe("left elbow twinged, fine after the warmup");
    // Unmoved in time — the note still belongs where it was recorded.
    expect(notes[0]?.recordedAt).toBe("2026-08-19T08:00:00.000Z");
  });

  /**
   * A rewrite naming a note the server has never heard of must DRAIN, not
   * wedge. The queue is FIFO, so a command that failed permanently here
   * would block every set logged after it — the worst possible failure mode
   * for the one write path the whole local-first bet rests on.
   */
  it("drains a rewrite whose note the server does not have, leaving the queue empty", async () => {
    await fetchWithRetry(`${baseUrl}/__test__/reset`, { method: "POST" });

    const remaining = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const supervisor = yield* makeConnectedSupervisor;
          const session = yield* SubscriptionRef.get(supervisor.session).pipe(
            Effect.map(Option.getOrThrow),
          );
          const { loggedSessionId } = yield* session.client["session.start"]({
            prescribedSessionId: SessionId.make("session-seed-1"),
          });
          const manager = yield* Outbox.makeOutboxManager(Outbox.makeInMemoryOutboxStorage());
          yield* Effect.forkScoped(Outbox.runFlusher(supervisor, manager));

          yield* manager.enqueue({
            kind: "editEntryNote" as const,
            commandId: CommandId.make("cmd-note-edit-orphan"),
            loggedSessionId,
            entryId: EntryId.make("entry-1"),
            noteId: "a-note-this-store-never-had",
            text: "into the void",
          });
          yield* SubscriptionRef.changes(manager.queued).pipe(
            Stream.filter((items) => items.length === 0),
            Stream.runHead,
          );
          return yield* SubscriptionRef.get(manager.queued);
        }),
      ).pipe(Effect.provide(dependencies)),
    );

    expect(remaining).toHaveLength(0);
  });

  // --- #83, ADR 0019: the unlogSetActual command kind ---------------------

  interface ActualRow {
    readonly commandId: string;
    readonly setId: string;
    readonly retraction: boolean;
  }

  const listActuals = async (): Promise<ReadonlyArray<ActualRow>> => {
    const body = (await (await fetchWithRetry(`${baseUrl}/__test__/logged-actuals`)).json()) as {
      readonly actuals: ReadonlyArray<ActualRow>;
    };
    return body.actuals;
  };

  const unlogItem = (commandId: string, loggedSessionId: LoggedSessionId) => ({
    kind: "unlogSetActual" as const,
    commandId: CommandId.make(commandId),
    loggedSessionId,
    entryId: EntryId.make("entry-1"),
    setId: SetId.make("set-1"),
  });

  /**
   * The ticket's strongest single assertion for #83: a retraction enqueued
   * through the outbox, then REPLAYED (the outbox's own "the ack was lost
   * in a dead spot, resend on reconnect" story #80/#130 already exercise for
   * their own kinds) leaves the durable, literal history at exactly TWO
   * rows — the log and its retraction — never zero and never three.
   * `unlogSetActual` has no pause-gate story (unlike `logSetActual`, ADR
   * 0019's "no lookup validation" note), so replay is modeled the same way
   * `addEntryNote`'s replay test above models it: a genuine second
   * server-side call with the same `commandId`, not a paused link.
   * `/__test__/logged-actuals` keeps every applied row on purpose (ADR
   * 0019's Consequences): collapsing a retraction out of it would hide
   * exactly the exactly-once property this endpoint exists to prove.
   */
  it("a retraction enqueued through the outbox then replayed leaves exactly two rows — a log and its retraction, never a third", async () => {
    await fetchWithRetry(`${baseUrl}/__test__/reset`, { method: "POST" });

    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const supervisor = yield* makeConnectedSupervisor;
          const session = yield* SubscriptionRef.get(supervisor.session).pipe(
            Effect.map(Option.getOrThrow),
          );
          const { loggedSessionId } = yield* session.client["session.start"]({
            prescribedSessionId: SessionId.make("session-seed-1"),
          });
          const manager = yield* Outbox.makeOutboxManager(Outbox.makeInMemoryOutboxStorage());
          yield* Effect.forkScoped(Outbox.runFlusher(supervisor, manager));

          // Log the Set for real first, through the outbox — a retraction
          // with nothing behind it is not the case this test is about.
          yield* manager.enqueue(testItem("cmd-unlog-source", loggedSessionId));
          yield* SubscriptionRef.changes(manager.queued).pipe(
            Stream.filter((items) => items.length === 0),
            Stream.runHead,
          );

          // Then the retraction, also through the outbox — this is the un-log
          // tap itself, not a direct RPC.
          yield* manager.enqueue(unlogItem("cmd-unlog-replay", loggedSessionId));
          yield* SubscriptionRef.changes(manager.queued).pipe(
            Stream.filter((items) => items.length === 0),
            Stream.runHead,
          );

          // Simulate the outbox replaying the same commandId a second time
          // (e.g. the ack was lost in transit even though the write landed)
          // — a genuine second flush, not merely a re-render.
          yield* session.client["logging.unlogSetActual"](unlogItem("cmd-unlog-replay", loggedSessionId));

          const logged = yield* session.client["logging.getLoggedSession"]({ loggedSessionId });
          return { netActuals: logged.actuals };
        }),
      ).pipe(Effect.provide(dependencies)),
    );

    // `getLoggedSession.actuals` is the raw ordered stream, log AND
    // retraction both present — folding it to net state is the CLIENT's job
    // (`foldServerActuals`, `useLoggedSession.ts`), exactly as ADR 0019
    // describes. What this endpoint owes is ORDER: the retraction must be
    // the LAST row for `set-1`, which is what makes the client's "last row
    // wins" fold land on unlogged.
    const forSet1 = result.netActuals
      .filter((a) => a.setId === "set-1")
      .sort((a, b) => a.appliedAt.localeCompare(b.appliedAt));
    expect(forSet1).toHaveLength(2);
    expect(forSet1[0]?.retraction).toBe(false);
    expect(forSet1[1]?.retraction).toBe(true);

    // The DURABLE, literal history is two rows — never collapsed to zero,
    // and the replay above did not create a third.
    const actuals = await listActuals();
    const mine = actuals.filter((a) => a.commandId === "cmd-unlog-source" || a.commandId === "cmd-unlog-replay");
    expect(mine).toHaveLength(2);
    const source = mine.find((a) => a.commandId === "cmd-unlog-source");
    const retraction = mine.find((a) => a.commandId === "cmd-unlog-replay");
    expect(source?.retraction).toBe(false);
    expect(retraction?.retraction).toBe(true);
  });

  // --- #148: a refused swap must reach outbox.rejections, not vanish -------

  const listEntrySwaps = async (): Promise<ReadonlyArray<{ readonly entryId: string }>> => {
    const body = (await (await fetchWithRetry(`${baseUrl}/__test__/entry-swaps`)).json()) as {
      readonly swaps: ReadonlyArray<{ readonly entryId: string }>;
    };
    return body.swaps;
  };

  /**
   * The flusher half of #148's defect 2. `swapEntryExercise` shares
   * `applyPlanEdit`'s reject-not-remove shape: an `EntryAlreadyLoggedError` is
   * permanent, so the command comes off the queue through `manager.reject`, and
   * the rejection has to surface — pre-#148 the Logging surface had no
   * subscriber, so a refused swap was completely silent. This proves the
   * flusher -> `outbox.rejections` path over a real socket, and that the
   * rejection now carries the command itself (so more than one surface can
   * route on `kind`). The Logging surface's subscription is the same thin
   * `outbox.rejections` consumer the Plan editor already is.
   *
   * (The end-to-end two-client race that still produces this error post-#148
   * needs #147's server-reconciled Resume — a single client's view and the
   * server now agree — so it is not reachable from the e2e rung yet.)
   */
  it("a swap the server refuses because the Entry has a net-logged Set reaches outbox.rejections carrying the command, and records nothing (#148)", async () => {
    await fetchWithRetry(`${baseUrl}/__test__/reset`, { method: "POST" });

    const outcome = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const supervisor = yield* makeConnectedSupervisor;
          const session = yield* SubscriptionRef.get(supervisor.session).pipe(
            Effect.map(Option.getOrThrow),
          );
          const { loggedSessionId } = yield* session.client["session.start"]({
            prescribedSessionId: SessionId.make("session-seed-1"),
          });
          // entry-1 genuinely has a net-logged Set on THIS session — applied
          // directly so it is server state before the swap ever flushes.
          yield* session.client["logging.logSetActual"](
            testItem("cmd-swap-guard-log", loggedSessionId),
          );

          const manager = yield* Outbox.makeOutboxManager(Outbox.makeInMemoryOutboxStorage());
          yield* Effect.forkScoped(Outbox.runFlusher(supervisor, manager));

          yield* manager.enqueue({
            kind: "swapExercise" as const,
            commandId: CommandId.make("cmd-swap-refused"),
            loggedSessionId,
            entryId: EntryId.make("entry-1"),
            exerciseId: ExerciseId.make("exercise-leg-press"),
          });

          const rejections = yield* SubscriptionRef.changes(manager.rejections).pipe(
            Stream.filter((items) => items.length > 0),
            Stream.runHead,
            Effect.map(Option.getOrThrow),
          );
          const queued = yield* SubscriptionRef.get(manager.queued);
          return { rejections, queuedLength: queued.length };
        }),
      ).pipe(Effect.provide(dependencies)),
    );

    // Off the queue for good — a refused swap is never retried.
    expect(outcome.queuedLength).toBe(0);
    expect(outcome.rejections).toHaveLength(1);
    const rejection = outcome.rejections[0];
    expect(rejection?.commandId).toBe("cmd-swap-refused");
    expect(rejection?.command.kind).toBe("swapExercise");
    expect(rejection?.command.kind === "swapExercise" && rejection.command.entryId).toBe("entry-1");
    expect(rejection?.reason).toMatch(/logged Set/i);

    // The server recorded no swap.
    expect(await listEntrySwaps()).toHaveLength(0);
  });
});
