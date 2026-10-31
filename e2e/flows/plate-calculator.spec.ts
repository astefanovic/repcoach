import { expect, test, type Page } from "@playwright/test";

import { expectConnected, resetServer, setOffline } from "../driver.ts";

/**
 * The plate calculator — a live "Each side: …" readout under a barbell load
 * while it is being edited in the Logging grid.
 *
 * - Default kit: 20 kg bar, plates 25 / 20 / 15 / 10 / 5 / 2.5 / 1.25.
 *   140 kg → 60 per side → "Each side: 2 × 25 + 10"; 90 kg → "Each side: 25 + 10".
 * - A load equal to the bar → "Empty bar (20 kg)".
 * - A load the kit can't make exactly → the closest, with "· makes N" appended.
 * - Hidden for an exercise whose library equipment isn't a barbell / Smith
 *   machine (a dumbbell lift from the library), but shown for an exercise
 *   created by name with no library link.
 * - Settings → "Plates": the bar and the plates on hand are editable and the
 *   calculator follows them; "Reset to standard kg plates" restores the kit.
 *
 * (The ticket's own worked example — "2 × 25 + 10 for 90 kg" — does not add
 * up: 2 × 25 + 10 is 60 a side, i.e. 140 kg on a 20 kg bar. The arithmetic is
 * asserted, not the typo.)
 */

const loadCells = (page: Page) => page.getByRole("button", { name: /^load —/ });
const loadField = (page: Page) => page.getByRole("textbox", { name: "load value" });
const plateReadout = (page: Page) => page.getByRole("status").filter({ hasText: /Each side|Empty bar/ });

const startSession1 = async (page: Page) => {
  await page.goto("/");
  await expectConnected(page);
  await expect(page.getByRole("heading", { name: "Today", exact: true })).toBeVisible();
  await page.getByRole("button", { name: /^Session 1/ }).click();
  await expect(page.getByRole("button", { name: "Back to Today" })).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText(/0\s*\/\s*6/)).toBeVisible();
};

/** Open the Back Squat's first load editor (a barbell lift). */
const editSquatLoad = async (page: Page) => {
  await loadCells(page).first().click();
  await expect(loadField(page)).toBeVisible();
};

const picker = (page: Page) => page.getByRole("dialog", { name: "Exercise catalog" });

