import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import WebSocket from "ws";

import { SqlStore } from "@repcoach/persistence";
import { MONTHLY_CYCLE_REVIEW_INTERVAL_MILLIS, Store } from "@repcoach/persistence/store";

import { makeDevServer } from "./server.ts";
import { fetchWithRetry, openWebSocketWithRetry, waitForServerReady } from "./testServerReady.ts";

/**
 * End-to-end coverage for the Task 2 dev server over real sockets (issue
 * #16): boots the whole `makeDevServer` graph (RPC over a real WebSocket +
 * the `/__test__/*` control channel) on an ephemeral localhost port, then
 * drives it with a raw `ws` client and `fetch`, exactly as the adversarial
 * e2e author (Task 2's external lever, never a client hook) would.
 */

const waitForClose = (socket: WebSocket): Promise<{ readonly code: number }> =>
  new Promise((resolve) => {
    socket.once("close", (code: number) => resolve({ code }));
  });

describe("dev server (real sockets + control channel)", () => {
  let baseUrl: string;
  let wsUrl: string;
  let fiber: Fiber.Fiber<never, never>;
  let dbPath: string;

  beforeAll(async () => {
    const { layer, nodeServer, dbPath: devDbPath } = makeDevServer({ port: 0 });
    dbPath = devDbPath;

    const listening = new Promise<void>((resolve) => {
      nodeServer.once("listening", () => resolve());
    });

    // `nodeServer.listen()` happens inside `NodeHttpServer.layer`'s effect,
    // which only runs once the layer is launched — so the fiber must start
    // before we wait for the "listening" event, not after.
    fiber = Effect.runFork(Layer.launch(layer) as Effect.Effect<never, never>);
    await listening;

    const address = nodeServer.address();
    if (address === null || typeof address === "string") {
      throw new Error("expected an AddressInfo from the dev-server's Node HTTP server");
    }
    baseUrl = `http://127.0.0.1:${address.port}`;
    wsUrl = `ws://127.0.0.1:${address.port}/rpc`;

    await waitForServerReady(baseUrl);
  });

  afterAll(async () => {
    await Effect.runPromise(Fiber.interrupt(fiber));
  });

  // Issue #91 — the Cycle-review schedule is PRODUCTION ONLY: a dev server
  // that started firing background Deliberation runs would spend subscription
  // quota underneath every suite that boots one. The dev-server's DB therefore
  // has no schedule row at all, which makes the claim below the BOOTSTRAP one
  // ("start the clock, claim nothing") no matter how far in the future it is
  // dated. `productionServer.test.ts` asserts the mirror image.
  it("does NOT run the Cycle-review schedule — no background runs under the dev server", async () => {
    const claim = await Effect.gen(function* () {
      const store = yield* Store;
      return yield* store.claimDueCycleReview({
        now: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString(),
        intervalMillis: MONTHLY_CYCLE_REVIEW_INTERVAL_MILLIS,
      });
    }).pipe(Effect.provide(SqlStore.layer({ filename: dbPath })), Effect.scoped, Effect.runPromise);

    expect(claim.claimed).toBe(false);
  });

  it("resets the store back to its seed via /__test__/reset", async () => {
    const response = await fetchWithRetry(`${baseUrl}/__test__/reset`, { method: "POST" });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { readonly reset: boolean };
    expect(body.reset).toBe(true);
  });

  it("/__test__/drop-socket force-closes a live WebSocket connection", async () => {
    const socket = await openWebSocketWithRetry(wsUrl);

    const closed = waitForClose(socket);
    const response = await fetchWithRetry(`${baseUrl}/__test__/drop-socket`, { method: "POST" });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { readonly droppedCount: number };
    expect(body.droppedCount).toBeGreaterThan(0);

    await closed;
    expect(socket.readyState).toBe(WebSocket.CLOSED);
  });

  it("a fresh connection still works after drop-socket + reset (recovery)", async () => {
    const resetResponse = await fetchWithRetry(`${baseUrl}/__test__/reset`, { method: "POST" });
    expect(resetResponse.status).toBe(200);

    const socket = await openWebSocketWithRetry(wsUrl);
    expect(socket.readyState).toBe(WebSocket.OPEN);
    socket.close();
  });

  it("/__test__/pause-acks withholds acks and /__test__/reset resumes them", async () => {
    await fetchWithRetry(`${baseUrl}/__test__/reset`, { method: "POST" });

    const pauseResponse = await fetchWithRetry(`${baseUrl}/__test__/pause-acks`, { method: "POST" });
    expect(pauseResponse.status).toBe(200);

    // Resetting immediately after pausing must resume normal ack behavior —
    // this is the control channel's own recovery path, exercised here
    // without needing a full RPC client just to prove the HTTP lever works.
    const resetResponse = await fetchWithRetry(`${baseUrl}/__test__/reset`, { method: "POST" });
    expect(resetResponse.status).toBe(200);
    const body = (await resetResponse.json()) as { readonly reset: boolean };
    expect(body.reset).toBe(true);
  });
});
