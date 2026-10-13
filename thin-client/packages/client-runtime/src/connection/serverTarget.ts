/**
 * Server-target resolution (Step 2A / task 2A.6, revised to match t3code):
 * when the production server serves the built web client itself (its static
 * catch-all — see `apps/dev-server`'s production server), the client derives
 * its server URL from the origin that served it, exactly like t3code's
 * primary environment target (`apps/web/src/environments/primary/target.ts`:
 * `baseUrl: window.location.origin`). Open the server URL in a browser and
 * the app is already pointed at the right server — no build-time URL baking,
 * no Metro, no QR.
 *
 * Precedence:
 *  1. Explicit `EXPO_PUBLIC_*` env overrides — dev and the Playwright e2e
 *     harness (which serves the app from Expo web on :8081 against a
 *     dev-server on :4010, deliberately cross-origin) set these.
 *  2. Same-origin, only for a **production web build** (`!isDevBuild` and a
 *     real http(s) window origin) — the exported bundle served by the
 *     production server.
 *  3. The localhost dev-server defaults (native dev, Node tests).
 */

export const DEFAULT_DEV_HTTP_BASE_URL = "http://127.0.0.1:4010";
export const DEFAULT_DEV_WS_BASE_URL = "ws://127.0.0.1:4010";

export interface ResolveServerBaseUrlsInput {
  /** `EXPO_PUBLIC_DEV_SERVER_HTTP_URL`, if set at build time. */
  readonly envHttpBaseUrl: string | undefined;
  /** `EXPO_PUBLIC_DEV_SERVER_WS_URL`, if set at build time. */
  readonly envWsBaseUrl: string | undefined;
  /** `window.location.origin` on web; undefined on native/Node. */
  readonly windowOrigin: string | undefined;
  /** React Native's `__DEV__`: false only in an exported production bundle. */
  readonly isDevBuild: boolean;
}

export interface ServerBaseUrls {
  readonly httpBaseUrl: string;
  readonly wsBaseUrl: string;
}

export function resolveServerBaseUrls(input: ResolveServerBaseUrlsInput): ServerBaseUrls {
  if (input.envHttpBaseUrl !== undefined || input.envWsBaseUrl !== undefined) {
    return {
      httpBaseUrl: input.envHttpBaseUrl ?? DEFAULT_DEV_HTTP_BASE_URL,
      wsBaseUrl: input.envWsBaseUrl ?? DEFAULT_DEV_WS_BASE_URL,
    };
  }

  if (
    !input.isDevBuild &&
    input.windowOrigin !== undefined &&
    /^https?:\/\//.test(input.windowOrigin)
  ) {
    return {
      httpBaseUrl: input.windowOrigin,
      // http -> ws, https -> wss; the client-runtime appends /rpc itself.
      wsBaseUrl: input.windowOrigin.replace(/^http/, "ws"),
    };
  }

  return { httpBaseUrl: DEFAULT_DEV_HTTP_BASE_URL, wsBaseUrl: DEFAULT_DEV_WS_BASE_URL };
}
