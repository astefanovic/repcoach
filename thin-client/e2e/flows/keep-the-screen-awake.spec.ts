import { expect, test, type Page } from "@playwright/test";

import { expectConnected, resetServer, setOffline } from "../driver.ts";

/**
 * Keep the screen awake while a workout is live.
 *
 * While a workout is live the app asks for a screen wake lock
 * (`navigator.wakeLock.request("screen")`), and asks again when the page
 * becomes visible after being hidden (the browser drops the lock on hide).
 * Reopening a past session as a backfill is not a live workout and asks for
 * nothing.
 *
 * Headless Chromium has no real wake lock, so the API is stubbed before any
 * app script runs and every request is recorded on `window`. The stub is the
 * only reach into the page here, and it stands in for the platform, not for
 * the app: the assertion is about what the app asks the browser for.
 */

declare global {
  interface Window {
    __wakeLockRequests: string[];
    __wakeLockSentinels: { released: boolean; release: () => Promise<void> }[];
  }
}

const stubWakeLock = async (page: Page) => {
  await page.addInitScript(() => {
    window.__wakeLockRequests = [];
    window.__wakeLockSentinels = [];
    const wakeLock = {
      request: (type: string) => {
        window.__wakeLockRequests.push(type);
        const target = new EventTarget();
        const sentinel = Object.assign(target, {
          type,
          released: false,
          onrelease: null as ((event: Event) => void) | null,
          release: async () => {
            if (sentinel.released) return;
            sentinel.released = true;
            const event = new Event("release");
            sentinel.onrelease?.(event);
            target.dispatchEvent(event);
          },
        });
        window.__wakeLockSentinels.push(sentinel);
        return Promise.resolve(sentinel);
      },
    };
    Object.defineProperty(navigator, "wakeLock", { configurable: true, get: () => wakeLock });
  });
};

const screenRequests = (page: Page) =>
  page.evaluate(() => window.__wakeLockRequests.filter((type) => type === "screen").length);

/** What the browser does when the tab is hidden and shown again. */
const hideThenShow = async (page: Page) => {
  await page.evaluate(async () => {
    const setVisibility = (state: "hidden" | "visible") => {
      Object.defineProperty(document, "visibilityState", { configurable: true, get: () => state });
      Object.defineProperty(document, "hidden", { configurable: true, get: () => state === "hidden" });
      document.dispatchEvent(new Event("visibilitychange"));
    };
    setVisibility("hidden");
    for (const sentinel of window.__wakeLockSentinels) await sentinel.release();
    setVisibility("visible");
  });
};

const backToToday = (page: Page) => page.getByRole("button", { name: "Back to Today" });

const startSession1 = async (page: Page) => {
  await page.goto("/");
  await expectConnected(page);
  await expect(page.getByRole("heading", { name: "Today", exact: true })).toBeVisible();
  await page.getByRole("button", { name: /^Session 1/ }).click();
  await expect(backToToday(page)).toBeVisible({ timeout: 20_000 });
};

test.describe("keep the screen awake during a live workout", () => {
  test.beforeEach(async ({ request }) => {
    await resetServer(request);
  });

  test.afterEach(async ({ request, context }) => {
    await setOffline(context, false);
    await resetServer(request);
  });

  test("Today asks for nothing; starting a workout requests a screen wake lock", async ({ page }) => {
    await stubWakeLock(page);
    await page.goto("/");
    await expectConnected(page);
    await expect(page.getByRole("heading", { name: "Today", exact: true })).toBeVisible();
    expect(await screenRequests(page)).toBe(0);

    await page.getByRole("button", { name: /^Session 1/ }).click();
    await expect(backToToday(page)).toBeVisible({ timeout: 20_000 });
    await expect.poll(() => screenRequests(page), { timeout: 10_000 }).toBeGreaterThanOrEqual(1);
  });

  test("the lock is re-acquired when the page becomes visible again", async ({ page }) => {
    await stubWakeLock(page);
    await startSession1(page);
    await expect.poll(() => screenRequests(page), { timeout: 10_000 }).toBeGreaterThanOrEqual(1);
    const before = await screenRequests(page);

    await hideThenShow(page);
    await expect.poll(() => screenRequests(page), { timeout: 10_000 }).toBeGreaterThan(before);
  });

  test("reopening a finished session as a backfill does not request one", async ({ page }) => {
    // Finish a workout with one set in it.
    await startSession1(page);
    await page.getByRole("button", { name: "Log as prescribed" }).first().click();
    await expect(page.getByText(/1 of 6 sets logged/i)).toBeVisible();
    await page.waitForTimeout(500);
    await expectConnected(page);
    const skip = page.getByRole("button", { name: /^skip$/i }).first();
    if (await skip.isVisible().catch(() => false)) await skip.click();
    await page.getByRole("button", { name: /^finish session$/i }).click();
    await expect(page.getByRole("heading", { name: "Today", exact: true })).toBeVisible({ timeout: 15_000 });

    // A fresh page with the stub, straight to History.
    await stubWakeLock(page);
    await page.goto("/history");
    await expectConnected(page);
    await page.getByRole("button", { name: /1 of 6 sets/ }).click();
    await expect(backToToday(page)).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText(/backfill/i)).toBeVisible();

    // Give a would-be request time to happen; also a hide/show must not ask.
    await page.waitForTimeout(1_500);
    await hideThenShow(page);
    await page.waitForTimeout(1_000);
    expect(await screenRequests(page)).toBe(0);
  });
});
