import { readFileSync } from "node:fs";
import {
  test,
  expect,
  type BrowserContext,
  type Page,
  type TestInfo,
} from "@playwright/test";

const PROFILE_ID = "portable-profile-ada";
const PROFILE_NAME = "Portable Ada";
const API_KEY_SENTINEL = "sk-local-portable-e2e-never-plaintext";
const PASSPHRASE = "portable e2e passphrase";
const SQLITE_HEADER = Buffer.from("SQLite format 3\0", "binary");
const CANONICAL_IDB_KEYS = [
  "almamesh-profiles",
  "almamesh-life-events",
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
    async ({ profileId, profileName, apiKey, canonicalKeys }) => {
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
          store.put(lifeEventsEnvelope, canonicalKeys[1]);
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
    },
    {
      profileId: PROFILE_ID,
      profileName: PROFILE_NAME,
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
  const saved = await page.evaluate(() =>
    JSON.parse(localStorage.getItem("almamesh-llm-settings") ?? "{}"),
  );
  expect(saved).toMatchObject({
    apiBase: "http://127.0.0.1:11434/v1",
    apiKey: API_KEY_SENTINEL,
    model: "synthetic/local-tool-model",
    privacyMode: "strict",
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
      "almamesh-life-events": null,
    });

  // A second page in the same browser context observes the same canonical file.
  const peer = await context.newPage();
  await expectProfileAndLanguage(peer);
  await peer.close();

  await page.goto("/settings/data", { waitUntil: "domcontentloaded" });
  await page.getByTestId("backup-passphrase-input").fill(PASSPHRASE);
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.getByTestId("backup-export-button").click(),
  ]);
  expect(download.suggestedFilename()).toMatch(
    /^almamesh-backup-\d{4}-\d{2}-\d{2}\.json$/,
  );
  const exportedPath = testInfo.outputPath("portable-almamesh-export.json");
  await download.saveAs(exportedPath);
  // Format v2: the whole file is sealed. Neither the API key nor the setting
  // names nor the SQLite database appear in the bytes on disk.
  const exported = readFileSync(exportedPath);
  expect(JSON.parse(exported.toString("utf8"))).toMatchObject({
    format: "almamesh-backup",
    formatVersion: 2,
    encryption: "aes-gcm",
    kdf: { name: "PBKDF2", hash: "SHA-256", iterations: 600_000 },
  });
  expect(exported.includes(Buffer.from(API_KEY_SENTINEL))).toBe(false);
  expect(exported.includes(Buffer.from("almamesh-llm-settings"))).toBe(false);
  expect(exported.includes(SQLITE_HEADER)).toBe(false);

  await page.reload({ waitUntil: "domcontentloaded" });
  await expectProfileAndLanguage(page);
  expectCleanBrowser(firstProblems);

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

  const [chooser] = await Promise.all([
    restoredPage.waitForEvent("filechooser"),
    restoredPage.getByTestId("backup-import-button").click(),
  ]);
  await chooser.setFiles(exportedPath);
  // A wrong password is refused with a specific message and imports nothing.
  const promptInput = restoredPage.getByTestId("backup-passphrase-prompt-input");
  await promptInput.fill("not the passphrase");
  await restoredPage.getByTestId("backup-passphrase-prompt-submit").click();
  await expect(restoredPage.getByRole("alert")).toContainText("Wrong password");
  expect(
    await restoredPage.evaluate(() => localStorage.getItem("almamesh-llm-settings")),
  ).toBeNull();
  await promptInput.fill(PASSPHRASE);
  await restoredPage.getByTestId("backup-passphrase-prompt-submit").click();
  const confirm = restoredPage.getByTestId("backup-confirm-import");
  await expect(confirm).toBeVisible();

  const [safetyDownload] = await Promise.all([
    restoredPage.waitForEvent("download"),
    restoredPage.waitForEvent("domcontentloaded"),
    confirm.click(),
  ]);
  expect(safetyDownload.suggestedFilename()).toMatch(
    /^almamesh-backup-before-import-\d{4}-\d{2}-\d{2}\.json$/,
  );
  const safetyPath = testInfo.outputPath("portable-almamesh-safety-net.json");
  await safetyDownload.saveAs(safetyPath);
  expect(JSON.parse(readFileSync(safetyPath, "utf8"))).toMatchObject({
    formatVersion: 2,
  });

  await expectProfileAndLanguage(restoredPage);
  await expectAiSettingsRestored(restoredPage);
  expectCleanBrowser(restoredProblems);
  await restoredContext.close();
});
