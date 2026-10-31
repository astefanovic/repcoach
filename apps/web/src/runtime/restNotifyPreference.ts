import { useCallback, useEffect, useState } from "react";

/**
 * Whether the rest timer may notify off-tab (#116 part 2) — a per-device
 * toggle, deliberately `localStorage` rather than a server-persisted Setting.
 *
 * Every other Settings control (`useSettings.ts`) round-trips through the
 * home server, because model choice and RPE mode are facts about the coach
 * that should follow the user to a second device. This one is not: it names
 * whether THIS browser tab, on THIS device, may fire a Notification API call
 * — a capability a server round trip cannot grant or revoke anyway, and the
 * rest timer itself is explicitly scoped to "foreground page, no server
 * round-trip" (#116). A synced toggle would imply a promise this feature does
 * not keep.
 *
 * Defaults to on: the ticket asks for "on once permission has been granted",
 * and `decideRestCompletionNotify` already gates the Notification half on
 * live `Notification.permission`, so an on-by-default toggle changes nothing
 * until the user has actually granted it — there is no un-granted state this
 * default could surprise anyone from.
 */
const KEY = "repcoach.restTimerNotify";

function read(): boolean {
  try {
    return window.localStorage.getItem(KEY) !== "off";
  } catch (cause) {
    console.warn("[rest-notify] ignored unreadable preference", cause);
    return true;
  }
}

function write(enabled: boolean): void {
  try {
    window.localStorage.setItem(KEY, enabled ? "on" : "off");
  } catch (cause) {
    console.warn("[rest-notify] could not persist the preference", cause);
  }
}

export function useRestTimerNotifyPreference(): {
  readonly enabled: boolean;
  readonly setEnabled: (value: boolean) => void;
} {
  const [enabled, setState] = useState<boolean>(read);

  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (event.key === KEY || event.key === null) setState(read());
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  const setEnabled = useCallback((value: boolean) => {
    write(value);
    setState(value);
  }, []);

  return { enabled, setEnabled };
}
