/**
 * A reload right after the app shows /dashboard must never lose the chart.
 *
 * Production bug (6a89c0e, 2026-10-05): onboarding navigated to /dashboard in
 * the same millisecond it asked the worker for the chart. A reload before the
 * worker replied killed the compute, nothing wrote the chart, the onboarding
 * draft was already gone, and the chart was lost for good. Rectify's Confirm
 * had the same shape. The pages now wait for the chart to be computed AND
 * written before they navigate, so the moment /dashboard appears is safe.
 *
 * Real UI, real engine, persistent profile in both browsers (OPFS survives the
 * reload). Production build required (module Workers).
 *
 *   bun run test:e2e:chart-durable-reload
 *   RELOAD_DELAYS=0,50,100,200 bun run test:e2e:chart-durable-reload
 *   CHART_RELOAD_E2E_BASE_URL=http://127.0.0.1:4212 bun run test:e2e:chart-durable-reload
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, expect, test as base, webkit, type Page } from "@playwright/test";

/**
 * Each test gets its own on-disk profile so the reload sees what was persisted.
 * WebKit still keeps OPFS in one shared per-app store
 * (~/Library/WebKit/org.webkit.Playwright/WebsiteData), so `freshOrigin` also
 * wipes the origin's storage before each test.
 */
const test = base.extend({
  context: async ({ browserName, contextOptions, baseURL, viewport, userAgent }, provide) => {
    const profile = await mkdtemp(join(tmpdir(), "almamesh-chart-reload-"));
    const launcher = browserName === "webkit" ? webkit : chromium;
    const persistent = await launcher.launchPersistentContext(profile, {
      ...contextOptions,
      baseURL,
      viewport,
      userAgent,
      headless: true,
    });
    try {
      await provide(persistent);
    } finally {
      await persistent.close();
      await rm(profile, { recursive: true, force: true });
    }
  },
  page: async ({ context }, provide) => {
    await provide(context.pages()[0] ?? (await context.newPage()));
  },
});

/** Clear this origin's OPFS, IndexedDB and localStorage from a page that does not boot the app. */
async function freshOrigin(page: Page): Promise<void> {
  await page.goto("/robots.txt");
  await page.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    const names: string[] = [];
    for await (const name of (root as unknown as { keys(): AsyncIterable<string> }).keys()) names.push(name);
    for (const name of names) await root.removeEntry(name, { recursive: true });
    for (const db of await indexedDB.databases()) if (db.name) indexedDB.deleteDatabase(db.name);
    localStorage.clear();
  });
}

const DELAYS = (process.env.RELOAD_DELAYS ?? "0").split(",").map((value) => Number(value.trim()));

async function typeSections(page: Page, testId: string, digits: string, trailing = ""): Promise<void> {
  await page.locator(`[data-testid="${testId}"] [role="spinbutton"]`).first().click();
  await page.keyboard.type(digits, { delay: 30 });
  if (trailing) await page.keyboard.type(trailing, { delay: 30 });
}

/** Real onboarding: Bengaluru, 08 Aug 1988, 06:44. Returns once Generate is clicked. */
async function onboard(page: Page, confidence: "exact" | "unknown"): Promise<void> {
  await freshOrigin(page);
  await page.goto("/onboarding");
  await page.getByTestId("name-input").fill("Reload Native");
  await page.getByTestId("next-button").click();
  await typeSections(page, "birth-date-input", "08081988");
  await page.getByTestId("next-button").click();
  await page.getByTestId("location-search-input").fill("Bengaluru");
  await page.locator('[role="option"]').first().click({ timeout: 120_000 });
  await page.getByTestId("next-button").click();
  await typeSections(page, "birth-time-input", "0644", "a");
  await page.getByTestId(`confidence-option-${confidence}`).click();
  await page.getByTestId("next-button").click();
  await page.getByTestId("skip-life-events-button").click();
}

async function reloadAfter(page: Page, delayMs: number): Promise<void> {
  if (delayMs > 0) await page.waitForTimeout(delayMs);
  await reload(page);
}

/**
 * Reload like a user. WebKit sometimes reports "Frame load interrupted" when
 * another navigation lands on top of ours (seen once in 16 runs, rectify at
 * 200 ms). The page still reloads; the chart assertion that follows is the
 * verdict, so only that one error is tolerated.
 */
async function reload(page: Page): Promise<void> {
  try {
    await page.reload({ waitUntil: "commit" });
  } catch (error) {
    if (!String(error).includes("Frame load interrupted")) throw error;
  }
}

async function expectChart(page: Page, why: string): Promise<void> {
  await expect(page.getByTestId("chart-visualization").first(), why).toBeAttached({ timeout: 120_000 });
}

function watchConsole(page: Page): string[] {
  const errors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  page.on("pageerror", (error) => errors.push(error.message));
  return errors;
}

/** Rectify: one manual event, run the fit, take the top candidate, confirm. */
async function rectifyAndConfirm(page: Page): Promise<void> {
  await expect(page).toHaveURL(/\/rectify\//, { timeout: 300_000 });
  await page.getByTestId("intro-start-btn").click();
  await page.getByRole("button", { name: /enter events manually instead/i }).click();
  await page.getByRole("button", { name: /add event/i }).click();
  const row = page.getByTestId("event-row").last();
  await row.locator('input[type="date"]').fill("2010-06-15");
  await row.locator('select[aria-label="Category"]').selectOption({ value: "career_change" });
  await page.getByRole("button", { name: /find my rising sign/i }).click();
  const start = page.getByTestId("window-start-btn");
  if (await start.isVisible({ timeout: 3_000 }).catch(() => false)) await start.click();
  await expect(page.getByTestId("band-label")).toBeVisible({ timeout: 180_000 });
  await page.getByRole("button", { name: "Use this time" }).first().click();
  const ack = page.getByTestId("regen-flip-ack");
  if (await ack.isVisible({ timeout: 2_000 }).catch(() => false)) await ack.check();
  await page.getByRole("button", { name: "Confirm & Regenerate" }).click();
}

async function rectifiedTimeAfterReload(page: Page): Promise<string> {
  await page.goto("/settings/profile");
  const field = page.locator("#rectified-time");
  await expect(field).toBeVisible({ timeout: 120_000 });
  await expect(field).not.toHaveValue("", { timeout: 60_000 });
  return field.inputValue();
}

for (const delay of DELAYS) {
  test(`onboarding: a reload ${delay} ms after /dashboard keeps the chart`, async ({ page }) => {
    const consoleErrors = watchConsole(page);
    await onboard(page, "exact");
    await page.waitForURL("**/dashboard", { timeout: 300_000 });
    await reloadAfter(page, delay);
    await expectChart(page, "the chart must survive a reload at the moment /dashboard appears");
    await reload(page);
    await expectChart(page, "the chart must still be there after a second reload");
    expect(consoleErrors, "browser console errors").toEqual([]);
  });

  test(`rectify: a reload ${delay} ms after /dashboard keeps the rectified chart`, async ({ page }) => {
    const consoleErrors = watchConsole(page);
    await onboard(page, "unknown");
    await rectifyAndConfirm(page);
    await page.waitForURL("**/dashboard", { timeout: 300_000 });
    await reloadAfter(page, delay);
    await expectChart(page, "the rectified chart must survive a reload at the moment /dashboard appears");
    await reload(page);
    await expectChart(page, "the chart must still be there after a second reload");
    expect(await rectifiedTimeAfterReload(page), "the stored chart must carry the rectified time").toMatch(
      /^\d{2}:\d{2}$/,
    );
    expect(consoleErrors, "browser console errors").toEqual([]);
  });
}
