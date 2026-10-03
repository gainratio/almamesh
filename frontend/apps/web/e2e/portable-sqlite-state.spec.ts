import { readFileSync, writeFileSync } from "node:fs";
import {
  test,
  expect,
  type BrowserContext,
  type Page,
  type TestInfo,
} from "@playwright/test";

const PROFILE_ID = "portable-profile-ada";
const PROFILE_NAME = "Portable Ada";
const MEMBER_ID = "portable-profile-grace";
const MESH_READING_SENTINEL = "Portable relationship narration restored from SQLite";
const INTERPRETATION_SENTINEL = "Portable paid natal interpretation restored from SQLite";
const API_KEY_SENTINEL = "sk-local-portable-e2e-never-plaintext";
const PASSPHRASE = "portable e2e passphrase";
const SQLITE_HEADER = Buffer.from("SQLite format 3\0", "binary");
const CANONICAL_IDB_KEYS = [
  "almamesh-profiles",
  "almamesh-chart-library",
  "almamesh-life-events",
  "almamesh-mesh-readings",
] as const;

interface BrowserProblems {
  readonly consoleErrors: string[];
  readonly pageErrors: string[];
  readonly failedRequests: string[];
  readonly externalRequests: string[];
}

function watchBrowser(
  context: BrowserContext,
  origin: string,
): BrowserProblems {
  const problems: BrowserProblems = {
    consoleErrors: [],
    pageErrors: [],
    failedRequests: [],
    externalRequests: [],
  };
  const watchedPages = new WeakSet<Page>();
  const watchPage = (page: Page) => {
    if (watchedPages.has(page)) return;
    watchedPages.add(page);
    page.on("console", (message) => {
      if (message.type() === "error")
        problems.consoleErrors.push(message.text());
    });
    page.on("pageerror", (error) => problems.pageErrors.push(error.message));
  };
  for (const page of context.pages()) watchPage(page);
  context.on("page", watchPage);
  context.on("requestfailed", (request) => {
    // Navigating between Settings routes can cancel the background engine
    // prewarm. Chromium reports that intentional cancellation as a failed
    // request even though no response failed and the app handles it normally.
    if (
      request.failure()?.errorText === "net::ERR_ABORTED" &&
      new URL(request.url()).pathname.startsWith("/pyodide/")
    ) {
      return;
    }
    problems.failedRequests.push(
      `${request.method()} ${request.url()} — ${request.failure()?.errorText}`,
    );
  });
  context.on("request", (request) => {
    const url = new URL(request.url());
    if (
      (url.protocol === "http:" || url.protocol === "https:") &&
      url.origin !== origin
    ) {
      problems.externalRequests.push(`${request.method()} ${request.url()}`);
    }
  });
  return problems;
}

function expectCleanBrowser(problems: BrowserProblems): void {
  expect(
    problems.externalRequests,
    "unexpected external network requests",
  ).toEqual([]);
  expect(problems.failedRequests, "failed browser requests").toEqual([]);
  expect(problems.pageErrors, "uncaught page errors").toEqual([]);
  expect(problems.consoleErrors, "browser console errors").toEqual([]);
}

/** Force the browser-native file APIs onto the ordinary HTML download/input path. */
async function installPlaywrightFileChooserFallback(
  context: BrowserContext,
): Promise<void> {
  await context.addInitScript(() => {
    Reflect.deleteProperty(window, "showSaveFilePicker");
    Reflect.deleteProperty(window, "showOpenFilePicker");
  });
}

