import * as net from "node:net";

import WebSocket from "ws";

/**
 * Test-only readiness gate for the real-socket integration suites.
 *
 * Replaces the fixed `setTimeout(50)` each of those suites used after the Node
 * server's `listening` event. `listening` only proves the raw HTTP socket
 * bound; under ambient machine load (chiefly the always-on home server) the
 * accept loop can still be starved for hundreds of ms, so a client that
 * connects immediately gets the documented flake — `connect ETIMEDOUT` on
 * loopback (see the `test-flakiness-socket-suites` note).
 *
 * We probe with a real **TCP connection** (not an HTTP request): the servers
 * mount only a `/rpc` WebSocket route and answer no plain HTTP path — a
 * `fetch('/')` never resolves, so an HTTP poll would hang past the deadline.
 * A completed TCP connect proves the accept loop is actually servicing
 * connections, which is the exact condition that flakes; each attempt is
 * bounded so the outer deadline is always honoured. A brief settle after the
 * first success gives the RpcServer WebSocket-upgrade handler the beat it
 * needs to attach (the job the old fixed sleep did), now gated on real
 * accept-readiness instead of guessed.
 */
const PER_ATTEMPT_MS = 1_000;
const RETRY_DELAY_MS = 25;
const HANDLER_ATTACH_SETTLE_MS = 50;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Resolves once a TCP connection to host:port completes; rejects on connect error/timeout. */
const tcpConnectOnce = (host: string, port: number): Promise<void> =>
  new Promise<void>((resolve, reject) => {
    const socket = net.connect({ host, port });
    const settle = (fn: () => void): void => {
      socket.removeAllListeners();
      socket.destroy();
      fn();
    };
    socket.setTimeout(PER_ATTEMPT_MS);
    socket.once("connect", () => settle(resolve));
    socket.once("timeout", () => settle(() => reject(new Error("tcp connect timed out"))));
    socket.once("error", (error) => settle(() => reject(error)));
  });

export const waitForServerReady = async (baseUrl: string, timeoutMs = 20_000): Promise<void> => {
  const { hostname, port } = new URL(baseUrl);
  const portNumber = Number(port);
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      await tcpConnectOnce(hostname, portNumber);
      // Accept loop is live; let the WS-upgrade handler finish attaching.
      await sleep(HANDLER_ATTACH_SETTLE_MS);
      return;
    } catch (error) {
      lastError = error;
      await sleep(RETRY_DELAY_MS);
    }
  }
  throw new Error(`test server at ${baseUrl} not ready after ${timeoutMs}ms: ${String(lastError)}`);
};

/**
 * True for the transient loopback-connect failures a briefly accept-starved
 * server produces under load — NOT for application errors (a non-2xx response
 * still resolves `fetch`, so those never reach here). The client-runtime
 * suites survive these because the supervisor reconnects; the raw-socket
 * suites (`server`/`productionServer` control channel) have no such retry, so
 * they need this to be equally robust with the home server up.
 */
export const isTransientConnectError = (error: unknown): boolean => {
  const cause = (error as { readonly cause?: unknown })?.cause;
  const text = `${String(error)} ${String(cause ?? "")}`;
  return /ETIMEDOUT|ECONNREFUSED|ECONNRESET|EPIPE|socket hang up|fetch failed/i.test(text);
};

/** `fetch` that rides out a transiently accept-starved server (retries connect-level failures only). */
export const fetchWithRetry = async (
  input: string | URL,
  init?: RequestInit,
  timeoutMs = 20_000,
): Promise<Response> => {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      return await fetch(input, init);
    } catch (error) {
      if (!isTransientConnectError(error)) throw error;
      lastError = error;
      await sleep(RETRY_DELAY_MS);
    }
  }
  throw new Error(`fetch ${String(input)} kept failing to connect for ${timeoutMs}ms: ${String(lastError)}`);
};

/**
 * Opens a `ws` client, retrying the connect while the server's accept loop is
 * transiently starved under load (the raw-socket analogue of the client-runtime
 * supervisor's reconnect). Resolves to an already-open socket.
 */
export const openWebSocketWithRetry = async (url: string, timeoutMs = 20_000): Promise<WebSocket> => {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    const socket = new WebSocket(url);
    try {
      await new Promise<void>((resolve, reject) => {
        socket.once("open", () => resolve());
        socket.once("error", reject);
      });
      return socket;
    } catch (error) {
      socket.terminate();
      if (!isTransientConnectError(error)) throw error;
      lastError = error;
      await sleep(RETRY_DELAY_MS);
    }
  }
  throw new Error(`ws ${url} not connectable in ${timeoutMs}ms: ${String(lastError)}`);
};