test.describe("plate calculator", () => {
  test.beforeEach(async ({ request }) => {
    await resetServer(request);
  });

  test.afterEach(async ({ request, context }) => {
    await setOffline(context, false);
    await resetServer(request);
  });

  test("shows the plates for each side live while a barbell load is edited", async ({ page }) => {
    await startSession1(page);
    await expect(plateReadout(page)).toHaveCount(0);

    await editSquatLoad(page);
    // The prescribed 100 kg: 40 a side.
    await expect(plateReadout(page)).toHaveText("Each side: 25 + 15");

    await loadField(page).fill("140");
    await expect(plateReadout(page)).toHaveText("Each side: 2 × 25 + 10");

    await loadField(page).fill("90");
    await expect(plateReadout(page)).toHaveText("Each side: 25 + 10");

    await loadField(page).fill("20");
    await expect(plateReadout(page)).toHaveText("Empty bar (20 kg)");

    // 91 kg is 35.5 a side; the closest the kit makes is 90 kg.
    await loadField(page).fill("91");
    await expect(plateReadout(page)).toHaveText("Each side: 25 + 10 · makes 90 kg");

    // It belongs to the editor: closing the editor takes it away.
    await page.getByRole("button", { name: "Cancel" }).last().click();
    await expect(loadField(page)).toHaveCount(0);
    await expect(plateReadout(page)).toHaveCount(0);
  });

  test("is hidden for a dumbbell exercise from the library", async ({ page }) => {
    await startSession1(page);
    await page.getByRole("button", { name: "+ Add exercise" }).click();
    await expect(picker(page)).toBeVisible();
    await picker(page).getByRole("textbox", { name: "Search the catalog" }).fill("Dumbbell Bench Press");
    await picker(page)
      .getByRole("button", { name: /^Dumbbell Bench Press .*dumbbell$/ })
      .first()
      .click();
    const preview = page.getByRole("dialog", { name: "Dumbbell Bench Press", exact: true });
    await expect(preview).toBeVisible();
    await preview.getByRole("button", { name: "Add to workout" }).click();
    await expect(picker(page)).toHaveCount(0);
    await expect(page.getByRole("heading", { name: "Dumbbell Bench Press" })).toBeVisible();

    // The added exercise's sets are the last on the surface.
    await loadCells(page).last().click();
    await expect(loadField(page)).toBeVisible();
    await loadField(page).fill("30");
    await expect(plateReadout(page)).toHaveCount(0);
  });

  test("still shows for an exercise created by name, with no library link", async ({ page }) => {
    await startSession1(page);
    await page.getByRole("button", { name: "+ Add exercise" }).click();
    await expect(picker(page)).toBeVisible();
    await picker(page).getByRole("textbox", { name: "Search the catalog" }).fill("Zercher Squat");
    await picker(page)
      .getByRole("button", { name: /^Create\s*[“"]Zercher Squat[”"]/ })
      .click();
    await expect(picker(page)).toHaveCount(0);
    await expect(page.getByRole("heading", { name: "Zercher Squat" })).toBeVisible();

    await loadCells(page).last().click();
    await expect(loadField(page)).toBeVisible();
    await loadField(page).fill("60");
    await expect(plateReadout(page)).toHaveText("Each side: 20");
  });

  test("Settings' bar and plates drive the calculator, and Reset restores the standard kit", async ({ page }) => {
    await page.goto("/settings");
    await expectConnected(page);
    await expect(page.getByRole("heading", { name: "Plates" })).toBeVisible();

    const bar = page.getByLabel("Bar weight");
    const plates = page.getByLabel("Plates on hand");
    await expect(bar).toHaveValue("20");
    await expect(plates).toHaveValue(/25,\s*20,\s*15,\s*10,\s*5,\s*2\.5,\s*1\.25/);

    // A 15 kg bar and only 20s and 2.5s. Saved on blur.
    await bar.fill("15");
    await bar.blur();
    await plates.fill("20, 2.5");
    await plates.blur();

    await page.reload();
    await expectConnected(page);
    await expect(page.getByLabel("Bar weight")).toHaveValue("15");
    await expect(page.getByLabel("Plates on hand")).toHaveValue(/^20,\s*2\.5$/);

    await startSession1(page);
    await editSquatLoad(page);
    // 100 kg on a 15 kg bar is 42.5 a side.
    await expect(plateReadout(page)).toHaveText("Each side: 2 × 20 + 2.5");
    await loadField(page).fill("15");
    await expect(plateReadout(page)).toHaveText("Empty bar (15 kg)");
    await page.getByRole("button", { name: "Cancel" }).last().click();

    await page.goto("/settings");
    await expectConnected(page);
    await page.getByRole("button", { name: "Reset to standard kg plates" }).click();
    await expect(page.getByLabel("Bar weight")).toHaveValue("20");
    await expect(page.getByLabel("Plates on hand")).toHaveValue(/25,\s*20,\s*15,\s*10,\s*5,\s*2\.5,\s*1\.25/);
  });

  test("in pounds the kit is a 45 lb bar and lb plates", async ({ page }) => {
    await page.goto("/settings");
    await expectConnected(page);
    await page.getByRole("radio", { name: "Pounds (lb)" }).check();

    await expect(page.getByRole("button", { name: "Reset to standard lb plates" })).toBeVisible();
    await page.getByRole("button", { name: "Reset to standard lb plates" }).click();
    await expect(page.getByLabel("Bar weight")).toHaveValue("45");
    await expect(page.getByLabel("Plates on hand")).toHaveValue(/^45,\s*35,\s*25,\s*10,\s*5,\s*2\.5$/);

    await startSession1(page);
    await editSquatLoad(page);
    await loadField(page).fill("225");
    // 225 lb on a 45 lb bar: 90 a side.
    await expect(plateReadout(page)).toHaveText("Each side: 2 × 45");
    await loadField(page).fill("45");
    await expect(plateReadout(page)).toHaveText("Empty bar (45 lb)");
  });
});
