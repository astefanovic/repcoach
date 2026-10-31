import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

import type { PairedDevice, PairingRefusal } from "@repcoach/contracts";

/**
 * Device pairing for the production server (the t3code model, cut down to one
 * user).
 *
 * Until this, Tailscale was the only access control: anything on the tailnet
 * could read every workout and start coaching runs, and those runs hold `Bash`.
 * Now a device has to be **paired** first. Pairing spends a one-time code; the
 * device gets back a long-lived, httpOnly session cookie, and every paired
 * device is listed in Settings where it can be revoked.
 *
 * **Codes are stateless.** A code is `<expiry>.<nonce>.<hmac>` signed with a
 * secret kept beside the database (`server-secret`). Anything that can read
 * that file can mint one — which is exactly the set of processes we want: the
 * server itself, and the `pair` CLI run as the same OS user on the same
 * machine, with no need to reach the running server. Spent nonces are recorded
 * so a code works once; they are kept only until the code would have expired.
 *
 * **Sessions are stored hashed** (`<db>.auth.json`, e.g. `repcoach.auth.json`),
 * so the file alone does not hand out a working cookie. The file is named after
 * the database rather than shared by the directory: a commissioning server on
 * `commissioning.sqlite` in the same directory must not overwrite the real
 * server's devices. The secret is shared — both are the same owner's.
 *
 * Deliberately absent, compared with t3code: scopes (one user, one level of
 * access), DPoP and bearer tokens (one client kind, a browser), and any
 * loopback exemption — Tailscale Serve proxies from 127.0.0.1 too, so "the
 * request came from loopback" says nothing about who is on the other end.
 */

export const SESSION_COOKIE = "repcoach_session";
export const PAIRING_CODE_TTL_MS = 15 * 60_000;
/** Chrome caps cookie lifetime at 400 days; the cookie is re-issued on use, so an active device never hits it. */
export const SESSION_COOKIE_MAX_AGE_SECONDS = 400 * 24 * 60 * 60;
/** `lastSeenAt` is a display hint; flushing it on every request would rewrite the file on every RPC. */
const LAST_SEEN_FLUSH_MS = 5 * 60_000;

const SECRET_FILE = "server-secret";

interface StoredSession {
  readonly id: string;
  readonly tokenHash: string;
  readonly label: string;
  readonly createdAt: string;
  lastSeenAt: string;
}

interface SpentCode {
  readonly nonce: string;
  readonly expiresAt: number;
}

interface AuthFile {
  readonly version: 1;
  readonly sessions: ReadonlyArray<StoredSession>;
  readonly spentCodes: ReadonlyArray<SpentCode>;
}

/** `<dir>/<db name without extension>.<suffix>` — per-database state kept beside the database. */
export const siblingFileFor = (dbPath: string, suffix: string): string =>
  path.join(path.dirname(dbPath), `${path.basename(dbPath, path.extname(dbPath))}.${suffix}`);

const b64url = (bytes: Buffer): string => bytes.toString("base64url");

const sha256 = (value: string): string => createHash("sha256").update(value).digest("hex");

/** Reads the secret beside the DB, creating it on first use. Shared by the server and the `pair` CLI. */
export const readOrCreateServerSecret = (dir: string): Buffer => {
  const file = path.join(dir, SECRET_FILE);
  try {
    const existing = fs.readFileSync(file, "utf8").trim();
    if (/^[0-9a-f]{64}$/.test(existing)) return Buffer.from(existing, "hex");
  } catch {
    // first boot
  }
  fs.mkdirSync(dir, { recursive: true });
  const secret = randomBytes(32);
  fs.writeFileSync(file, secret.toString("hex"), { mode: 0o600 });
  return secret;
};

const signature = (secret: Buffer, payload: string): string =>
  b64url(createHmac("sha256", secret).update(payload).digest().subarray(0, 16));

/** Mints a one-time pairing code. Pure apart from the clock and the nonce, so the CLI can call it without a server. */
export const mintPairingCode = (
  secret: Buffer,
  now: number = Date.now(),
  ttlMs: number = PAIRING_CODE_TTL_MS,
): { readonly code: string; readonly expiresAt: number } => {
  const expiresAt = now + ttlMs;
  const payload = `${expiresAt.toString(36)}.${b64url(randomBytes(12))}`;
  return { code: `${payload}.${signature(secret, payload)}`, expiresAt };
};

type CodeCheck =
  | { readonly ok: true; readonly nonce: string; readonly expiresAt: number }
  | { readonly ok: false; readonly reason: PairingRefusal };

const checkPairingCode = (secret: Buffer, code: string, now: number): CodeCheck => {
  const parts = code.trim().split(".");
  if (parts.length !== 3) return { ok: false, reason: "malformed" };
  const [expiry, nonce, sig] = parts as [string, string, string];
  const expiresAt = Number.parseInt(expiry, 36);
  if (!Number.isFinite(expiresAt) || nonce.length === 0) return { ok: false, reason: "malformed" };
  const expected = Buffer.from(signature(secret, `${expiry}.${nonce}`));
  const given = Buffer.from(sig);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) {
    return { ok: false, reason: "bad-signature" };
  }
  if (now > expiresAt) return { ok: false, reason: "expired" };
  return { ok: true, nonce, expiresAt };
};