async function seedLegacyState(page: Page): Promise<void> {
  await page.evaluate(
    async ({
      profileId,
      profileName,
      memberId,
      meshReadingSentinel,
      interpretationSentinel,
      apiKey,
      canonicalKeys,
    }) => {
      const profileEnvelope = JSON.stringify({
        state: {
          profiles: {
            [profileId]: {
              id: profileId,
              name: profileName,
              createdAt: "2026-01-02T03:04:05.000Z",
              avatarTint: "#3A4FB0",
              relationship: "self",
            },
            [memberId]: {
              id: memberId,
              name: "Portable Grace",
              createdAt: "2026-01-03T03:04:05.000Z",
              avatarTint: "#7A4FB0",
              relationship: "friend",
              relatedTo: profileId,
            },
          },
          activeProfileId: profileId,
        },
        version: 1,
        datasetEpoch: 0,
      });
      const lifeEventsEnvelope = JSON.stringify({
        state: { eventsByProfile: { [profileId]: [] } },
        version: 4,
        datasetEpoch: 0,
      });
      const signs = [
        "Aries", "Taurus", "Gemini", "Cancer", "Leo", "Virgo",
        "Libra", "Scorpio", "Sagittarius", "Capricorn", "Aquarius", "Pisces",
      ];
      const housesFrom = (lagnaIndex: number) => Object.fromEntries(
        Array.from({ length: 12 }, (_, index) => [
          String(index + 1),
          {
            house: index + 1,
            sign: signs[(lagnaIndex + index) % 12],
            longitude: ((lagnaIndex + index) % 12) * 30,
            sign_lord: "synthetic",
          },
        ]),
      );
      const chartLibraryEnvelope = JSON.stringify({
        state: {
          charts: {
            ["portable-chart-ada"]: {
              chart_id: "portable-chart-ada",
              person_name: profileName,
              profile_id: profileId,
              is_primary: true,
              birth_data: {
                birth_datetime_utc: "1990-01-15T12:00:00+00:00",
                birth_datetime_local: "1990-01-15T17:30:00",
                birth_location_details: {
                  city: "Delhi",
                  latitude: 28.6139,
                  longitude: 77.209,
                  timezone: "Asia/Kolkata",
                },
              },
              astronomical_calculations: {
                sidereal_ctx: {
                  lagna: { sign: "Aquarius", longitude: 328.84 },
                  planets: {},
                },
              },
              sidereal_chart: {
                ayanamsa_value: 23.86,
                lagna: { sign: "Aquarius", sign_degrees: 28.84 },
                planets: {},
                houses: housesFrom(10),
                dashas: {
                  maha_dasha_sequence: [],
                  current_maha: null,
                  current_antar: null,
                  current_pratyantar: null,
                },
                yogas: [],
              },
            },
            ["portable-chart-grace"]: {
              chart_id: "portable-chart-grace",
              person_name: "Portable Grace",
              profile_id: memberId,
              is_primary: true,
              birth_data: {
                birth_datetime_utc: "1992-06-20T09:30:00+00:00",
                birth_datetime_local: "1992-06-20T15:00:00",
                birth_location_details: {
                  city: "Mumbai",
                  latitude: 19.076,
                  longitude: 72.8777,
                  timezone: "Asia/Kolkata",
                },
              },
              astronomical_calculations: {
                sidereal_ctx: {
                  lagna: { sign: "Leo", longitude: 140.2 },
                  planets: {},
                },
              },
              sidereal_chart: {
                ayanamsa_value: 23.86,
                lagna: { sign: "Leo", sign_degrees: 20.2 },
                planets: {},
                houses: housesFrom(4),
                dashas: {
                  maha_dasha_sequence: [],
                  current_maha: null,
                  current_antar: null,
                  current_pratyantar: null,
                },
                yogas: [],
              },
            },
          },
        },
        version: 1,
        datasetEpoch: 0,
      });
      const now = new Date();
      const referenceInstant = `${String(now.getUTCFullYear()).padStart(4, "0")}-${String(
        now.getUTCMonth() + 1,
      ).padStart(2, "0")}-${String(now.getUTCDate()).padStart(2, "0")}T00:00:00Z`;
      const windowEnd = new Date(referenceInstant);
      windowEnd.setUTCFullYear(windowEnd.getUTCFullYear() + 2);
      const edgeRequestKey = JSON.stringify({
        a: {
          datetimeUtc: "1990-01-15T12:00:00+00:00",
          latitude: 28.6139,
          longitude: 77.209,
        },
        b: {
          datetimeUtc: "1992-06-20T09:30:00+00:00",
          latitude: 19.076,
          longitude: 72.8777,
        },
        relationship: "friend",
        roleA: "bride",
        roleB: "groom",
        windowStart: referenceInstant,
        windowEnd: windowEnd.toISOString().replace(/\.\d{3}Z$/, "Z"),
        referenceInstant,
      });
      const pairKey = `${profileId}|${memberId}`;
      const persona = (title: string) => ({
        title,
        layman: meshReadingSentinel,
        technical: meshReadingSentinel,
      });
      const meshReadingsEnvelope = JSON.stringify({
        state: {
          byPair: {
            [pairKey]: {
              pairKey,
              profileIds: [profileId, memberId],
              edgeRequestKey,
              language: "es",
              generationMode: "expert",
              provider: {
                engine: "openai-http",
                model: "synthetic/local-tool-model",
              },
              generatedAt: "2026-01-04T03:04:05.000Z",
              reading: {
                connection: persona("Connection"),
                timing_together: persona("Timing"),
                care: persona("Care"),
              },
            },
          },
        },
        version: 1,
        datasetEpoch: 0,
      });

      await new Promise<void>((resolve, reject) => {
        const request = indexedDB.open("keyval-store");
        request.onupgradeneeded = () =>
          request.result.createObjectStore("keyval");
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          const db = request.result;
          const tx = db.transaction("keyval", "readwrite");
          const store = tx.objectStore("keyval");
          store.put(profileEnvelope, canonicalKeys[0]);
          store.put(chartLibraryEnvelope, canonicalKeys[1]);
          store.put(lifeEventsEnvelope, canonicalKeys[2]);
          store.put(meshReadingsEnvelope, canonicalKeys[3]);
          tx.oncomplete = () => {
            db.close();
            resolve();
          };
          tx.onerror = () => reject(tx.error);
        };
      });

      localStorage.setItem(
        "almamesh-language",
        JSON.stringify({ state: { language: "es" }, version: 1 }),
      );
      localStorage.setItem(
        "almamesh-llm-settings",
        JSON.stringify({
          apiBase: "http://127.0.0.1:11434/v1",
          apiKey,
          model: "synthetic/local-tool-model",
          privacyMode: "strict",
        }),
      );
      localStorage.setItem(
        "almamesh-content-mode",
        JSON.stringify({ contentMode: "technical" }),
      );
      localStorage.setItem(
        "almamesh-interpretations",
        JSON.stringify({
          state: {
            byChart: {
              "portable-chart-ada": {
                status: "complete",
                sections: { core: true },
                profileId,
                updatedAt: "2026-01-04T03:04:05.000Z",
                interpretation: {
                  summary: {
                    layman: interpretationSentinel,
                    technical: interpretationSentinel,
                  },
                  strengths: [],
                  challenges: [],
                  life_themes: [],
                },
              },
            },
          },
          version: 6,
        }),
      );
    },
    {
      profileId: PROFILE_ID,
      profileName: PROFILE_NAME,
      memberId: MEMBER_ID,
      meshReadingSentinel: MESH_READING_SENTINEL,
      interpretationSentinel: INTERPRETATION_SENTINEL,
      apiKey: API_KEY_SENTINEL,
      canonicalKeys: CANONICAL_IDB_KEYS,
    },
  );
}

