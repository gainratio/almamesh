import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  test,
  expect,
  type Browser,
  type BrowserContext,
  type Page,
  type TestInfo,
} from '@playwright/test';

import {
  AI_KEY,
  CHAT_ANSWER,
  CHAT_QUESTION,
  EVENT_SUMMARY,
  MESH_SENTINEL,
  READING_SENTINEL,
  confirmRegeneration,
  expectCleanBrowser,
  expectDashboardChart,
  exportBackup,
  fakeThirdParties,
  gotoSettled,
  importBackup,
  onboard,
  profileIdOf,
  spaNavigate,
  switchActivePerson,
  forceDownloadAndFileInputPaths,
  watchBrowser,
  type Native,
} from './portableInvariants.helpers';

/**
 * Portable-state invariants — the standing guard for "move ALL my data and
 * secrets to another browser with one encrypted .almamesh file".
 *
 * Browser A builds real state through the real UI, mutates it, and exports
 * with the File System Access pickers removed (the iOS `<a download>` path).
 * Browser B is a NEW context (new, empty OPFS root) that imports the file
 * through Settings and must show every row the user had in A, and nothing the
 * user deleted. Both browsers must keep a clean console.
 *
 * Runs in Chromium and WebKit (playwright.portable-invariants.config.ts).
 * Run:  bun run test:e2e:portable-invariants
 */

const SELF: Native = {
  name: 'Invariant Ada',
  date: '08081988',
  time: '0644',
  meridiem: 'a',
  city: 'Bengaluru',
  narrative: 'I got married on 2015-06-20 in Pune.',
};
const RENAMED_SELF = 'Invariant Ada Renamed';
const EDITED_BIRTH_TIME = '06:47';
const KEPT_FRIEND: Native = {
  name: 'Invariant Grace',
  date: '06201992',
  time: '0300',
  meridiem: 'p',
  city: 'Mumbai',
};
const DELETED_MEMBER: Native = {
  name: 'Invariant Temp',
  date: '01021995',
  time: '1015',
  meridiem: 'a',
  city: 'Mumbai',
};

// Linux Playwright WebKit cannot open SQLite's nested-Worker OPFS (see
// scripts/verify-webkit-engine.mjs), so the app shows its storage block screen
// there (SQLite on OPFS is the only store). Real WebKit coverage runs on macOS.
test.skip(
  ({ browserName }) => browserName === 'webkit' && process.platform === 'linux',
  'Linux Playwright WebKit has no nested-Worker OPFS',
);

function originOf(testInfo: TestInfo): string {
  const baseURL = testInfo.project.use.baseURL;
  expect(baseURL, 'baseURL').toBeTruthy();
  return new URL(baseURL as string).origin;
}

/**
 * Empty every origin store before the app boots. Needed for WebKit on macOS,
 * where Playwright keeps website data (OPFS included) outside the per-launch
 * profile directory, so a "new" profile can still see the previous one's data.
 * robots.txt runs no app code, so nothing is open while this runs.
 */
async function wipeOrigin(page: Page): Promise<void> {
  await page.goto('/robots.txt');
  await page.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    const names: string[] = [];
    for await (const name of (root as unknown as { keys(): AsyncIterable<string> }).keys()) names.push(name);
    for (const name of names) await root.removeEntry(name, { recursive: true });
    for (const db of await indexedDB.databases()) {
      if (db.name) {
        await new Promise((resolve) => {
          const request = indexedDB.deleteDatabase(db.name as string);
          request.onsuccess = request.onerror = request.onblocked = resolve;
        });
      }
    }
    for (const key of await caches.keys()) await caches.delete(key);
    localStorage.clear();
    sessionStorage.clear();
  });
}

/**
 * A new browser profile = a new, empty OPFS root, plus faked third parties and
 * the iOS file paths. WebKit needs an on-disk profile: a default WebKit
 * newContext() is an ephemeral data store that refuses OPFS, so the app would
 * (correctly) show its storage block screen instead of running.
 */
