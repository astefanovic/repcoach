import * as Effect from "effect/Effect";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { describe, expect, it } from "vitest";

import { CommandId, EntryId, LoggedSessionId, SessionId, SetId } from "@repcoach/contracts";

import { makeOutboxManager } from "./manager.ts";
import type { NewQueuedSetActual } from "./model.ts";
import { makeInMemoryOutboxStorage, type OutboxStorage } from "./storage.ts";

const item = (commandId: string): NewQueuedSetActual => ({
  kind: "logSetActual",
  commandId: CommandId.make(commandId),
  loggedSessionId: LoggedSessionId.make("logged-session-1"),
  sessionId: SessionId.make("session-seed-1"),
  entryId: EntryId.make("entry-1"),
  setId: SetId.make("set-1"),
  setType: "working",
  actual: { reps: 5, load: 100 },
});

describe("outbox manager", () => {
  it("persists to storage BEFORE reflecting in state", async () => {
    const calls: Array<string> = [];
    const backing = new Map<string, unknown>();
    const inner = makeInMemoryOutboxStorage(backing);
    const storage: OutboxStorage = {
      ...inner,
      write: (queuedItem) =>
        Effect.gen(function* () {
          calls.push("storage.write");
          yield* inner.write(queuedItem);
        }),
    };

    await Effect.runPromise(
      Effect.gen(function* () {
        const manager = yield* makeOutboxManager(storage);
        yield* manager.enqueue(item("cmd-1"));
        const queued = yield* SubscriptionRef.get(manager.queued);
        expect(queued.map((entry) => entry.commandId)).toEqual(["cmd-1"]);
      }),
    );
    expect(calls).toEqual(["storage.write"]);
    expect(backing.size).toBe(1);
  });

  it("does not reflect an item in state when the persist write fails", async () => {
    const failingStorage: OutboxStorage = {
      load: Effect.succeed([]),
      write: () => Effect.fail(new Error("disk full")),
      remove: () => Effect.void,
    };

    const outcome = await Effect.runPromiseExit(
      Effect.gen(function* () {
        const manager = yield* makeOutboxManager(failingStorage);
        yield* manager.enqueue(item("cmd-1"));
        return yield* SubscriptionRef.get(manager.queued);
      }),
    );

    expect(outcome._tag).toBe("Failure");
  });

  it("survives a simulated app kill: a fresh manager over the same storage reloads pending items", async () => {
    const backing = new Map<string, unknown>();

    await Effect.runPromise(
      Effect.gen(function* () {
        const manager = yield* makeOutboxManager(makeInMemoryOutboxStorage(backing));
        yield* manager.enqueue(item("cmd-1"));
        yield* manager.enqueue(item("cmd-2"));
      }),
    );

    // A brand-new manager instance, as if the app process had been killed
    // and relaunched, pointed at the same backing store.
    const reloaded = await Effect.runPromise(
      Effect.gen(function* () {
        const manager = yield* makeOutboxManager(makeInMemoryOutboxStorage(backing));
        yield* manager.load;
        return yield* SubscriptionRef.get(manager.queued);
      }),
    );

    expect(reloaded.map((entry) => entry.commandId).sort()).toEqual(["cmd-1", "cmd-2"]);
  });

  it("remove persists the removal before reflecting it in state", async () => {
    const backing = new Map<string, unknown>();

    const queuedAfterRemove = await Effect.runPromise(
      Effect.gen(function* () {
        const manager = yield* makeOutboxManager(makeInMemoryOutboxStorage(backing));
        yield* manager.enqueue(item("cmd-1"));
        yield* manager.remove(CommandId.make("cmd-1"));
        return yield* SubscriptionRef.get(manager.queued);
      }),
    );

    expect(queuedAfterRemove).toEqual([]);
    expect(backing.size).toBe(0);
  });

  /**
   * #80. Enqueue order has to survive a reload, and `createdAt` alone cannot
   * carry it: commands dispatched in the same tick — `addEntry` followed by
   * the `replaceEntrySets` that seeds its Sets — share a millisecond. Once
   * they do, a `createdAt` sort is a tie broken by storage iteration order,
   * which after a reload is `commandId` order.
   *
   * The ids here are deliberately chosen so that ordering by `commandId`
   * would produce the WRONG answer: "zzz" is enqueued first but sorts last.
   */
  it("preserves enqueue order across a reload even when ids sort against it", async () => {
    const backing = new Map<string, unknown>();

    await Effect.runPromise(
      Effect.gen(function* () {
        const manager = yield* makeOutboxManager(makeInMemoryOutboxStorage(backing));
        yield* manager.enqueue(item("zzz-enqueued-first"));
        yield* manager.enqueue(item("aaa-enqueued-second"));
      }),
    );

    const reloaded = await Effect.runPromise(
      Effect.gen(function* () {
        const manager = yield* makeOutboxManager(makeInMemoryOutboxStorage(backing));
        yield* manager.load;
        return yield* SubscriptionRef.get(manager.queued);
      }),
    );

    expect(reloaded.map((entry) => entry.commandId)).toEqual([
      "zzz-enqueued-first",
      "aaa-enqueued-second",
    ]);
  });

  it("keeps issuing increasing sequence numbers after a reload", async () => {
    const backing = new Map<string, unknown>();

    await Effect.runPromise(
      Effect.gen(function* () {
        const manager = yield* makeOutboxManager(makeInMemoryOutboxStorage(backing));
        yield* manager.enqueue(item("cmd-before-reload"));
      }),
    );

    const reloaded = await Effect.runPromise(
      Effect.gen(function* () {
        const manager = yield* makeOutboxManager(makeInMemoryOutboxStorage(backing));
        yield* manager.load;
        // Enqueued after the reload, so it must sort AFTER the item that was
        // already waiting — a counter that restarted at 1 would tie with it.
        yield* manager.enqueue(item("cmd-after-reload"));
        return yield* SubscriptionRef.get(manager.queued);
      }),
    );

    expect(reloaded.map((entry) => entry.commandId)).toEqual([
      "cmd-before-reload",
      "cmd-after-reload",
    ]);
    expect(reloaded[1]!.seq).toBeGreaterThan(reloaded[0]!.seq);
  });

  /**
   * #80. A command the server *refuses* must leave the queue by a different
   * door than one it accepts: whoever applied it optimistically is still
   * showing it, and only a rejection tells them to stop.
   */
  it("reject drops the command and reports why, until acknowledged", async () => {
    const backing = new Map<string, unknown>();

    const observed = await Effect.runPromise(
      Effect.gen(function* () {
        const manager = yield* makeOutboxManager(makeInMemoryOutboxStorage(backing));
        const doomed = yield* manager.enqueue(item("cmd-doomed"));
        yield* manager.reject(doomed, "session no longer exists");

        const afterReject = {
          queued: yield* SubscriptionRef.get(manager.queued),
          rejections: yield* SubscriptionRef.get(manager.rejections),
        };

        yield* manager.acknowledgeRejection(CommandId.make("cmd-doomed"));
        const afterAck = yield* SubscriptionRef.get(manager.rejections);

        return { afterReject, afterAck };
      }),
    );

    expect(observed.afterReject.queued).toEqual([]);
    expect(observed.afterReject.rejections).toEqual([
      {
        commandId: "cmd-doomed",
        reason: "session no longer exists",
        // The refused command travels with the rejection now (#148) so more
        // than one subscriber can route on `kind`.
        command: expect.objectContaining({ commandId: "cmd-doomed", kind: "logSetActual" }),
      },
    ]);
    // Gone from storage too — a refused command is not coming back.
    expect(backing.size).toBe(0);
    // Reported exactly once.
    expect(observed.afterAck).toEqual([]);
  });
});
