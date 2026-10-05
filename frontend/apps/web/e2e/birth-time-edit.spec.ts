/**
 * Settings → Profile: editing ONLY the birth time.
 *
 * Production bug (2026-10-05): the Rectified-time field is prefilled with the
 * entered time, so after an edit of the birth time alone the stale prefill
 * still "overrode" it. The chart id did not change, the regeneration no-oped,
 * and the page still said "Chart Updated!".
 *
 * This drives the real journey — onboarding through the UI (so the stored chart
 * id is the real `chartId`), Settings, Save, Confirm — and reads the result
 * back from the stored chart the Settings form loads. Every test ends with an
 * Export, because chats and readings must stay consistent after a regeneration.
 *
 *   bun run test:e2e:birth-time-edit                    # builds + previews
 *   BIRTH_TIME_E2E_BASE_URL=https://almamesh.com bun run test:e2e:birth-time-edit
 */
import { expect, test, type Page } from "@playwright/test";

const PASSPHRASE = "birth time edit e2e passphrase";
const CHART_UPDATED = "Chart Updated!";

async function typeSections(page: Page, testId: string, digits: string, trailing = ""): Promise<void> {
  await page.locator(`[data-testid="${testId}"] [role="spinbutton"]`).first().click();
  await page.keyboard.type(digits, { delay: 30 });
  if (trailing) await page.keyboard.type(trailing, { delay: 30 });
}

/** Real onboarding: Bengaluru, 08 Aug 1988, 06:44, exact time, no life events. */
async function onboard(page: Page): Promise<void> {
  await page.goto("/onboarding");
  await page.getByTestId("name-input").fill("Birth Time Edit");
  await page.getByTestId("next-button").click();
  await typeSections(page, "birth-date-input", "08081988");
  await page.getByTestId("next-button").click();
  await page.getByTestId("location-search-input").fill("Bengaluru");
  await page.locator('[role="option"]').first().click({ timeout: 120_000 });
  await page.getByTestId("next-button").click();
  await typeSections(page, "birth-time-input", "0644", "a");
  await page.getByTestId("confidence-option-exact").click();
  await page.getByTestId("next-button").click();
  await page.getByTestId("skip-life-events-button").click();
  await page.waitForURL("**/dashboard", { timeout: 300_000 });
  await page.getByTestId("chart-visualization").first().waitFor({ state: "attached", timeout: 300_000 });
}

/** Client-side navigation, so the booted engine survives (a user clicks links). */
async function spaNavigate(page: Page, path: string): Promise<void> {
  await page.evaluate((to) => {
    window.history.pushState({}, "", to);
    window.dispatchEvent(new PopStateEvent("popstate"));
  }, path);
}

function birthTimeInput(page: Page) {
  return page.locator('form input[type="time"]').first();
}

function rectifiedTimeInput(page: Page) {
  return page.locator("#rectified-time");
}

function saveButton(page: Page) {
  return page.getByRole("button", { name: "Save Changes" });
}

async function openProfileSettings(page: Page): Promise<void> {
  await spaNavigate(page, "/settings/profile");
  await expect(birthTimeInput(page)).toBeVisible({ timeout: 60_000 });
}

async function setTime(page: Page, field: ReturnType<typeof birthTimeInput>, hhmm: string): Promise<void> {
  await field.fill(hhmm);
  await field.blur();
}

/** Save → Confirm & Regenerate. The save stays disabled while the preview runs. */
async function saveAndConfirm(page: Page): Promise<void> {
  await expect(saveButton(page)).toBeEnabled({ timeout: 60_000 });
  await saveButton(page).click();
  const confirm = page.getByRole("button", { name: "Confirm & Regenerate" });
  await expect(confirm).toBeVisible();
  // A rising-sign change requires an explicit acknowledgement first.
  const ack = page.getByTestId("regen-flip-ack");
  if (await ack.isVisible()) await ack.check();
  await confirm.click();
}