async function freshBrowser(browser: Browser, testInfo: TestInfo) {
  const options = { baseURL: testInfo.project.use.baseURL, acceptDownloads: true };
  let context: BrowserContext;
  let profileDir: string | null = null;
  if (browser.browserType().name() === 'webkit') {
    profileDir = await mkdtemp(join(tmpdir(), 'almamesh-portable-invariants-'));
    // Playwright's WebKit does not route fetches a service worker makes, so
    // with the app's worker active the LLM and geocoder fakes would be
    // bypassed and the test would hit the real internet. Block the worker
    // here; the Chromium project keeps it (Chromium routes worker fetches).
    context = await browser.browserType().launchPersistentContext(profileDir, {
      ...options,
      headless: true,
      serviceWorkers: 'block',
    });
  } else {
    context = await browser.newContext(options);
  }
  await forceDownloadAndFileInputPaths(context);
  const llmCalls = await fakeThirdParties(context);
  const problems = watchBrowser(context, originOf(testInfo));
  const page = context.pages()[0] ?? (await context.newPage());
  if (profileDir) await wipeOrigin(page);
  const close = async () => {
    await context.close();
    if (profileDir) await rm(profileDir, { recursive: true, force: true });
  };
  return { context, page, problems, llmCalls, close };
}

// ---------------------------------------------------------------------------
// Seed steps (browser A)
// ---------------------------------------------------------------------------

async function connectAi(page: Page): Promise<void> {
  await spaNavigate(page, '/settings/ai');
  await page.getByTestId('llm-openrouter-key').fill(AI_KEY);
  await page.getByTestId('llm-save').click();
  await expect(page.getByTestId('llm-connection-result')).toContainText(/Connected/);
}

async function generateReading(page: Page): Promise<void> {
  await spaNavigate(page, '/dashboard');
  await page.getByTestId('generate-reading').click();
  await expect(page.getByText(READING_SENTINEL).and(page.locator('p'))).toBeVisible({
    timeout: 120_000,
  });
  await expect(page.getByTestId('interpretation-progress')).toHaveCount(0);
}

async function chat(page: Page): Promise<void> {
  await page.getByTestId('floating-chat-button').click({ timeout: 60_000 });
  await page.getByTestId('chat-input').fill(CHAT_QUESTION);
  await page.getByTestId('chat-send-button').click();
  await expect(page.getByTestId('chat-panel').getByText(CHAT_ANSWER)).toBeVisible({
    timeout: 120_000,
  });
  await page.keyboard.press('Escape');
}

/**
 * Open the wizard's manual event tray. The intro step only shows while the
 * person has no events yet; with events it opens straight on the tray.
 */
async function openRectifyEvents(page: Page, profileId: string): Promise<void> {
  await spaNavigate(page, `/rectify/${profileId}`);
  const intro = page.getByTestId('intro-start-btn');
  const manual = page.locator('button').filter({ hasText: /enter events manually instead/i });
  await expect(intro.or(manual)).toBeVisible();
  if (await intro.isVisible()) await intro.click();
  await manual.click();
  const addEvent = page.locator('button').filter({ hasText: /add event/i });
  if (!(await addEvent.isVisible())) {
    await page.locator('button').filter({ hasText: /gathered/i }).first().click();
  }
  await expect(addEvent).toBeVisible();
}

async function rectify(page: Page, profileId: string): Promise<void> {
  await openRectifyEvents(page, profileId);
  await page.locator('button').filter({ hasText: /add event/i }).click();
  const row = page.getByTestId('event-row').last();
  await row.locator('input[type="date"]').fill('2018-09-10');
  await row.locator('select[aria-label="Category"]').selectOption({ value: 'relocation' });
  await page.getByTestId('event-summary-input').last().fill(EVENT_SUMMARY);
  await page.locator('button').filter({ hasText: /find my rising sign/i }).click();
  await page.getByTestId('window-start-btn').click();
  await expect(page.getByTestId('band-label')).toBeVisible({ timeout: 120_000 });
  await page.getByTestId('candidate-card').first().getByTestId('confirm-button').click();
  await confirmRegeneration(page);
  await page.waitForURL('**/dashboard', { timeout: 60_000 });
  // The confirmed time is in effect once the regenerated chart is committed.
  await expect
    .poll(
      async () => {
        await spaNavigate(page, '/dashboard');
        await spaNavigate(page, '/settings/profile');
        return page.getByTestId('adjustment-in-effect').isVisible();
      },
      { timeout: 120_000, intervals: [1_000] },
    )
    .toBe(true);
  await expect(page.getByTestId('rectification-record')).toBeVisible();
}

