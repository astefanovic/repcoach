import { Connection } from "@repcoach/client-runtime";

/**
 * Where this client points its RPC connection (#50).
 *
 * The policy itself is `Connection.resolveServerBaseUrls` and is consumed
 * **unchanged** — it is pure and lives in `packages/client-runtime`. All this
 * module does is feed it the three facts only the app knows, translated from
 * Expo's build system to Vite's:
 *
 * | fact | Expo | Vite |
 * |---|---|---|
 * | env overrides | `process.env.EXPO_PUBLIC_DEV_SERVER_*` | `import.meta.env.VITE_DEV_SERVER_*` |
 * | is this a dev build | `__DEV__` | `import.meta.env.DEV` |
 * | serving origin | `window.location.origin` | unchanged |
 *
 * **The same-origin behaviour is the point** (#50: "the bundle must not bake
 * in a server URL"). In a production build with no env override, the server is
 * the origin that served the page — open the home server's URL and the client
 * is already pointed at the right server. Nothing here hardcodes a host, so
 * the same built artifact works over Tailscale, over LAN, and on localhost.
 *
 * The env overrides exist for the two cases that are deliberately
 * cross-origin: local dev (Vite on :5173, dev-server on :4010) and the
 * Playwright harness. Note the precedence trap in `resolveServerBaseUrls`:
 * setting *either* override takes the env branch for *both* URLs, with the
 * other falling back to its `127.0.0.1:4010` default rather than to the
 * origin. Set both or neither.
 *
 * One stale reference worth knowing about: `resolveServerBaseUrls`'s own
 * docstring still names `EXPO_PUBLIC_*` and `__DEV__`. Left alone
 * deliberately — #50 says `packages/` is consumed unchanged, and rewriting
 * that prose belongs with the rest of the doc sweep in #55.
 */
function envOverride(value: unknown): string | undefined {
  // `import.meta.env` is typed as an index signature of `any`, and an unset
  // Vite variable is `undefined` while an empty `.env` line is `""` — neither
  // of which should count as an override, since an empty string would be
  // taken as a real value and silently break the same-origin path.
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function resolveWebServerBaseUrls(): Connection.ServerBaseUrls {
  return Connection.resolveServerBaseUrls({
    envHttpBaseUrl: envOverride(import.meta.env["VITE_DEV_SERVER_HTTP_URL"]),
    envWsBaseUrl: envOverride(import.meta.env["VITE_DEV_SERVER_WS_URL"]),
    windowOrigin: typeof window === "undefined" ? undefined : window.location.origin,
    isDevBuild: import.meta.env.DEV,
  });
}