async function readLegacyRows(page: Page): Promise<Record<string, unknown>> {
  return page.evaluate(
    async (keys) => {
      return new Promise<Record<string, unknown>>((resolve, reject) => {
        const request = indexedDB.open("keyval-store");
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          const db = request.result;
          const tx = db.transaction("keyval", "readonly");
          const store = tx.objectStore("keyval");
          const values: Record<string, unknown> = {};
          let remaining = keys.length;
          for (const key of keys) {
            const get = store.get(key);
            get.onerror = () => reject(get.error);
            get.onsuccess = () => {
              values[key] = get.result ?? null;
              remaining -= 1;
              if (remaining === 0) {
                db.close();
                resolve(values);
              }
            };
          }
        };
      });
    },
    [...CANONICAL_IDB_KEYS],
  );
}

async function expectProfileAndLanguage(page: Page): Promise<void> {
  await page.goto("/settings/people", { waitUntil: "domcontentloaded" });
  await expect(page.getByTestId(`person-row-${PROFILE_ID}`)).toContainText(
    PROFILE_NAME,
  );
  await expect.poll(() => page.locator("html").getAttribute("lang")).toBe("es");
}

async function expectAiSettingsRestored(page: Page): Promise<void> {
  await page.goto("/settings/ai", { waitUntil: "domcontentloaded" });
  await expect(page.getByTestId("llm-api-base")).toHaveValue(
    "http://127.0.0.1:11434/v1",
  );
  await expect(page.getByTestId("llm-openrouter-key")).toHaveValue(
    API_KEY_SENTINEL,
  );
  await expect(page.getByTestId("llm-model")).toHaveValue(
    "synthetic/local-tool-model",
  );
}

async function expectPortablePreferencesRestored(page: Page): Promise<void> {
  await page.goto("/settings/preferences", { waitUntil: "domcontentloaded" });
  await expect(page.getByTestId("content-mode-technical")).toHaveClass(
    /bg-accent-gold/,
  );
}

async function expectInterpretationRestored(
  page: Page,
  problems: BrowserProblems,
): Promise<void> {
  await page.goto("/dashboard", { waitUntil: "domcontentloaded" });
  try {
    await expect(page.getByText(INTERPRETATION_SENTINEL)).toBeVisible({ timeout: 60_000 });
  } catch (error) {
    expectCleanBrowser(problems);
    throw error;
  }
}

