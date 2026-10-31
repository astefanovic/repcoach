import { expect, test, type Page } from "@playwright/test";

import { expectConnected, resetServer, setOffline } from "../driver.ts";

/**
 * Settings → "Your data" → "Import from Strong or Hevy".
 *
 * - "Choose a CSV file" reads the file on the device. A file that is not an
 *   export is refused with an alert "Could not read that file — …".
 * - A real export shows a preview: "Strong export (name)" / "Hevy export
 *   (name)", "N workouts · M sets · <first> – <last>", skipped rows if any, and
 *   an "Exercises" list with one select per exercise name in the file —
 *   "Add as a new exercise", "Leave out", or one of the user's exercises.
 *   Names that match an existing exercise (case/punctuation-insensitive, and
 *   "Bench Press (Barbell)" → "Bench Press") are preselected.
 *   "X matches one of yours · Y new".
 * - "Import N workouts" → "Imported N workouts."; the same file again →
 *   "Imported 0 workouts · N already here, skipped."
 * - Imported workouts are finished sessions in History under their own
 *   names, with their sets, feed Progress, and never trigger a coach review.
 * - Pounds: a Hevy `weight_lbs` column is converted to kg.
 */

const STRONG_HEADER =
  "Date,Workout Name,Duration,Exercise Name,Set Order,Weight,Reps,Distance,Seconds,Notes,Workout Notes,RPE";

/** Two workouts, five sets, one Rest Timer row that is not a set. */
const STRONG_CSV = [
  STRONG_HEADER,
  "2024-01-15 07:30:00,Push Day,1h,Bench Press (Barbell),1,60,8,0,0,,,",
  "2024-01-15 07:30:00,Push Day,1h,Bench Press (Barbell),2,62.5,6,0,0,,,",
  "2024-01-15 07:30:00,Push Day,1h,Rest Timer,,,,,,,,",
  "2024-01-17 07:30:00,Leg Day,1h,Squat (Barbell),W,40,5,0,0,,,",
  "2024-01-17 07:30:00,Leg Day,1h,Squat (Barbell),1,100,5,0,0,,,",
  "2024-01-17 07:30:00,Leg Day,1h,Cable Fly Crossovers,1,20,12,0,0,,,",
].join("\n");

const HEVY_HEADER =
  '"title","start_time","end_time","description","exercise_title","superset_id","exercise_notes","set_index","set_type","weight_lbs","reps","distance_km","duration_seconds","rpe"';

/** One Hevy workout in pounds: 135 lb × 5 on the bench. */
const HEVY_LBS_CSV = [
  HEVY_HEADER,
  '"Upper A","3 Feb 2024, 18:05","3 Feb 2024, 19:00","","bench press","","","0","normal","135","5","","",""',
  '"Upper A","3 Feb 2024, 18:05","3 Feb 2024, 19:00","","bench press","","","1","normal","135","5","","",""',
].join("\n");

const importer = (page: Page) => page.getByRole("region", { name: "Import from Strong or Hevy" });

const chooseFile = async (page: Page, name: string, contents: string) => {
  await importer(page)
    .locator('input[type="file"]')
    .setInputFiles({ name, mimeType: "text/csv", buffer: Buffer.from(contents) });
};

const openSettings = async (page: Page) => {
  await page.goto("/settings");
  await expectConnected(page);
  await expect(importer(page)).toBeVisible();
};

const importStatus = (page: Page) => page.getByText(/^Imported \d+ workouts?/);

