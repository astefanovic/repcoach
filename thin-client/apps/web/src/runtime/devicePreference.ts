import { useSyncExternalStore } from "react";

/**
 * A per-device display preference held in `localStorage`, readable from any
 * component and redrawn everywhere at once when it changes — the shared
 * plumbing under `weightUnit.ts` and `plateSetup.ts`.
 *
 * Module-level rather than per-component state, because one preference is
 * read by many surfaces at the same time: flipping kg to lb in Settings must
 * redraw the Plan sentence, the Logging rows and the proposal diff together.
 * Another tab on the same device changing it arrives as a `storage` event.
 *
 * Unreadable or unwritable storage (private mode, a full quota) degrades to
 * the fallback for this page load, never to a crash: these are conveniences.
 */
export interface DevicePreference<T> {
  readonly use: () => T;
  readonly set: (value: T) => void;
  readonly get: () => T;
}

export function devicePreference<T>(options: {
  readonly key: string;
  readonly fallback: T;
  /** `undefined` for a stored value this build does not understand — the fallback is used. */
  readonly parse: (stored: string) => T | undefined;
  readonly serialize: (value: T) => string;
}): DevicePreference<T> {
  const { key, fallback, parse, serialize } = options;

  const read = (): T => {
    try {
      const stored = window.localStorage.getItem(key);
      return stored === null ? fallback : (parse(stored) ?? fallback);
    } catch (cause) {
      console.warn(`[preference] ignored unreadable ${key}`, cause);
      return fallback;
    }
  };

  let current: { readonly value: T } | undefined;
  const listeners = new Set<() => void>();

  const get = (): T => {
    current ??= { value: read() };
    return current.value;
  };

  const subscribe = (listener: () => void): (() => void) => {
    listeners.add(listener);
    const onStorage = (event: StorageEvent) => {
      if (event.key !== key && event.key !== null) return;
      current = { value: read() };
      listener();
    };
    window.addEventListener("storage", onStorage);
    return () => {
      listeners.delete(listener);
      window.removeEventListener("storage", onStorage);
    };
  };

  const set = (value: T): void => {
    try {
      window.localStorage.setItem(key, serialize(value));
    } catch (cause) {
      console.warn(`[preference] could not persist ${key}`, cause);
    }
    current = { value };
    for (const listener of listeners) listener();
  };

  return {
    use: () => useSyncExternalStore(subscribe, get, () => fallback),
    set,
    get,
  };
}