async function expectLegacyBrowserCopiesRemoved(page: Page): Promise<void> {
  expect(
    await page.evaluate(() => ({
      settings: localStorage.getItem("almamesh-llm-settings"),
      mode: localStorage.getItem("almamesh-content-mode"),
      chart: localStorage.getItem("almamesh-chart"),
      language: localStorage.getItem("almamesh-language"),
      restoreEpoch: localStorage.getItem("almamesh-restore-epoch"),
      restoreProgress: localStorage.getItem("almamesh-restore-in-progress"),
      interpretations: localStorage.getItem("almamesh-interpretations"),
    })),
  ).toEqual({
    settings: null,
    mode: null,
    chart: null,
    language: null,
    restoreEpoch: null,
    restoreProgress: null,
    interpretations: null,
  });
}

test("migrates, exports, reloads, and restores canonical OPFS SQLite through Settings", async ({
  page,
  context,
  browser,
  baseURL,
}, testInfo: TestInfo) => {
  expect(baseURL).toBeTruthy();
  const origin = new URL(baseURL!).origin;
  const firstProblems = watchBrowser(context, origin);
  await installPlaywrightFileChooserFallback(context);

  // robots.txt is same-origin but boots no application JavaScript. This makes
  // the following writes genuine pre-boot legacy state, not a test-only app API.
  const staticResponse = await page.goto("/robots.txt");
  expect(staticResponse?.headers()["cross-origin-opener-policy"]).toBe(
    "same-origin",
  );
  expect(staticResponse?.headers()["cross-origin-embedder-policy"]).toBe(
    "require-corp",
  );
  await expect
    .poll(() =>
      page.evaluate(() => ({
        isolated: crossOriginIsolated,
        sharedArrayBuffer: typeof SharedArrayBuffer,
        waitAsync: typeof Atomics.waitAsync,
      })),
    )
    .toEqual({
      isolated: true,
      sharedArrayBuffer: "function",
      waitAsync: "function",
    });
  await seedLegacyState(page);

  // The first app boot must atomically copy legacy rows into SQLite before it
  // removes the old IndexedDB source rows. Visible state proves the SQLite read.
  await expectProfileAndLanguage(page);
  await expect
    .poll(() => readLegacyRows(page))
    .toEqual({
      "almamesh-profiles": null,
      "almamesh-chart-library": null,
      "almamesh-life-events": null,
      "almamesh-mesh-readings": null,
    });
  await expectLegacyBrowserCopiesRemoved(page);
  await expectInterpretationRestored(page, firstProblems);

  // A second page in the same browser context observes the same canonical file.
  const peer = await context.newPage();
  await expectProfileAndLanguage(peer);
  await peer.close();

  await page.goto("/settings/data", { waitUntil: "domcontentloaded" });
  await expect(page.getByTestId("backup-import-button")).toBeVisible();
  await page.getByTestId("backup-passphrase-input").fill(PASSPHRASE);
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.getByTestId("backup-export-button").click(),
  ]);
  expect(download.suggestedFilename()).toMatch(
    /^almamesh-backup-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z\.almamesh$/,
  );
  const exportedPath = testInfo.outputPath("portable-almamesh-export.almamesh");
  await download.saveAs(exportedPath);
  // The binary transport is fully sealed. Neither secrets, setting names, nor
  // the decrypted SQLite payload appear in the bytes on disk.
  const exported = readFileSync(exportedPath);
  expect(exported.includes(Buffer.from(API_KEY_SENTINEL))).toBe(false);
  expect(exported.includes(Buffer.from("almamesh-llm-settings"))).toBe(false);
  expect(exported.includes(SQLITE_HEADER)).toBe(false);

  await page.reload({ waitUntil: "domcontentloaded" });
  await expectProfileAndLanguage(page);
  expectCleanBrowser(firstProblems);

  // A one-byte modification must fail authentication before any destination
  // state changes. Use a separate empty browser so the successful restore below
  // remains a faithful Browser A -> Browser B scenario.
  const tamperedPath = testInfo.outputPath(
    "portable-almamesh-tampered.almamesh",
  );
  const tampered = Buffer.from(exported);
  tampered[tampered.length - 1] ^= 0x01;
  const tamperedContext = await browser.newContext({
    baseURL,
    acceptDownloads: true,
  });
  await installPlaywrightFileChooserFallback(tamperedContext);
  const tamperedPage = await tamperedContext.newPage();
  await tamperedPage.goto("/settings/data", { waitUntil: "domcontentloaded" });
  writeFileSync(tamperedPath, tampered);
  const [tamperedChooser] = await Promise.all([
    tamperedPage.waitForEvent("filechooser"),
    tamperedPage.getByTestId("backup-import-button").click(),
  ]);
  await tamperedChooser.setFiles(tamperedPath);
  await tamperedPage
    .getByTestId("backup-passphrase-prompt-input")
    .fill(PASSPHRASE);
  await tamperedPage.getByTestId("backup-passphrase-prompt-submit").click();
  await expect(tamperedPage.getByRole("alert")).toContainText("Wrong password");
  expect(
    await tamperedPage.evaluate(() => ({
      settings: localStorage.getItem("almamesh-llm-settings"),
      mode: localStorage.getItem("almamesh-content-mode"),
      chart: localStorage.getItem("almamesh-chart"),
    })),
  ).toEqual({ settings: null, mode: null, chart: null });
  await tamperedContext.close();

  // A fresh browser context has its own empty OPFS root. Restore only through
  // Settings: real file input, real staged validation, safety-net download,
  // real SQLite replace, and the UI-owned reload.
  const restoredContext = await browser.newContext({
    baseURL,
    acceptDownloads: true,
  });
  const restoredProblems = watchBrowser(restoredContext, origin);
  await installPlaywrightFileChooserFallback(restoredContext);
  const restoredPage = await restoredContext.newPage();
  await restoredPage.goto("/settings/data", { waitUntil: "domcontentloaded" });
  await expect(restoredPage.getByTestId("backup-import-button")).toBeVisible();

  const [chooser] = await Promise.all([
    restoredPage.waitForEvent("filechooser"),
    restoredPage.getByTestId("backup-import-button").click(),
  ]);
  await chooser.setFiles(exportedPath);
  // A wrong password is refused with a specific message and imports nothing.
  const promptInput = restoredPage.getByTestId(
    "backup-passphrase-prompt-input",
  );
  await promptInput.fill("not the passphrase");
  await restoredPage.getByTestId("backup-passphrase-prompt-submit").click();
  await expect(restoredPage.getByRole("alert")).toContainText("Wrong password");
  expect(
    await restoredPage.evaluate(() => ({
      settings: localStorage.getItem("almamesh-llm-settings"),
      mode: localStorage.getItem("almamesh-content-mode"),
      chart: localStorage.getItem("almamesh-chart"),
    })),
  ).toEqual({ settings: null, mode: null, chart: null });
  await promptInput.fill(PASSPHRASE);
  await restoredPage.getByTestId("backup-passphrase-prompt-submit").click();
  const confirm = restoredPage.getByTestId("backup-confirm-import");
  await expect(confirm).toBeVisible();

  const [safetyDownload] = await Promise.all([
    restoredPage.waitForEvent("download"),
    confirm.click(),
  ]);
  expect(safetyDownload.suggestedFilename()).toMatch(
    /^almamesh-backup-before-import-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z\.almamesh$/,
  );
  const safetyPath = testInfo.outputPath(
    "portable-almamesh-safety-net.almamesh",
  );
  await safetyDownload.saveAs(safetyPath);
  const safetyBytes = readFileSync(safetyPath);
  expect(safetyBytes.includes(Buffer.from(API_KEY_SENTINEL))).toBe(false);
  expect(safetyBytes.includes(SQLITE_HEADER)).toBe(false);

  // Chromium's anchor-download fallback cannot observe completion. The first
  // click must pause Replace until the user explicitly confirms the safety file.
  await expect(restoredPage.getByTestId("backup-safety-confirmation")).toBeVisible();
  await Promise.all([
    restoredPage.waitForEvent("domcontentloaded"),
    confirm.click(),
  ]);

  await expectProfileAndLanguage(restoredPage);
  await expectAiSettingsRestored(restoredPage);
  await expectPortablePreferencesRestored(restoredPage);
  await expectInterpretationRestored(restoredPage, restoredProblems);
  await expectLegacyBrowserCopiesRemoved(restoredPage);
  await restoredPage.goto(`/mesh/${MEMBER_ID}`, { waitUntil: "domcontentloaded" });
  await expect(restoredPage.getByTestId("mesh-reading")).toContainText(
    MESH_READING_SENTINEL,
    { timeout: 60_000 },
  );
  // The compact fixture is intentionally sufficient for persistence/routing,
  // not a complete astronomy result. Assert console hygiene before asking the
  // root guard to route it to a chart-dependent page.
  expectCleanBrowser(restoredProblems);
  await restoredPage.goto("/", { waitUntil: "domcontentloaded" });
  await expect
    .poll(() => new URL(restoredPage.url()).pathname)
    .toBe("/dashboard");
  await restoredContext.close();
});
