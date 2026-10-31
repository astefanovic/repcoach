/**
 * The home server's own admin surface: pairing, phone access over Tailscale,
 * and the background service. Served as plain JSON under `/api/` rather than
 * through `RepCoachRpcGroup`, because it is about the server process, not the
 * training domain, and the pairing half has to answer before a device is
 * allowed onto `/rpc` at all.
 *
 * Plain types, not Schemas: both ends are this repo, the payloads are small,
 * and nothing here is persisted or replayed.
 */

export const SERVER_WELL_KNOWN_PATH = "/.well-known/repcoach/server";

/** `GET /.well-known/repcoach/server` — public; how a probe tells this server from anything else on a port. */
export interface ServerIdentity {
  readonly app: "repcoach";
  /** Random per process. Two answers with the same id are the same running server. */
  readonly instanceId: string;
  readonly buildRef: string;
  readonly startedAt: string;
  /** The `https://…ts.net/` URL, once Tailscale Serve fronts this server. */
  readonly phoneUrl: string | null;
}

/** `GET /api/auth/session`. */
export type AuthSessionResult =
  | { readonly paired: true; readonly deviceId: string; readonly label: string }
  | { readonly paired: false };

/** Why a pairing code was refused (`POST /api/auth/pair`). */
export type PairingRefusal = "malformed" | "bad-signature" | "expired" | "spent";

/**
 * How this server is (or is not) reachable from the phone. Every variant other
 * than `serving` names something the owner can do about it.
 */
export type PhoneAccessState =
  | { readonly kind: "checking" }
  | { readonly kind: "disabled" }
  | { readonly kind: "not-installed" }
  | { readonly kind: "not-running"; readonly detail: string }
  | { readonly kind: "logged-out" }
  | { readonly kind: "https-disabled"; readonly magicDnsName: string; readonly adminUrl: string }
  | { readonly kind: "taken"; readonly url: string; readonly detail: string }
  | { readonly kind: "failed"; readonly detail: string }
  | { readonly kind: "serving"; readonly url: string };

export type ServiceKind = "startup-folder" | "systemd-user" | "launchd";

export interface ServiceStatus {
  readonly platform: string;
  /** `null` when this platform has no supported service flavour. */
  readonly kind: ServiceKind | null;
  readonly installed: boolean;
  /** This very process was started by the installed service (and will be restarted if it exits). */
  readonly managed: boolean;
  readonly logPath: string | null;
  /** Older launchers found on this machine that would double-start the server. */
  readonly legacy: ReadonlyArray<string>;
  readonly detail: string | null;
}

export interface PairedDevice {
  readonly id: string;
  readonly label: string;
  readonly createdAt: string;
  readonly lastSeenAt: string;
}

/** `GET /api/server/status`. */
export interface ServerStatus {
  readonly identity: ServerIdentity;
  readonly pid: number;
  readonly port: number;
  readonly dbPath: string;
  readonly phoneAccess: PhoneAccessState;
  readonly service: ServiceStatus;
  readonly devices: ReadonlyArray<PairedDevice>;
  /** The device making this request. */
  readonly currentDeviceId: string | null;
}

/** `POST /api/server/pairing`. */
export interface PairingLink {
  readonly url: string;
  readonly expiresAt: string;
  /** The URL as a QR code, ready to inline. */
  readonly qrSvg: string;
}

/** `POST /api/server/service/install` and friends. */
export interface ServiceActionResult {
  readonly ok: boolean;
  readonly message: string;
  /** The server is about to exit so the service can take over; poll status until it answers again. */
  readonly restarting: boolean;
}