async function editBirthTime(page: Page): Promise<void> {
  await spaNavigate(page, '/settings/profile');
  const time = page.locator('form input[type="time"]').first();
  await time.fill(EDITED_BIRTH_TIME);
  await expect(time).toHaveValue(EDITED_BIRTH_TIME);
  // A birth-time-only edit: no rectification exists yet, so the Rectified-time
  // field is empty and Save must regenerate on the new clock alone (#245).
  await expect(page.locator('#rectified-time')).toHaveValue('');
  await page.locator('form button[type="submit"]').click();
  await confirmRegeneration(page);
  // Regeneration runs in the background; the form re-reads the stored chart,
  // so the edited time shows there only once the new chart is committed.
  await expect
    .poll(
      async () => {
        await spaNavigate(page, '/dashboard');
        await spaNavigate(page, '/settings/profile');
        return page.locator('form input[type="time"]').first().inputValue();
      },
      { timeout: 120_000, intervals: [1_000] },
    )
    .toBe(EDITED_BIRTH_TIME);
}

async function markMe(page: Page): Promise<void> {
  await spaNavigate(page, '/settings/people');
  await page.getByRole('button', { name: 'This is me' }).click();
  await expect(page.getByText('You', { exact: true })).toBeVisible();
}

async function addFriend(page: Page, native: Native): Promise<void> {
  await spaNavigate(page, '/settings/people');
  await page.locator('button', { hasText: 'Add a person' }).click();
  await page.getByLabel('Name', { exact: true }).fill(native.name);
  await page.getByLabel('Relationship to you', { exact: true }).selectOption('friend');
  await page.getByRole('button', { name: 'Add & enter birth details' }).click();
  await page.waitForURL('**/onboarding');
  await onboard(page, native);
}

async function meshReading(page: Page, memberId: string): Promise<void> {
  await spaNavigate(page, `/mesh/${memberId}`);
  await page.getByTestId('mesh-reading-generate').click({ timeout: 120_000 });
  await expect(page.getByTestId('mesh-reading')).toContainText(MESH_SENTINEL, { timeout: 120_000 });
}

// ---------------------------------------------------------------------------
// Mutation steps (browser A)
// ---------------------------------------------------------------------------

async function renamePerson(page: Page, from: string, to: string): Promise<void> {
  await spaNavigate(page, '/settings/people');
  await page.getByRole('button', { name: `Rename ${from}` }).click();
  const field = page.getByRole('textbox', { name: `Rename ${from}` });
  await field.fill(to);
  await field.press('Enter');
  await expect(page.locator('[data-testid^="person-row-"]').filter({ hasText: to })).toHaveCount(1);
}

/** Row-scoped so it works in any UI language: Delete is the row's last button. */
async function deletePerson(page: Page, id: string): Promise<void> {
  await spaNavigate(page, '/settings/people');
  await page.getByTestId(`person-row-${id}`).getByRole('button').last().click();
  await page.getByTestId(`confirm-delete-${id}`).click();
  await expect(page.getByTestId(`person-row-${id}`)).toHaveCount(0);
}

async function setLanguage(page: Page, language: 'en' | 'es'): Promise<void> {
  await spaNavigate(page, '/settings/preferences');
  await page.getByTestId('language-select').selectOption(language);
  await expect.poll(() => page.locator('html').getAttribute('lang')).toBe(language);
}

// ---------------------------------------------------------------------------
// Assertions (browser B)
// ---------------------------------------------------------------------------

interface ExpectedPeople {
  readonly selfId: string;
  readonly friendId: string;
  readonly deletedId: string;
}

