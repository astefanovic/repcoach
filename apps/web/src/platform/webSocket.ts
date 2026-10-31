import * as Layer from "effect/Layer";
import * as Socket from "effect/unstable/socket/Socket";

/**
 * DOM platform seam for `Socket.WebSocketConstructor` (#50, absorbing #51).
 *
 * #51 guessed this would be "likely a near no-op" and it was exactly that:
 * the Expo adapter already lifted the *global* `WebSocket`, which is the DOM
 * one when running on web. The only change is the cast falling away —
 * `globalThis.WebSocket` in a browser needs no reassurance about what it is.
 * The seam itself stays, because the Node client<->dev-server integration test
 * (`apps/server/src/clientIntegration.test.ts`) substitutes Node's global
 * `WebSocket` through it.
 */
export const domWebSocketConstructorLayer = Layer.succeed(
  Socket.WebSocketConstructor,
  (url: string | URL) => new WebSocket(url.toString()),
);