test.describe("import history from Strong or Hevy", () => {
  test.beforeEach(async ({ request }) => {
    await resetServer(request);
  });

  test.afterEach(async ({ request, context }) => {
    await setOffline(context, false);
    await resetServer(request);
  });

  test("the file picker accepts CSV, and a file that is not an export is refused", async ({ page }) => {
    await openSettings(page);
    await expect(importer(page).getByRole("button", { name: "Choose a CSV file" })).toBeVisible();
    await expect(importer(page).locator('input[type="file"]')).toHaveAttribute("accept", /\.csv/);

    await chooseFile(page, "groceries.csv", "item,qty\nmilk,2\neggs,12\n");
    await expect(page.getByRole("alert")).toContainText(/Could not read that file — /);
    await expect(importer(page).getByRole("button", { name: /^Import \d+ workouts?$/ })).toHaveCount(0);
  });

  test("a Strong export previews its workouts and preselects names that match yours", async ({ page }) => {
    await openSettings(page);
    await chooseFile(page, "strong.csv", STRONG_CSV);

    const preview = importer(page);
    await expect(preview.getByText("Strong export (strong.csv)")).toBeVisible();
    await expect(preview.getByText(/^2 workouts · 5 sets · Jan 15, 2024 – Jan 17, 2024$/)).toBeVisible();
    // The Rest Timer row is counted as left out.
    await expect(preview.getByText(/^1 row\b.*left out/)).toBeVisible();

    await expect(preview.getByRole("heading", { name: "Exercises" })).toBeVisible();
    const bench = preview.getByRole("combobox", { name: "Bench Press (Barbell)" });
    const squat = preview.getByRole("combobox", { name: "Squat (Barbell)" });
    const fly = preview.getByRole("combobox", { name: "Cable Fly Crossovers" });
    await expect(bench.locator("option:checked")).toHaveText("Bench Press");
    await expect(squat.locator("option:checked")).toHaveText("Add as a new exercise");
    await expect(fly.locator("option:checked")).toHaveText("Add as a new exercise");
    for (const option of ["Add as a new exercise", "Leave out", "Back Squat", "Bench Press", "Leg Press", "Plank"]) {
      await expect(fly.getByRole("option", { name: option, exact: true })).toHaveCount(1);
    }
    await expect(preview.getByText(/^1 match(es)? one of yours · 2 new$/)).toBeVisible();

    // Re-pointing a name updates the summary.
    await squat.selectOption({ label: "Back Squat" });
    await expect(preview.getByText(/^2 match(es)? one of yours · 1 new$/)).toBeVisible();

    await expect(preview.getByRole("button", { name: "Import 2 workouts" })).toBeVisible();
    await preview.getByRole("button", { name: "Cancel" }).click();
    await expect(preview.getByText("Strong export (strong.csv)")).toHaveCount(0);
    await expect(preview.getByRole("button", { name: "Choose a CSV file" })).toBeVisible();
  });

  test("importing lands finished workouts in History, and the same file again skips them", async ({ page }) => {
    await openSettings(page);
    await chooseFile(page, "strong.csv", STRONG_CSV);
    await importer(page).getByRole("combobox", { name: "Squat (Barbell)" }).selectOption({ label: "Back Squat" });
    await importer(page).getByRole("button", { name: "Import 2 workouts" }).click();
    await expect(importStatus(page)).toHaveText("Imported 2 workouts.", { timeout: 20_000 });

    // Again: nothing new.
    await chooseFile(page, "strong.csv", STRONG_CSV);
    await importer(page).getByRole("combobox", { name: "Squat (Barbell)" }).selectOption({ label: "Back Squat" });
    await importer(page).getByRole("button", { name: "Import 2 workouts" }).click();
    await expect(importStatus(page)).toHaveText("Imported 0 workouts · 2 already here, skipped.", {
      timeout: 20_000,
    });

    // History: both, under their own names, as finished sessions.
    await page.goto("/");
    await expectConnected(page);
    await page.getByRole("button", { name: /^History/ }).click();
    await expect(page.getByRole("heading", { name: "Past sessions", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: /Push Day/ })).toHaveCount(1);
    await expect(page.getByRole("button", { name: /Leg Day/ })).toHaveCount(1);
    await expect(page.getByText(/no finished sessions yet/i)).toHaveCount(0);

    // Push Day holds its two bench sets.
    await page.getByRole("button", { name: /Push Day/ }).click();
    await expect(page.getByRole("button", { name: "Back to Today" })).toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole("heading", { name: "Bench Press" })).toBeVisible();
    await expect(page.getByRole("button", { name: /^load — logged 60\b/ })).toHaveCount(1);
    await expect(page.getByRole("button", { name: /^load — logged 62\.5\b/ })).toHaveCount(1);
    await expect(page.getByRole("button", { name: /^reps — logged 8\b/ })).toHaveCount(1);
    await expect(page.getByRole("button", { name: /^reps — logged 6\b/ })).toHaveCount(1);
  });

  test("imported workouts feed Progress and do not start a coach review", async ({ page }) => {
    await page.goto("/coach");
    await expectConnected(page);
    const runs = page.getByRole("heading", { name: /^Deliberations \d+ runs?$/ });
    await expect(runs).toBeVisible();
    const before = (await runs.textContent()) ?? "";

    await openSettings(page);
    await chooseFile(page, "strong.csv", STRONG_CSV);
    await importer(page).getByRole("combobox", { name: "Squat (Barbell)" }).selectOption({ label: "Back Squat" });
    await importer(page).getByRole("button", { name: "Import 2 workouts" }).click();
    await expect(importStatus(page)).toHaveText("Imported 2 workouts.", { timeout: 20_000 });

    await page.goto("/progress");
    await expectConnected(page);
    const exercise = page.getByRole("combobox", { name: "Exercise" });
    await exercise.selectOption({ label: "Back Squat" });
    // The 40 kg warmup does not count; the 100 × 5 working set does.
    await expect(page.getByText(/Best estimated 1RM 116\.7 kg · 100 kg × 5 on Jan 17, 2024/)).toBeVisible();
    await exercise.selectOption({ label: "Bench Press" });
    // 62.5 × (1 + 6/30) = 75 vs 60 × (1 + 8/30) = 76 → the 60 × 8.
    await expect(page.getByText(/Best estimated 1RM 76 kg · 60 kg × 8 on Jan 15, 2024/)).toBeVisible();

    // No review ran: the Coach record has exactly the runs it had before.
    await page.waitForTimeout(2_000);
    await page.goto("/coach");
    await expectConnected(page);
    await expect(page.getByRole("heading", { name: /^Deliberations \d+ runs?$/ })).toHaveText(before);
  });

  test("a Hevy export in pounds is converted to kilograms", async ({ page }) => {
    await openSettings(page);
    await chooseFile(page, "hevy.csv", HEVY_LBS_CSV);

    const preview = importer(page);
    await expect(preview.getByText("Hevy export (hevy.csv)")).toBeVisible();
    await expect(preview.getByText(/^1 workouts? · 2 sets · Feb 3, 2024/)).toBeVisible();
    // Case-insensitive match onto the seeded Bench Press.
    await expect(preview.getByRole("combobox", { name: "bench press" }).locator("option:checked")).toHaveText(
      "Bench Press",
    );
    await preview.getByRole("button", { name: /^Import 1 workouts?$/ }).click();
    await expect(importStatus(page)).toHaveText(/^Imported 1 workouts?\.$/, { timeout: 20_000 });

    // 135 lb = 61.235 kg; e1RM 61.235 × (1 + 5/30) ≈ 71.4 kg.
    await page.goto("/progress");
    await expectConnected(page);
    await page.getByRole("combobox", { name: "Exercise" }).selectOption({ label: "Bench Press" });
    await expect(page.getByText(/Best estimated 1RM 71\.4 kg · 61\.2\d? kg × 5 on Feb 3, 2024/)).toBeVisible();
  });

  const importBareStrongWeightInPounds = async (page: Page) => {
    await openSettings(page);
    await page.getByRole("radio", { name: "Pounds (lb)" }).check();
    await chooseFile(
      page,
      "strong-lb.csv",
      [STRONG_HEADER, "2024-03-01 18:00:00,Bench,1h,Bench Press (Barbell),1,135,5,0,0,,,"].join("\n"),
    );
    await importer(page).getByRole("button", { name: /^Import 1 workouts?$/ }).click();
    await expect(importStatus(page)).toHaveText(/^Imported 1 workouts?\.$/, { timeout: 20_000 });
  };

  const benchOnProgress = async (page: Page) => {
    await page.goto("/progress");
    await expectConnected(page);
    await page.getByRole("combobox", { name: "Exercise" }).selectOption({ label: "Bench Press" });
  };

  test("a bare Strong Weight column is read in the display unit (pounds) and stored as kg", async ({ page }) => {
    await importBareStrongWeightInPounds(page);

    // 135 lb is 61.235 kg: in kg it reads as 61.2-something, not 135.
    await page.getByRole("radio", { name: "Kilograms (kg)" }).check();
    await benchOnProgress(page);
    await expect(page.getByText(/· 61\.2\d? kg × 5 on Mar 1, 2024/)).toBeVisible();
  });

  /** 135 lb imported is stored as kg and must read back as 135 lb, the same as a load typed in lb. */
  test("an imported pound load reads back as the same number of pounds", async ({ page }) => {
    await importBareStrongWeightInPounds(page);
    await benchOnProgress(page);
    await expect(page.getByText(/· 135 lb × 5 on Mar 1, 2024/)).toBeVisible();
  });
});