/**
 * Re-open Settings (SPA, no reload) until the form — which reads the STORED
 * primary chart — shows the expected entered + rectified clocks. The
 * regeneration runs in the background after the success screen, so poll.
 */
async function expectStoredClocks(page: Page, entered: string, rectified: string, why: string): Promise<void> {
  await expect
    .poll(
      async () => {
        await spaNavigate(page, "/dashboard");
        await openProfileSettings(page);
        return `${await birthTimeInput(page).inputValue()}|${await rectifiedTimeInput(page).inputValue()}`;
      },
      { timeout: 90_000, intervals: [2_000], message: why },
    )
    .toBe(`${entered}|${rectified}`);
}

async function exportBackup(page: Page): Promise<void> {
  await spaNavigate(page, "/settings/data");
  await expect(page.getByTestId("backup-export-button")).toBeVisible({ timeout: 60_000 });
  await page.getByTestId("backup-passphrase-input").fill(PASSPHRASE);
  const [download] = await Promise.all([
    page.waitForEvent("download", { timeout: 120_000 }),
    page.getByTestId("backup-export-button").click(),
  ]);
  expect(download.suggestedFilename()).toMatch(/^almamesh-backup-.*\.almamesh$/);
  expect(await download.failure()).toBeNull();
}

function watchConsole(page: Page): string[] {
  const errors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  page.on("pageerror", (error) => errors.push(error.message));
  return errors;
}

test.beforeEach(async ({ context }) => {
  // Force the ordinary HTML download path so Playwright observes the Export.
  await context.addInitScript(() => {
    Reflect.deleteProperty(window, "showSaveFilePicker");
  });
});

test("no rectification: editing only the birth time recomputes the chart", async ({ page }) => {
  const consoleErrors = watchConsole(page);
  await onboard(page);
  await openProfileSettings(page);
  await expect(birthTimeInput(page)).toHaveValue("06:44");

  await setTime(page, birthTimeInput(page), "06:14");
  await saveAndConfirm(page);
  await expect(page.getByText(CHART_UPDATED)).toBeVisible();

  await expectStoredClocks(page, "06:14", "", "the stored chart must now be computed at 06:14");
  await exportBackup(page);
  expect(consoleErrors, "browser console errors").toEqual([]);
});

test("rectification in effect: editing only the birth time never claims an update", async ({ page }) => {
  const consoleErrors = watchConsole(page);
  await onboard(page);
  await openProfileSettings(page);

  // Rectify 06:44 → 06:59 (both Leo rising, so no sign-flip acknowledgement).
  await setTime(page, rectifiedTimeInput(page), "06:59");
  await saveAndConfirm(page);
  await expect(page.getByText(CHART_UPDATED)).toBeVisible();
  await expectStoredClocks(page, "06:44", "06:59", "the rectified chart must be stored");
  await exportBackup(page);
  await openProfileSettings(page);

  // Now edit ONLY the birth time. The rectified 06:59 still governs the chart.
  await setTime(page, birthTimeInput(page), "07:30");
  await expect(rectifiedTimeInput(page)).toHaveValue("06:59");
  await expect(saveButton(page)).toBeEnabled({ timeout: 60_000 });
  await saveButton(page).click();
  const notice = page.getByTestId("rectification-governs-notice");
  await expect(notice).toBeVisible();
  await expect(notice).toContainText("06:59");
  await expect(page.getByText(CHART_UPDATED)).toHaveCount(0);

  // Clearing the rectification lets the new birth time govern.
  await page.getByTestId("rectification-governs-clear").click();
  await expect(rectifiedTimeInput(page)).toHaveValue("");
  await saveAndConfirm(page);
  await expect(page.getByText(CHART_UPDATED)).toBeVisible();
  await expectStoredClocks(page, "07:30", "", "the chart must now be computed at the new birth time");

  await exportBackup(page);
  expect(consoleErrors, "browser console errors").toEqual([]);
});
