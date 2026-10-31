import { describe, expect, it } from "vitest";

import {
  DEFAULT_DEV_HTTP_BASE_URL,
  DEFAULT_DEV_WS_BASE_URL,
  resolveServerBaseUrls,
} from "./serverTarget.ts";

describe("resolveServerBaseUrls (Step 2A / task 2A.6, t3code same-origin model)", () => {
  it("a production web build served by the server derives both URLs from the serving origin", () => {
    expect(
      resolveServerBaseUrls({
        envHttpBaseUrl: undefined,
        envWsBaseUrl: undefined,
        windowOrigin: "https://myhost.tail1234.ts.net",
        isDevBuild: false,
      }),
    ).toEqual({
      httpBaseUrl: "https://myhost.tail1234.ts.net",
      wsBaseUrl: "wss://myhost.tail1234.ts.net",
    });
  });

  it("plain http origin maps to ws (not wss)", () => {
    expect(
      resolveServerBaseUrls({
        envHttpBaseUrl: undefined,
        envWsBaseUrl: undefined,
        windowOrigin: "http://127.0.0.1:4020",
        isDevBuild: false,
      }),
    ).toEqual({ httpBaseUrl: "http://127.0.0.1:4020", wsBaseUrl: "ws://127.0.0.1:4020" });
  });

  it("explicit env overrides win over same-origin — the e2e harness is deliberately cross-origin", () => {
    expect(
      resolveServerBaseUrls({
        envHttpBaseUrl: "http://127.0.0.1:4010",
        envWsBaseUrl: "ws://127.0.0.1:4010",
        windowOrigin: "http://localhost:8081",
        isDevBuild: false,
      }),
    ).toEqual({ httpBaseUrl: "http://127.0.0.1:4010", wsBaseUrl: "ws://127.0.0.1:4010" });
  });

  it("a DEV web build without env overrides keeps the localhost dev-server default (expo start --web)", () => {
    expect(
      resolveServerBaseUrls({
        envHttpBaseUrl: undefined,
        envWsBaseUrl: undefined,
        windowOrigin: "http://localhost:8081",
        isDevBuild: true,
      }),
    ).toEqual({ httpBaseUrl: DEFAULT_DEV_HTTP_BASE_URL, wsBaseUrl: DEFAULT_DEV_WS_BASE_URL });
  });

  it("native (no window origin) falls back to the localhost defaults", () => {
    expect(
      resolveServerBaseUrls({
        envHttpBaseUrl: undefined,
        envWsBaseUrl: undefined,
        windowOrigin: undefined,
        isDevBuild: false,
      }),
    ).toEqual({ httpBaseUrl: DEFAULT_DEV_HTTP_BASE_URL, wsBaseUrl: DEFAULT_DEV_WS_BASE_URL });
  });

  it("a partial env override fills the missing half with the dev default", () => {
    expect(
      resolveServerBaseUrls({
        envHttpBaseUrl: undefined,
        envWsBaseUrl: "ws://127.0.0.1:5555",
        windowOrigin: "https://myhost.ts.net",
        isDevBuild: false,
      }),
    ).toEqual({ httpBaseUrl: DEFAULT_DEV_HTTP_BASE_URL, wsBaseUrl: "ws://127.0.0.1:5555" });
  });
});
