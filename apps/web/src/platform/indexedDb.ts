/**
 * The DOM platform seam's storage primitive (#50, absorbing #51): a minimal
 * promise-based key/value wrapper over IndexedDB, shared by the outbox
 * (`./outboxStorage.ts`) and the prescription cache
 * (`./prescriptionCacheStorage.ts`).
 *
 * IndexedDB rather than `localStorage` because the outbox is the app's only
 * durable write path — ADR 0009 gate 1 (offline capture with no duplicates
 * and no loss) rides entirely on it, and `localStorage` is synchronous,
 * string-only, and silently capped at a few megabytes. The prescription
 * cache is a lower-stakes display cache but shares the database so there is
 * one `onupgradeneeded` path to reason about rather than two storage
 * technologies.
 *
 * **The durability rule this module exists to enforce:** a write is durable
 * when the *transaction* completes, not when the *request* succeeds. Those
 * are different events — a transaction can still abort after every one of
 * its requests reported success (quota exceeded on flush, the tab being
 * killed mid-commit), and resolving on `request.onsuccess` would report a
 * write as persisted that IndexedDB then rolled back. Every mutation here
 * resolves on `transaction.oncomplete`, which is what makes the outbox
 * manager's persist-before-reflect discipline
 * (`packages/client-runtime/src/outbox/manager.ts`) actually mean something:
 * if the write did not survive, the in-memory queue never claims it did.
 */

const DB_NAME = "repcoach";
// v2 (#72) adds the Plan snapshot store — see `PLAN_STORE`. The upgrade is
// purely additive: `onupgradeneeded` creates whatever is missing, so a client
// carrying a v1 database keeps its queued sets and its cached prescription
// across the bump.
const DB_VERSION = 2;

export const OUTBOX_STORE = "outbox";
export const PRESCRIPTION_CACHE_STORE = "prescription-cache";
/**
 * The last Plan snapshot seen from `subscribePlan` (#72 user story 2:
 * opening the app in the gym's dead spot must still render the user's Plan).
 * Like the prescription cache this is a display cache, not a write path —
 * losing it costs a re-fetch — but unlike it, it is the *only* thing standing
 * between an offline launch and a blank Today.
 */
export const PLAN_STORE = "plan";

let dbPromise: Promise<IDBDatabase> | undefined;

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = () => {
      const db = request.result;
      // Both stores are out-of-line keyed: the caller supplies the key
      // (`commandId` for the outbox, a single literal slot for the cache),
      // so neither payload has to carry its own key path.
      if (!db.objectStoreNames.contains(OUTBOX_STORE)) {
        db.createObjectStore(OUTBOX_STORE);
      }
      if (!db.objectStoreNames.contains(PRESCRIPTION_CACHE_STORE)) {
        db.createObjectStore(PRESCRIPTION_CACHE_STORE);
      }
      if (!db.objectStoreNames.contains(PLAN_STORE)) {
        db.createObjectStore(PLAN_STORE);
      }
    };

    request.onsuccess = () => {
      const db = request.result;
      // A second tab opening a newer version blocks this connection's
      // upgrade forever unless the older one steps aside. Closing on
      // `versionchange` is the standard concession; the app reloads against
      // the new schema rather than limping on a stale connection.
      db.onversionchange = () => db.close();
      resolve(db);
    };

    request.onerror = () => reject(request.error ?? new Error("indexedDB.open failed"));
    request.onblocked = () =>
      reject(new Error("indexedDB.open blocked by an older connection in another tab"));
  });
}

/**
 * One connection per document, opened lazily. Memoized on the promise rather
 * than the database so concurrent first-callers share a single `open` rather
 * than racing two upgrades.
 */
function database(): Promise<IDBDatabase> {
  dbPromise ??= openDatabase().catch((cause: unknown) => {
    // Do not memoize a failure — a transient open error (a blocked upgrade
    // that later clears) should be retryable on the next call.
    dbPromise = undefined;
    throw cause;
  });
  return dbPromise;
}

/** Read one value. Resolves `undefined` when the key is absent. */
export async function kvGet(storeName: string, key: string): Promise<unknown> {
  const db = await database();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(storeName, "readonly");
    const request = transaction.objectStore(storeName).get(key);
    // A read has nothing to commit, so `request.onsuccess` is the honest
    // resolution point here — the durability rule applies to writes.
    request.onsuccess = () => resolve(request.result);
    transaction.onerror = () => reject(transaction.error ?? new Error(`kvGet(${storeName}) failed`));
    transaction.onabort = () => reject(transaction.error ?? new Error(`kvGet(${storeName}) aborted`));
  });
}

/**
 * Read every entry in a store, as `[key, value]` pairs. Stands in for the
 * `getAllKeys` + `multiGet` + key-prefix filter the AsyncStorage adapter
 * needed: an object store *is* the directory listing, so the outbox no
 * longer has to namespace its keys to avoid colliding with unrelated data.
 */
export async function kvEntries(storeName: string): Promise<ReadonlyArray<readonly [string, unknown]>> {
  const db = await database();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(storeName, "readonly");
    const store = transaction.objectStore(storeName);
    const keysRequest = store.getAllKeys();
    const valuesRequest = store.getAll();

    transaction.oncomplete = () => {
      const keys = keysRequest.result;
      const values = valuesRequest.result;
      const entries: Array<readonly [string, unknown]> = [];
      for (let index = 0; index < keys.length; index += 1) {
        // `getAllKeys` and `getAll` iterate the same store in the same key
        // order within one transaction, so index i pairs key i with value i.
        entries.push([String(keys[index]), values[index]] as const);
      }
      resolve(entries);
    };
    transaction.onerror = () =>
      reject(transaction.error ?? new Error(`kvEntries(${storeName}) failed`));
    transaction.onabort = () =>
      reject(transaction.error ?? new Error(`kvEntries(${storeName}) aborted`));
  });
}

/**
 * Write one value, resolving only once the transaction has **committed** —
 * see the durability rule in this module's doc comment. Values are stored as
 * structured clones of the schema-encoded object, so nothing has to be
 * `JSON.stringify`d and re-parsed on the way back out.
 */
export async function kvPut(storeName: string, key: string, value: unknown): Promise<void> {
  const db = await database();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(storeName, "readwrite");
    transaction.objectStore(storeName).put(value, key);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error(`kvPut(${storeName}) failed`));
    transaction.onabort = () => reject(transaction.error ?? new Error(`kvPut(${storeName}) aborted`));
  });
}

/** Delete one key, resolving only once the transaction has committed. */
export async function kvDelete(storeName: string, key: string): Promise<void> {
  const db = await database();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(storeName, "readwrite");
    transaction.objectStore(storeName).delete(key);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () =>
      reject(transaction.error ?? new Error(`kvDelete(${storeName}) failed`));
    transaction.onabort = () =>
      reject(transaction.error ?? new Error(`kvDelete(${storeName}) aborted`));
  });
}
