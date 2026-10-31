import { useCallback, useEffect, useRef, useState } from "react";

const FLASH_MS = 3_000;

/**
 * The ~3s green flash #42 allows on a run landing, as a timer the run-watching
 * hooks share. `statusStrip.ts` is pure and has no clock, so the flash window
 * has to live on the caller — and both run kinds (Revision, #66 slice 3;
 * Deliberation, #78) want the identical window, so they want one implementation
 * rather than two copies that can drift to different durations.
 *
 * Returns the flag and a `land()` to call at the moment a run completes.
 * Restarting is deliberate: a second run landing inside the window re-arms the
 * flash rather than being swallowed by the first one's timer.
 */
export function useLandingFlash(): {
  readonly justLanded: boolean;
  readonly land: () => void;
} {
  const [justLanded, setJustLanded] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const land = useCallback(() => {
    setJustLanded(true);
    if (timer.current !== undefined) clearTimeout(timer.current);
    timer.current = setTimeout(() => setJustLanded(false), FLASH_MS);
  }, []);

  useEffect(
    () => () => {
      if (timer.current !== undefined) clearTimeout(timer.current);
    },
    [],
  );

  return { justLanded, land };
}
