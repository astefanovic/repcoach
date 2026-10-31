import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import QRCode from "qrcode";

import {
  SERVER_WELL_KNOWN_PATH,
  type AuthSessionResult,
  type PairingLink,
  type ServerIdentity,
  type ServerStatus,
  type ServiceActionResult,
} from "@repcoach/contracts";

import { SESSION_COOKIE, describeUserAgent, sessionCookieHeader, type ServerAuth } from "./serverAuth.ts";
import type { ServiceManager } from "./serviceManager.ts";
import type { TailscaleExposure } from "./tailscaleExposure.ts";

/**
 * The production server's admin surface over plain HTTP: pairing, the status
 * Settings shows, and the background-service buttons. See
 * `packages/contracts/src/serverAdmin.ts` for the shapes.
 *
 * | Route | Who |
 * |---|---|
 * | `GET /.well-known/repcoach/server` | anyone — identity only, used by probes |
 * | `GET /api/auth/session`, `POST /api/auth/pair` | anyone — how a device gets paired |
 * | `GET /api/server/status`, `POST /api/server/…` | paired devices |
 * | `/rpc` | paired devices |
 * | everything else (the static app shell) | anyone — it holds no data |
 */

export interface ServerAdminContext {
  readonly auth: ServerAuth;
  readonly exposure: TailscaleExposure;
  readonly services: ServiceManager;
  readonly identity: () => ServerIdentity;
  readonly port: () => number;
  readonly dbPath: string;
  /** Exit so a supervisor (the installed service) can start the server again. */
  readonly requestExit: (reason: string) => void;
}

const isProtectedPath = (pathname: string): boolean => pathname === "/rpc" || pathname.startsWith("/api/server/");

const pathnameOf = (request: HttpServerRequest.HttpServerRequest): string =>
  new URL(request.url, "http://localhost").pathname;

const header = (request: HttpServerRequest.HttpServerRequest, name: string): string | undefined => {
  const value = request.headers[name];
  return typeof value === "string" && value !== "" ? value : undefined;
};

/** The host the browser thinks it is talking to. Tailscale Serve forwards it; direct requests carry it in `Host`. */
const browserHost = (request: HttpServerRequest.HttpServerRequest): string | undefined =>
  header(request, "x-forwarded-host") ?? header(request, "host");

const isHttps = (request: HttpServerRequest.HttpServerRequest): boolean => header(request, "x-forwarded-proto") === "https";

/**
 * A browser always sends `Origin` on WebSocket upgrades and POSTs. Refusing a
 * mismatched one stops another site the phone has open from riding the
 * session cookie into `/rpc` (cross-site WebSocket hijacking) or the admin
 * routes. `SameSite=Strict` covers most of this already; this covers the rest.
 */
const isCrossOrigin = (request: HttpServerRequest.HttpServerRequest): boolean => {
  const origin = header(request, "origin");
  if (origin === undefined) return false;
  try {
    return new URL(origin).host !== browserHost(request);
  } catch {
    return true;
  }
};

const json = (body: unknown, status = 200, headers?: Record<string, string>) =>
  HttpServerResponse.jsonUnsafe(body, { status, headers: { "cache-control": "no-store", ...headers } });

/**
 * Applied to the whole server via `HttpRouter.serve`'s `middleware`, so it
 * sees WebSocket upgrades as well as ordinary requests.
 */
export const makeAuthMiddleware =
  (auth: ServerAuth) =>
  <E, R>(app: Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>) =>
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const pathname = pathnameOf(request);
      if ((isProtectedPath(pathname) || request.method === "POST") && isCrossOrigin(request)) {
        return json({ error: "cross-origin" }, 403);
      }
      if (isProtectedPath(pathname) && auth.authenticate(request.cookies[SESSION_COOKIE]) === undefined) {
        return json({ error: "not-paired" }, 401);
      }
      return yield* app;
    });

const readJsonBody = (request: HttpServerRequest.HttpServerRequest) =>
  request.json.pipe(Effect.orElseSucceed(() => null as unknown));

