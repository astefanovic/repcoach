import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

/**
 * DOM platform seam for the connection credential/profile store (#50,
 * absorbing #51). The web client (ADR 0012) is now the only client, so this
 * is the only credential-store implementation — there is no native keychain
 * adapter to interoperate with.
 *
 * **On the "needs a decision" flag #51 raised.** The browser genuinely has no
 * OS-keychain equivalent — no hardware-backed slot — so on the face of it
 * this is an adapter without a mapping. Reading the pre-web-only history
 * dissolves the problem: this seam was *"Not yet wired into the supervisor
 * (the Task 2 dev-server is unauthenticated), but provided now as the
 * injectable seam future auth work will read/write through"*, and nothing
 * imports it. It has never held a secret, because there is no secret yet —
 * the home server is unauthenticated (ADR 0005 defers multi-user entirely).
 *
 * So this is `localStorage` behind the identical interface: honest about what
 * it is, and preserving the seam so the decision lands where it belongs —
 * with whoever builds real auth. When that happens, note that the answer
 * probably is not "find a secure `localStorage`" (there isn't one; anything
 * the page can read, script running on the page can read). It is more likely
 * an httpOnly cookie or a short-lived token the client never persists at all
 * — which would mean *deleting* this seam rather than reimplementing it.
 * Nothing here should be taken as a decision that a browser-side credential
 * store is the right shape.
 */
export class WebCredentialStore extends Context.Service<
  WebCredentialStore,
  {
    readonly get: (key: string) => Effect.Effect<Option.Option<string>>;
    readonly set: (key: string, value: string) => Effect.Effect<void>;
    readonly remove: (key: string) => Effect.Effect<void>;
  }
>()("@repcoach/web/platform/WebCredentialStore") {}

const STORAGE_PREFIX = "@repcoach/credentials/";

function keyFor(key: string): string {
  return `${STORAGE_PREFIX}${key}`;
}

/**
 * Storage access is wrapped rather than called directly: `localStorage`
 * throws on access in a partitioned or storage-blocked context (Safari
 * private browsing has historically thrown on `setItem` at quota), and an
 * unwired seam must not be the thing that takes down the app's boot. Reads
 * degrade to `None`, writes to a no-op — acceptable precisely because there
 * is nothing here to lose today, and a decision to revisit the moment there
 * is.
 */
export const localStorageCredentialStoreLayer = Layer.succeed(
  WebCredentialStore,
  WebCredentialStore.of({
    get: (key) =>
      Effect.sync(() => {
        try {
          return Option.fromNullishOr(localStorage.getItem(keyFor(key)));
        } catch (cause) {
          console.warn("[credentials] localStorage unavailable for read", key, cause);
          return Option.none();
        }
      }),
    set: (key, value) =>
      Effect.sync(() => {
        try {
          localStorage.setItem(keyFor(key), value);
        } catch (cause) {
          console.warn("[credentials] localStorage unavailable for write", key, cause);
        }
      }),
    remove: (key) =>
      Effect.sync(() => {
        try {
          localStorage.removeItem(keyFor(key));
        } catch (cause) {
          console.warn("[credentials] localStorage unavailable for remove", key, cause);
        }
      }),
  }),
);
