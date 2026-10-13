import { expect, test } from "@playwright/test";

import { setOffline } from "../driver.ts";

/**
 * The one trivial acceptance flow: the app renders, and the offline-toggle
 * primitive every later G1/G2 flow depends on can be exercised without
 * throwing.
 *
 * Repointed at `apps/web` by #50. Two assertions had to change, and both are
 * worth knowing about:
 *
 * - **The old `toContain("RepCoach")` on body text no longer holds**, even
 *   though the word is on screen. #42's sidebar renders it through a
 *   `uppercase` text-transform, and `innerText` reports *rendered* text, so the
 *   body reads `REPCOACH`. Worse, the sidebar only exists above the shell's
 *   `@3xl` container query — on a phone viewport there is no wordmark at all,
 *   so the assertion would pass or fail on viewport width. The document title
 *   is the stable anchor.
 * - **A visible heading is asserted instead of raw body text.** Landing is
 *   always Today (#42), and a heading is a role — exactly what the
 *   adversarial-author contract asks flows to assert on.
 */
test("the client renders and survives an offline toggle", async ({ page, context }) => {
  await page.goto("/");

  await expect(page).toHaveTitle(/RepCoach/);
  await expect(page.getByRole("heading", { name: "Today", exact: true })).toBeVisible();

  // Exercise the CDP offline-toggle primitive: go offline, then back online.
  // No assertion on app behaviour here — this proves the primitive itself runs
  // cleanly, ahead of the flows that assert real offline behaviour on top of it.
  await setOffline(context, true);
  await setOffline(context, false);

  // The app should still render after the toggle.
  await expect(page.getByRole("heading", { name: "Today", exact: true })).toBeVisible();
});