export const makeServerAdminRoutesLayer = (ctx: ServerAdminContext) => {
  const currentDevice = (request: HttpServerRequest.HttpServerRequest) =>
    ctx.auth.authenticate(request.cookies[SESSION_COOKIE]);

  const wellKnown = HttpRouter.add("GET", SERVER_WELL_KNOWN_PATH, Effect.sync(() => json(ctx.identity())));

  const session = HttpRouter.add(
    "GET",
    "/api/auth/session",
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const token = request.cookies[SESSION_COOKIE];
      const device = ctx.auth.authenticate(token);
      if (device === undefined || token === undefined) {
        return json({ paired: false } satisfies AuthSessionResult, 401);
      }
      // Re-issued on use so an active device's cookie never reaches its 400-day cap.
      return json({ paired: true, deviceId: device.id, label: device.label } satisfies AuthSessionResult, 200, {
        "set-cookie": sessionCookieHeader(token, isHttps(request)),
      });
    }),
  );

  const pair = HttpRouter.add(
    "POST",
    "/api/auth/pair",
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const body = yield* readJsonBody(request);
      const code = typeof body === "object" && body !== null ? (body as { code?: unknown }).code : undefined;
      if (typeof code !== "string") return json({ paired: false, reason: "malformed" }, 400);
      const result = ctx.auth.redeemPairingCode(code, describeUserAgent(header(request, "user-agent")));
      if (!result.ok) return json({ paired: false, reason: result.reason }, result.reason === "spent" || result.reason === "expired" ? 410 : 400);
      // eslint-disable-next-line no-console
      console.log(`[repcoach-server] paired a new device: ${result.device.label}`);
      return json({ paired: true, deviceId: result.device.id, label: result.device.label } satisfies AuthSessionResult, 200, {
        "set-cookie": sessionCookieHeader(result.token, isHttps(request)),
      });
    }),
  );

  const status = HttpRouter.add(
    "GET",
    "/api/server/status",
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const service = yield* Effect.promise(() => ctx.services.status());
      const body: ServerStatus = {
        identity: ctx.identity(),
        pid: process.pid,
        port: ctx.port(),
        dbPath: ctx.dbPath,
        phoneAccess: ctx.exposure.state,
        service,
        devices: ctx.auth.listDevices(),
        currentDeviceId: currentDevice(request)?.id ?? null,
      };
      return json(body);
    }),
  );

  const recheck = HttpRouter.add(
    "POST",
    "/api/server/phone-access/check",
    Effect.gen(function* () {
      const state = yield* Effect.promise(() => ctx.exposure.check());
      return json(state);
    }),
  );

  const pairing = HttpRouter.add(
    "POST",
    "/api/server/pairing",
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const { code, expiresAt } = ctx.auth.mintPairingCode();
      // Prefer the tailnet URL — the link is for the phone — and fall back to
      // whatever origin this page itself was loaded from.
      const base = ctx.exposure.phoneUrl ?? `${isHttps(request) ? "https" : "http"}://${browserHost(request) ?? "127.0.0.1"}/`;
      const url = new URL(`/pair#code=${encodeURIComponent(code)}`, base).toString();
      const qrSvg = yield* Effect.promise(() =>
        QRCode.toString(url, { type: "svg", margin: 1, errorCorrectionLevel: "M" }),
      );
      return json({ url, expiresAt: new Date(expiresAt).toISOString(), qrSvg } satisfies PairingLink);
    }),
  );

  const revoke = HttpRouter.add(
    "POST",
    "/api/server/devices/:id/revoke",
    Effect.gen(function* () {
      const params = yield* HttpRouter.params;
      const id = params["id"];
      if (id === undefined || !ctx.auth.revoke(id)) return json({ ok: false }, 404);
      return json({ ok: true });
    }),
  );

  const serviceAction = (action: "install" | "uninstall") =>
    HttpRouter.add(
      "POST",
      `/api/server/service/${action}`,
      Effect.gen(function* () {
        const result: ServiceActionResult = yield* Effect.promise(() =>
          action === "install" ? ctx.services.install() : ctx.services.uninstall(),
        );
        if (result.ok && result.restarting) {
          // Answer first, then hand over: start the service, then exit to free
          // the port for it.
          setTimeout(() => {
            void ctx.services
              .startService()
              .finally(() => ctx.requestExit("handing over to the background service"));
          }, 300);
        }
        return json(result, result.ok ? 200 : 500);
      }),
    );

  const restart = HttpRouter.add(
    "POST",
    "/api/server/restart",
    Effect.gen(function* () {
      const service = yield* Effect.promise(() => ctx.services.status());
      if (!service.managed) {
        return json(
          { ok: false, restarting: false, message: "This server was started by hand — nothing would start it again." } satisfies ServiceActionResult,
          409,
        );
      }
      setTimeout(() => ctx.requestExit("restart requested from Settings"), 300);
      return json({ ok: true, restarting: true, message: "Restarting…" } satisfies ServiceActionResult);
    }),
  );

  return Layer.mergeAll(
    wellKnown,
    session,
    pair,
    status,
    recheck,
    pairing,
    revoke,
    serviceAction("install"),
    serviceAction("uninstall"),
    restart,
  );
};