async function expectRestoredJourney(page: Page, ids: ExpectedPeople): Promise<void> {
  // Language first: the import must land in Spanish before anything else runs.
  await gotoSettled(page, '/settings/preferences');
  await expect(page.getByTestId('language-select')).toHaveValue('es');
  await setLanguage(page, 'en');

  await spaNavigate(page, '/settings/people');
  await expect(page.getByTestId(`person-row-${ids.selfId}`)).toContainText(RENAMED_SELF);
  await expect(page.getByTestId(`person-row-${ids.friendId}`)).toContainText(KEPT_FRIEND.name);
  await expect(page.getByTestId(`person-row-${ids.deletedId}`)).toHaveCount(0);
  await expect(page.locator('[data-testid^="person-row-"]')).toHaveCount(2);

  await spaNavigate(page, '/settings/ai');
  await expect(page.getByTestId('tier-cloud-active')).toBeVisible();
  await expect(page.getByTestId('llm-openrouter-key')).toHaveValue(AI_KEY);

  await spaNavigate(page, '/settings/profile');
  await expect(page.locator('form input[type="time"]').first()).toHaveValue(EDITED_BIRTH_TIME);
  await expect(page.getByTestId('rectification-record')).toBeVisible();

  await spaNavigate(page, '/dashboard');
  // The chart keeps the name it was generated under: Rename does not cascade
  // to the chart's person_name (reported with this suite), so match the stem.
  await expectDashboardChart(page, SELF.name);
  await expect(page.getByText(READING_SENTINEL).and(page.locator('p'))).toBeVisible({
    timeout: 60_000,
  });

  await page.getByTestId('floating-chat-button').click({ timeout: 60_000 });
  const panel = page.getByTestId('chat-panel');
  await expect(panel.getByTestId('chat-message-user')).toContainText(CHAT_QUESTION);
  await expect(panel.getByTestId('chat-message-assistant')).toContainText(CHAT_ANSWER);
  await page.keyboard.press('Escape');

  await spaNavigate(page, `/mesh/${ids.friendId}`);
  await expect(page.getByTestId('mesh-reading')).toContainText(MESH_SENTINEL, { timeout: 60_000 });
  await spaNavigate(page, '/mesh');
  await expect(page.getByTestId('mesh-constellation')).toContainText(KEPT_FRIEND.name);
  await expect(page.getByTestId('mesh-constellation')).not.toContainText(DELETED_MEMBER.name);

  await openRectifyEvents(page, ids.selfId);
  await expect(page.getByTestId('event-summary-input')).toHaveCount(2);
  const summaries = await page.getByTestId('event-summary-input').evaluateAll((inputs) =>
    inputs.map((input) => (input as HTMLInputElement).value),
  );
  expect(summaries).toContain(EVENT_SUMMARY);
}

function expectNoLeak(bytes: Buffer, secrets: readonly string[]): void {
  for (const secret of secrets) {
    expect(bytes.includes(Buffer.from(secret)), `export must not contain "${secret}"`).toBe(false);
  }
  expect(bytes.includes(Buffer.from('SQLite format 3\0', 'binary'))).toBe(false);
}

// ---------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------

test.describe('full journey: seed, mutate, export, import into a new browser', () => {
  test('every entity round-trips and deleted rows stay deleted', async ({ browser }, testInfo) => {
    const a = await freshBrowser(browser, testInfo);
    const page = a.page;
    let ids: ExpectedPeople = { selfId: '', friendId: '', deletedId: '' };

    await test.step('seed: onboard self with a life event', async () => {
      await gotoSettled(page, '/onboarding');
      await onboard(page, SELF);
      await spaNavigate(page, '/settings/people');
      ids = { ...ids, selfId: await profileIdOf(page, SELF.name) };
    });
    await test.step('mutate: edit birth time (regenerates the chart)', async () => {
      await editBirthTime(page);
    });
    await test.step('seed: rectification record (confirm regenerates the chart)', async () => {
      await rectify(page, ids.selfId);
    });
    await test.step('seed: AI key, reading, chat thread', async () => {
      await connectAi(page);
      await generateReading(page);
      await chat(page);
    });
    await test.step('seed: two friends with mesh readings', async () => {
      await markMe(page);
      await addFriend(page, KEPT_FRIEND);
      await addFriend(page, DELETED_MEMBER);
      await switchActivePerson(page, DELETED_MEMBER.name, SELF.name);
      await spaNavigate(page, '/settings/people');
      ids = {
        ...ids,
        friendId: await profileIdOf(page, KEPT_FRIEND.name),
        deletedId: await profileIdOf(page, DELETED_MEMBER.name),
      };
      await meshReading(page, ids.friendId);
      await meshReading(page, ids.deletedId);
    });
    await test.step('mutate: rename self, delete a member, switch language', async () => {
      await renamePerson(page, SELF.name, RENAMED_SELF);
      // Language is set BEFORE the delete on purpose: a language change made
      // after deleting a person does not survive a reload (product bug
      // reported with this suite). Move it after deletePerson once fixed.
      await setLanguage(page, 'es');
      await deletePerson(page, ids.deletedId);
    });

    await test.step('browser A itself still shows the mutated state after a reload', async () => {
      await gotoSettled(page, '/settings/preferences');
      await expect(page.getByTestId('language-select'), 'A: language after reload').toHaveValue('es');
      await spaNavigate(page, '/settings/profile');
      await expect(page.locator('form input[type="time"]').first(), 'A: birth time after reload').toHaveValue(
        EDITED_BIRTH_TIME,
      );
    });

    const exportPath = testInfo.outputPath('journey.almamesh');
    await test.step('export from browser A', async () => {
      const bytes = await exportBackup(page, exportPath);
      expectNoLeak(bytes, [AI_KEY, READING_SENTINEL, RENAMED_SELF, EVENT_SUMMARY]);
      expectCleanBrowser(a.problems, 'browser A');
    });
    await a.close();

    const b = await freshBrowser(browser, testInfo);
    await test.step('import into browser B (new OPFS)', async () => {
      await importBackup(b.page, exportPath);
    });
    await test.step('browser B shows every surviving row', async () => {
      await expectRestoredJourney(b.page, ids);
      expect(b.llmCalls, 'restoring must not regenerate anything through the LLM').toEqual([]);
      expectCleanBrowser(b.problems, 'browser B');
    });
    await b.close();
  });
});

