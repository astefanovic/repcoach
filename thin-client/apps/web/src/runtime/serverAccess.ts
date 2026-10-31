import { useCallback, useEffect, useState } from "react";

import type {
  AuthSessionResult,
  PairingLink,
  PairingRefusal,
  ServerStatus,
  ServiceActionResult,
} from "@repcoach/contracts";

import { resolveWebServerBaseUrls } from "./serverTarget.ts";

/**
 * The client half of the home server's admin surface (pairing, phone access,
 * the background service — `packages/contracts/src/serverAdmin.ts`).
 *
 * Plain `fetch` against the origin, not RPC: pairing has to work before this
 * device is allowed onto `/rpc`, and the session rides an httpOnly cookie the
 * page never sees.
 *
 * Only the production server has these routes, and only a same-origin
 * production build talks to it. The dev-server and the cross-origin e2e
 * harness have neither pairing nor a service to install, so everything here
 * switches itself off there rather than failing a CORS request into the
 * console of every test.
 */
export const serverAdminAvailable = (): boolean => {
  if (import.meta.env.DEV || typeof window === "undefined") return false;
  try {
    return new URL(resolveWebServerBaseUrls().httpBaseUrl).origin === window.location.origin;
  } catch {
    return false;
  }
};

export class ServerAdminError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

const request = async <A>(path: string, init?: RequestInit): Promise<A> => {
  const response = await fetch(path, { credentials: "same-origin", cache: "no-store", ...init });
  const body = (await response.json().catch(() => ({}))) as A & { readonly message?: string; readonly error?: string };
  if (!response.ok) {
    throw new ServerAdminError(response.status, body.message ?? body.error ?? `HTTP ${response.status}`);
  }
  return body;
};

const post = <A>(path: string, body?: unknown): Promise<A> =>
  request<A>(path, {
    method: "POST",
    headers: body === undefined ? {} : { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

export type PairingState = "not-required" | "unknown" | "paired" | "unpaired";

/** Asks whether this browser holds a paired session. Network failure is "unknown" — offline is not unpaired. */
export const checkPairing = async (): Promise<PairingState> => {
  if (!serverAdminAvailable()) return "not-required";
  try {
    const response = await fetch("/api/auth/session", { credentials: "same-origin", cache: "no-store" });
    if (response.status === 401) return "unpaired";
    if (response.ok) return ((await response.json()) as AuthSessionResult).paired ? "paired" : "unpaired";
    return "unknown";
  } catch {
    return "unknown";
  }
};

export type RedeemOutcome = { readonly ok: true } | { readonly ok: false; readonly reason: PairingRefusal | "offline" };

export const redeemPairingCode = async (code: string): Promise<RedeemOutcome> => {
  try {
    const response = await fetch("/api/auth/pair", {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code }),
    });
    if (response.ok) return { ok: true };
    const body = (await response.json().catch(() => ({}))) as { readonly reason?: PairingRefusal };
    return { ok: false, reason: body.reason ?? "malformed" };
  } catch {
    return { ok: false, reason: "offline" };
  }
};

export const serverAdmin = {
  status: () => request<ServerStatus>("/api/server/status"),
  recheckPhoneAccess: () => post<ServerStatus["phoneAccess"]>("/api/server/phone-access/check"),
  createPairingLink: () => post<PairingLink>("/api/server/pairing"),
  revokeDevice: (deviceId: string) => post<{ readonly ok: boolean }>(`/api/server/devices/${encodeURIComponent(deviceId)}/revoke`),
  installService: () => post<ServiceActionResult>("/api/server/service/install"),
  uninstallService: () => post<ServiceActionResult>("/api/server/service/uninstall"),
  restart: () => post<ServiceActionResult>("/api/server/restart"),
};

/**
 * Whether this device is paired, re-checked whenever the app comes back to the
 * foreground — which is when a revoked device would find out.
 */
export function usePairingState(): { readonly state: PairingState; readonly recheck: () => void } {
  const [state, setState] = useState<PairingState>(() => (serverAdminAvailable() ? "unknown" : "not-required"));

  const recheck = useCallback(() => {
    void checkPairing().then((next) => {
      // "unknown" (offline, server restarting) never overrides a real answer.
      if (next !== "unknown") setState(next);
    });
  }, []);

  useEffect(() => {
    if (!serverAdminAvailable()) return;
    recheck();
    const onVisible = () => {
      if (document.visibilityState === "visible") recheck();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [recheck]);

  return { state, recheck };
}
