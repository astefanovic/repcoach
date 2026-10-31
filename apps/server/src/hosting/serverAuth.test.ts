import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ServerAuth, describeUserAgent, mintPairingCode, readOrCreateServerSecret } from "./serverAuth.ts";

const dirs: Array<string> = [];
const freshDir = (): string => {
  const dir = path.join(os.tmpdir(), `repcoach-auth-${randomUUID()}`);
  dirs.push(dir);
  return dir;
};

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("device pairing", () => {
  it("a code pairs exactly one device, and the cookie it returns authenticates that device", () => {
    const auth = ServerAuth.open(path.join(freshDir(), "repcoach.sqlite"));
    const { code } = auth.mintPairingCode();

    const first = auth.redeemPairingCode(code, "Chrome on Android");
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(auth.authenticate(first.token)?.id).toBe(first.device.id);

    expect(auth.redeemPairingCode(code, "Someone else")).toEqual({ ok: false, reason: "spent" });
  });

  it("refuses expired, tampered and malformed codes", () => {
    const auth = ServerAuth.open(path.join(freshDir(), "repcoach.sqlite"));
    const now = Date.now();
    const { code } = auth.mintPairingCode(now);

    expect(auth.redeemPairingCode(code, "x", now + 16 * 60_000)).toEqual({ ok: false, reason: "expired" });
    const [expiry, nonce] = code.split(".");
    expect(auth.redeemPairingCode(`${expiry}.${nonce}.AAAAAAAAAAAAAAAAAAAAAA`, "x")).toEqual({
      ok: false,
      reason: "bad-signature",
    });
    expect(auth.redeemPairingCode("not-a-code", "x")).toEqual({ ok: false, reason: "malformed" });
  });

  it("a code minted from the secret file alone (the `pair` CLI) is accepted by the server", () => {
    const dir = freshDir();
    const auth = ServerAuth.open(path.join(dir, "repcoach.sqlite"));
    const { code } = mintPairingCode(readOrCreateServerSecret(dir));
    expect(auth.redeemPairingCode(code, "phone").ok).toBe(true);
  });

  it("paired devices and spent codes survive a restart; revoking ends a session", () => {
    const dir = freshDir();
    const auth = ServerAuth.open(path.join(dir, "repcoach.sqlite"));
    const { code } = auth.mintPairingCode();
    const paired = auth.redeemPairingCode(code, "phone");
    if (!paired.ok) throw new Error("expected pairing to succeed");

    const restarted = ServerAuth.open(path.join(dir, "repcoach.sqlite"));
    expect(restarted.authenticate(paired.token)?.label).toBe("phone");
    expect(restarted.redeemPairingCode(code, "replay")).toEqual({ ok: false, reason: "spent" });

    expect(restarted.revoke(paired.device.id)).toBe(true);
    expect(restarted.authenticate(paired.token)).toBeUndefined();
    expect(ServerAuth.open(path.join(dir, "repcoach.sqlite")).authenticate(paired.token)).toBeUndefined();
  });

  it("keeps each database's devices apart — a commissioning server beside the real one", () => {
    const dir = freshDir();
    const real = ServerAuth.open(path.join(dir, "repcoach.sqlite"));
    const commissioning = ServerAuth.open(path.join(dir, "commissioning.sqlite"));
    const paired = real.redeemPairingCode(real.mintPairingCode().code, "phone");
    commissioning.redeemPairingCode(commissioning.mintPairingCode().code, "pane");
    if (!paired.ok) throw new Error("expected pairing to succeed");
    expect(ServerAuth.open(path.join(dir, "repcoach.sqlite")).authenticate(paired.token)?.label).toBe("phone");
    expect(ServerAuth.open(path.join(dir, "commissioning.sqlite")).listDevices().map((device) => device.label)).toEqual([
      "pane",
    ]);
  });

  it("stores only hashes of session tokens", () => {
    const dir = freshDir();
    const auth = ServerAuth.open(path.join(dir, "repcoach.sqlite"));
    const paired = auth.redeemPairingCode(auth.mintPairingCode().code, "phone");
    if (!paired.ok) throw new Error("expected pairing to succeed");
    expect(fs.readFileSync(path.join(dir, "repcoach.auth.json"), "utf8")).not.toContain(paired.token);
  });

  it("labels devices from their user agent", () => {
    expect(
      describeUserAgent(
        "Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36",
      ),
    ).toBe("Chrome on Android");
    expect(describeUserAgent(undefined)).toBe("Unknown device");
  });
});