test.describe('start fresh: the empty-but-valid state round-trips', () => {
  test('after Start fresh, export -> import keeps settings and no people', async ({ browser }, testInfo) => {
    const a = await freshBrowser(browser, testInfo);
    const page = a.page;
    await test.step('seed a person, an AI key and a language, then Start fresh', async () => {
      await gotoSettled(page, '/settings/people');
      await page.locator('button', { hasText: 'Add a person' }).click();
      await page.getByLabel('Name', { exact: true }).fill('Invariant Fresh Temp');
      await page.getByRole('button', { name: 'Add & enter birth details' }).click();
      await page.waitForURL('**/onboarding');
      await connectAi(page);
      await setLanguage(page, 'es');
      await page.getByTestId('reset-start-fresh').click();
      await page.getByTestId('reset-confirm').click();
      await page.waitForURL((url) => url.pathname === '/' || url.pathname === '/welcome');
      // Let the reset finish re-opening storage before the next hard load; a
      // navigation that cancels the SQLite Worker load mid-flight is reported
      // by WebKit as an uncaught "access control checks" error.
      await page.waitForLoadState('networkidle');
      // In-app navigation, not a hard load: WebKit logs a lazy route chunk that
      // a hard load cancels mid-flight as an uncaught TypeError (the same
      // teardown-noise family as the "access control checks" blob message).
      await spaNavigate(page, '/settings/people');
      await expect(page.locator('[data-testid^="person-row-"]')).toHaveCount(0);
    });
    const exportPath = testInfo.outputPath('start-fresh.almamesh');
    await test.step('export the empty dataset', async () => {
      expectNoLeak(await exportBackup(page, exportPath), [AI_KEY]);
      expectCleanBrowser(a.problems, 'browser A');
    });
    await a.close();

    const b = await freshBrowser(browser, testInfo);
    await test.step('import into a new browser: kept settings, no people', async () => {
      await importBackup(b.page, exportPath);
      await gotoSettled(b.page, '/settings/people');
      await expect.poll(() => b.page.locator('html').getAttribute('lang')).toBe('es');
      await expect(b.page.locator('[data-testid^="person-row-"]')).toHaveCount(0);
      await spaNavigate(b.page, '/settings/ai');
      await expect(b.page.getByTestId('llm-openrouter-key')).toHaveValue(AI_KEY);
      await gotoSettled(b.page, '/');
      await expect(b.page.locator('body')).not.toBeEmpty();
      expectCleanBrowser(b.problems, 'browser B');
    });
    await b.close();
  });
});

// ---------------------------------------------------------------------------
// Legacy (pre-SQLite) storage, written before the first boot of this build
// ---------------------------------------------------------------------------

const LEGACY_SELF_ID = 'legacy-invariant-self';
const LEGACY_FRIEND_ID = 'legacy-invariant-friend';
const LEGACY_EVENT = 'Legacy invariant relocation to Chennai';
const LEGACY_KEY = 'sk-local-legacy-invariant-key';