/** A short human label from a User-Agent, for the paired-devices list. Not used for anything else. */
export const describeUserAgent = (userAgent: string | undefined): string => {
  if (userAgent === undefined || userAgent === "") return "Unknown device";
  const os = /Android/.test(userAgent)
    ? "Android"
    : /iPhone|iPad/.test(userAgent)
      ? "iOS"
      : /Windows/.test(userAgent)
        ? "Windows"
        : /Mac OS X/.test(userAgent)
          ? "macOS"
          : /Linux/.test(userAgent)
            ? "Linux"
            : "Unknown OS";
  const browser = /Edg\//.test(userAgent)
    ? "Edge"
    : /Firefox\//.test(userAgent)
      ? "Firefox"
      : /Chrome\//.test(userAgent)
        ? "Chrome"
        : /Safari\//.test(userAgent)
          ? "Safari"
          : "Browser";
  return `${browser} on ${os}`;
};

export type RedeemResult =
  | { readonly ok: true; readonly token: string; readonly device: PairedDevice }
  | { readonly ok: false; readonly reason: PairingRefusal };

export class ServerAuth {
  private sessions: Array<StoredSession>;
  private spentCodes: Array<SpentCode>;
  private lastFlush = 0;

  private constructor(
    private readonly authFile: string,
    private readonly secret: Buffer,
    file: AuthFile,
  ) {
    this.sessions = [...file.sessions];
    this.spentCodes = [...file.spentCodes];
  }

  /** Opens (creating if needed) the secret and session store beside the database at `dbPath`. */
  static open(dbPath: string): ServerAuth {
    const secret = readOrCreateServerSecret(path.dirname(dbPath));
    const authFile = siblingFileFor(dbPath, "auth.json");
    let file: AuthFile = { version: 1, sessions: [], spentCodes: [] };
    try {
      const parsed = JSON.parse(fs.readFileSync(authFile, "utf8")) as Partial<AuthFile>;
      if (parsed.version === 1 && Array.isArray(parsed.sessions) && Array.isArray(parsed.spentCodes)) {
        file = parsed as AuthFile;
      }
    } catch {
      // no devices paired yet
    }
    return new ServerAuth(authFile, secret, file);
  }

  mintPairingCode(now: number = Date.now()): { readonly code: string; readonly expiresAt: number } {
    return mintPairingCode(this.secret, now);
  }

  redeemPairingCode(code: string, label: string, now: number = Date.now()): RedeemResult {
    const check = checkPairingCode(this.secret, code, now);
    if (!check.ok) return check;
    this.spentCodes = this.spentCodes.filter((spent) => spent.expiresAt >= now);
    if (this.spentCodes.some((spent) => spent.nonce === check.nonce)) return { ok: false, reason: "spent" };
    this.spentCodes.push({ nonce: check.nonce, expiresAt: check.expiresAt });

    const token = b64url(randomBytes(32));
    const at = new Date(now).toISOString();
    const session: StoredSession = { id: randomUUID(), tokenHash: sha256(token), label, createdAt: at, lastSeenAt: at };
    this.sessions.push(session);
    this.flush(now);
    return { ok: true, token, device: toDevice(session) };
  }

  /** The device a session cookie belongs to, or `undefined`. */
  authenticate(token: string | undefined, now: number = Date.now()): PairedDevice | undefined {
    if (token === undefined || token === "") return undefined;
    const hash = sha256(token);
    const session = this.sessions.find((candidate) => candidate.tokenHash === hash);
    if (session === undefined) return undefined;
    session.lastSeenAt = new Date(now).toISOString();
    if (now - this.lastFlush > LAST_SEEN_FLUSH_MS) this.flush(now);
    return toDevice(session);
  }

  listDevices(): ReadonlyArray<PairedDevice> {
    return this.sessions.map(toDevice);
  }

  revoke(deviceId: string): boolean {
    const before = this.sessions.length;
    this.sessions = this.sessions.filter((session) => session.id !== deviceId);
    if (this.sessions.length === before) return false;
    this.flush(Date.now());
    return true;
  }

  private flush(now: number): void {
    this.lastFlush = now;
    const file: AuthFile = { version: 1, sessions: this.sessions, spentCodes: this.spentCodes };
    const target = this.authFile;
    const temp = `${target}.${process.pid}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(file, null, 2), { mode: 0o600 });
    fs.renameSync(temp, target);
  }
}

const toDevice = (session: StoredSession): PairedDevice => ({
  id: session.id,
  label: session.label,
  createdAt: session.createdAt,
  lastSeenAt: session.lastSeenAt,
});

/** The `Set-Cookie` value for a session. `secure` when the browser reached us over https (Tailscale Serve). */
export const sessionCookieHeader = (token: string, secure: boolean): string =>
  [
    `${SESSION_COOKIE}=${token}`,
    "Path=/",
    `Max-Age=${SESSION_COOKIE_MAX_AGE_SECONDS}`,
    "HttpOnly",
    "SameSite=Strict",
    ...(secure ? ["Secure"] : []),
  ].join("; ");