/** Write the old IndexedDB keyval rows + localStorage keys an old build left. */
async function seedLegacyStorage(page: Page): Promise<void> {
  await page.evaluate(
    async ({ selfId, friendId, event, apiKey }) => {
      const envelope = (version: number, state: unknown) =>
        JSON.stringify({ state, version, datasetEpoch: 0 });
      const rows: Record<string, string> = {
        'almamesh-profiles': envelope(1, {
          profiles: {
            [selfId]: { id: selfId, name: 'Legacy Invariant Self', createdAt: '2026-01-02T03:04:05.000Z', avatarTint: '#3A4FB0', relationship: 'self' },
            [friendId]: { id: friendId, name: 'Legacy Invariant Friend', createdAt: '2026-01-03T03:04:05.000Z', avatarTint: '#7A4FB0', relationship: 'friend', relatedTo: selfId },
          },
          activeProfileId: selfId,
        }),
        'almamesh-life-events': envelope(4, {
          eventsByProfile: {
            [selfId]: [{ id: 'legacy-invariant-event', description: event, summary: event, date: '2012-04-01', category: 'relocation', precision: 'exact' }],
          },
        }),
      };
      await new Promise<void>((resolve, reject) => {
        const open = indexedDB.open('keyval-store');
        open.onupgradeneeded = () => open.result.createObjectStore('keyval');
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const tx = open.result.transaction('keyval', 'readwrite');
          for (const [key, value] of Object.entries(rows)) tx.objectStore('keyval').put(value, key);
          tx.oncomplete = () => { open.result.close(); resolve(); };
          tx.onerror = () => reject(tx.error);
        };
      });
      localStorage.setItem('almamesh-language', JSON.stringify({ state: { language: 'es' }, version: 1 }));
      localStorage.setItem('almamesh-llm-settings', JSON.stringify({
        apiBase: 'http://127.0.0.1:11434/v1', apiKey, model: 'synthetic/local-model', privacyMode: 'strict',
      }));
    },
    { selfId: LEGACY_SELF_ID, friendId: LEGACY_FRIEND_ID, event: LEGACY_EVENT, apiKey: LEGACY_KEY },
  );
}

async function expectLegacyState(page: Page): Promise<void> {
  await gotoSettled(page, '/settings/people');
  await expect(page.getByTestId(`person-row-${LEGACY_SELF_ID}`)).toContainText('Legacy Invariant Self');
  await expect(page.getByTestId(`person-row-${LEGACY_FRIEND_ID}`)).toContainText('Legacy Invariant Friend');
  await expect.poll(() => page.locator('html').getAttribute('lang')).toBe('es');
  await spaNavigate(page, '/settings/ai');
  await expect(page.getByTestId('llm-api-key').or(page.getByTestId('llm-openrouter-key')).first()).toHaveValue(LEGACY_KEY);
}

async function expectLegacyEvent(page: Page): Promise<void> {
  await setLanguage(page, 'en');
  await openRectifyEvents(page, LEGACY_SELF_ID);
  const summaries = await page.getByTestId('event-summary-input').evaluateAll((inputs) =>
    inputs.map((input) => (input as HTMLInputElement).value),
  );
  expect(summaries).toEqual([LEGACY_EVENT]);
}

test.describe('migrate from an old build, then export', () => {
  test('legacy rows migrate into SQLite and survive export -> import', async ({ browser }, testInfo) => {
    const a = await freshBrowser(browser, testInfo);
    await test.step('seed pre-SQLite storage and boot the new build', async () => {
      // robots.txt boots no app code: the writes are genuine pre-boot legacy state.
      await a.page.goto('/robots.txt');
      await seedLegacyStorage(a.page);
      await expectLegacyState(a.page);
    });
    const exportPath = testInfo.outputPath('legacy.almamesh');
    await test.step('export the migrated dataset', async () => {
      expectNoLeak(await exportBackup(a.page, exportPath), [LEGACY_KEY, LEGACY_EVENT]);
      expectCleanBrowser(a.problems, 'browser A');
    });
    await a.close();

    const b = await freshBrowser(browser, testInfo);
    await test.step('import into a new browser', async () => {
      await importBackup(b.page, exportPath);
      await expectLegacyState(b.page);
      await expectLegacyEvent(b.page);
      expectCleanBrowser(b.problems, 'browser B');
    });
    await b.close();
  });
});
