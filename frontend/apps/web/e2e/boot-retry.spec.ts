/**
 * The engine recovers from a one-off boot fault without user action.
 *
 * On a hooks build (VITE_EXIT_GATE_HOOKS=1), arming
 * `window.__almameshArmBootWasmFault` makes the FIRST boot's Pyodide Worker
 * execute a wasm `unreachable`: a real WebAssembly.RuntimeError, the class
 * WebKit raised on a cold compile ("Out of bounds memory access"). The runtime
 * must log one `engine.boot_retry` line, boot a fresh Worker, and the real
 * onboarding must reach a rendered chart with no recovery card ever shown and
 * an otherwise clean console.
 *
 * Arming it with "wrapped" throws the same real trap the way Pyodide's
 * loadPackage reports it on WebKit: a PyodidePackageLoadError for pytz whose
 * text carries the trap message (PR #317's macOS lane). That form must be
 * retried the same way.
 *
 * Arming it with "exit" rejects the first boot the way loadPyodide does when
 * CPython dies in start-up (WebKit CI run 38295121396: "Fatal Python error:
 * Failed to import encodings module"), with Emscripten's non-Error ExitStatus.
 * Before the fix it crossed the Worker as "[object Object]" and was never
 * retried; it must be retried like a trap.
 *
 * A boot failure the runtime does not retry must never leave the Life Atlas
 * saying "still starting up": it shows the failure and a Retry that reboots.
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, test as base, webkit, type Page } from '@playwright/test';
import { passOnboardingAiStep } from '../scripts/onboardingAiStep.mjs';

const RETRY_LINE = '[almamesh] engine.boot_retry error=RuntimeError';
const RECOVERY_CARD = '[data-testid="reset-app-data-button"]';

/**
 * WebKit needs an on-disk profile: a default WebKit context is an ephemeral
 * store that refuses OPFS, and SQLite on OPFS is the app's only store. macOS
 * WebKit shares OPFS across profiles, so the origin is wiped first.
 */
const test = base.extend({
  context: async ({ browserName, context, baseURL, viewport, userAgent, serviceWorkers }, provide) => {
    if (browserName !== 'webkit') {
      await provide(context);
      return;
    }
    const profile = await mkdtemp(join(tmpdir(), 'almamesh-boot-retry-'));
    const persistent = await webkit.launchPersistentContext(profile, {
      baseURL, viewport, userAgent, serviceWorkers, headless: true,
    });
    try {
      const page = persistent.pages()[0] ?? (await persistent.newPage());
      await page.goto('/robots.txt');
      await page.evaluate(async () => {
        const root = await navigator.storage.getDirectory();
        const names: string[] = [];
        for await (const name of (root as unknown as { keys(): AsyncIterable<string> }).keys()) names.push(name);
        for (const name of names) await root.removeEntry(name, { recursive: true });
        for (const db of await indexedDB.databases()) if (db.name) indexedDB.deleteDatabase(db.name);
        localStorage.clear();
      });
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

async function typeSections(page: Page, testId: string, digits: string, trailing?: string): Promise<void> {
  await page.locator(`[data-testid="${testId}"] [role="spinbutton"]`).first().click();
  await page.keyboard.type(digits, { delay: 50 });
  if (trailing) await page.keyboard.type(trailing, { delay: 50 });
}

async function submitReferenceBirth(page: Page): Promise<void> {
  await page.getByTestId('name-input').fill('Reference Native');
  await page.getByTestId('next-button').click();
  await typeSections(page, 'birth-date-input', '08081988');
  await page.getByTestId('next-button').click();
  await page.getByTestId('location-search-input').fill('Bengaluru');
  await page.locator('[role="option"]').first().click();
  await page.getByTestId('next-button').click();
  await typeSections(page, 'birth-time-input', '0644', 'a');
  await page.getByTestId('confidence-option-exact').click();
  await page.getByTestId('next-button').click();
  await page.getByTestId('skip-life-events-button').click();
}

const FAULTS = [
  { label: 'a wasm trap', arm: true },
  { label: 'a wasm trap wrapped in a Pyodide package load error', arm: 'wrapped' },
  { label: 'a Pyodide runtime that exited during start-up (Fatal Python error)', arm: 'exit' },
] as const;

for (const fault of FAULTS) {
  test(`${fault.label} on the first boot is retried once in a fresh Worker; the chart renders`, async ({ page }) => {
    const consoleLines: string[] = [];
    const consoleErrors: string[] = [];
    page.on('console', (message) => {
      consoleLines.push(message.text());
      if (message.type() === 'error') consoleErrors.push(message.text());
    });
    page.on('pageerror', (error) => consoleErrors.push(`pageerror: ${error.message}`));

    await page.addInitScript(({ card, arm }) => {
      (window as unknown as Record<string, unknown>).__almameshArmBootWasmFault = arm;
      // Record the recovery card if it is EVER rendered, not only at the end.
      const seen = (): void => {
        if (document.querySelector(card)) (window as unknown as Record<string, unknown>).__recoveryCardSeen = true;
      };
      new MutationObserver(seen).observe(document, { childList: true, subtree: true });
    }, { card: RECOVERY_CARD, arm: fault.arm });

    await page.goto('/onboarding');
    await expect.poll(() => consoleLines.filter((line) => line.includes('engine.boot_retry'))).toEqual([RETRY_LINE]);

    await submitReferenceBirth(page);

    await passOnboardingAiStep(page, { timeout: 120_000 });
    await expect(page.getByTestId('chart-visualization').first()).toBeVisible();
    await page.screenshot({ path: test.info().outputPath(`dashboard-after-boot-retry-${fault.arm === true ? 'trap' : fault.arm}.png`) });

    expect(consoleLines.filter((line) => line.includes('engine.boot_retry'))).toEqual([RETRY_LINE]);
    expect(await page.evaluate(() => (window as unknown as Record<string, unknown>).__recoveryCardSeen ?? false)).toBe(false);
    expect(consoleErrors).toEqual([]);
  });
}

/**
 * CI run 38267574533 (memory-budget lane): one OPFS step in the sync Worker
 * stalled under load, the first boot failed as transient, and the provider
 * booted again on its own 250 ms later. Onboarding had been awaiting that
 * first attempt and parked on CHART_GEN_001 with the engine ready behind it.
 * Here the first trust-root fetch never answers, so the sync's stall watchdog
 * fails the first boot the same transient way while the form is submitted.
 */
test('a first engine sync that stalls while onboarding waits follows the automatic retry to the chart', async ({ page, context, browserName }) => {
  test.skip(browserName !== 'chromium', 'routes the sync Worker fetch; WebKit runs the wasm-trap cases');
  const consoleErrors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  page.on('pageerror', (error) => consoleErrors.push(`pageerror: ${error.message}`));
  let trustRootRequests = 0;
  await context.route('**/public.key', async (route) => {
    trustRootRequests += 1;
    if (trustRootRequests === 1) return; // never answered: the first boot stalls
    await route.continue();
  });
  await page.addInitScript((card) => {
    const seen = (): void => {
      if (document.querySelector(card)) (window as unknown as Record<string, unknown>).__recoveryCardSeen = true;
    };
    new MutationObserver(seen).observe(document, { childList: true, subtree: true });
  }, RECOVERY_CARD);

  await page.goto('/onboarding');
  await submitReferenceBirth(page);

  await passOnboardingAiStep(page, { timeout: 150_000 });
  await expect(page.getByTestId('chart-visualization').first()).toBeVisible();
  expect(trustRootRequests).toBeGreaterThanOrEqual(2);
  expect(await page.evaluate(() => (window as unknown as Record<string, unknown>).__recoveryCardSeen ?? false)).toBe(false);
  expect(consoleErrors).toEqual([]);
});

interface RecoveryRequest {
  id: number;
  kind: string;
  worker: number;
  referenceInstant?: string;
}

interface RecoveryProof {
  document: string;
  workers: number;
  ready: number[];
  terminated: number[];
  armed: boolean;
  injected: RecoveryRequest[];
  sent: RecoveryRequest[];
}

async function recoveryProof(page: Page): Promise<RecoveryProof> {
  return page.evaluate(() => (window as unknown as { __almameshRecoveryProof: RecoveryProof }).__almameshRecoveryProof);
}

test('a post-ready correlated fatal requires Retry, then a fresh real Worker renders a chart and historical transits without reload', async ({ page }, testInfo) => {
  const consoleErrors: string[] = [];
  const bootRetries: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
    if (message.text().includes('engine.boot_retry')) bootRetries.push(message.text());
  });
  page.on('pageerror', (error) => consoleErrors.push(`pageerror: ${error.message}`));

  // Intercept one correlated reply at the browser's public Worker boundary.
  // Both boots and every successful computation still run the actual Worker.
  // No product hook, fake chart, or persisted-chart success can satisfy this.
  await page.addInitScript(() => {
    interface Request { id: number; kind: string; input?: { referenceInstant?: string } }
    interface ProofRequest { id: number; kind: string; worker: number; referenceInstant?: string }
    const proof = {
      document: crypto.randomUUID(), workers: 0, ready: [] as number[], terminated: [] as number[],
      armed: false, injected: [] as ProofRequest[], sent: [] as ProofRequest[],
    };
    (window as unknown as Record<string, unknown>).__almameshRecoveryProof = proof;
    const NativeWorker = window.Worker;
    window.Worker = new Proxy(NativeWorker, {
      construct(Target, args: [string | URL, WorkerOptions?]) {
        const worker = Reflect.construct(Target, args) as Worker;
        if (!String(args[0]).includes('chartWorker')) return worker;
        const index = ++proof.workers;
        worker.addEventListener('message', (event: MessageEvent<{ ok?: boolean; kind?: string }>) => {
          if (event.data?.ok && event.data.kind === 'boot') proof.ready.push(index);
        });
        const postMessage = worker.postMessage.bind(worker);
        worker.postMessage = ((request: Request, transfer?: Transferable[] | StructuredSerializeOptions) => {
          const fact: ProofRequest = { id: request.id, kind: request.kind, worker: index };
          if (request.input?.referenceInstant) fact.referenceInstant = request.input.referenceInstant;
          if (proof.armed && proof.injected.length === 0 && request.kind === 'generateChart' && proof.ready.includes(index)) {
            proof.armed = false;
            proof.injected.push(fact);
            queueMicrotask(() => worker.dispatchEvent(new MessageEvent('message', {
              data: { ok: false, id: request.id, error: 'Out of bounds memory access', errorName: 'RuntimeError' },
            })));
            return;
          }
          proof.sent.push(fact);
          if (Array.isArray(transfer)) postMessage(request, transfer);
          else postMessage(request, transfer);
        }) as Worker['postMessage'];
        const terminate = worker.terminate.bind(worker);
        worker.terminate = () => { proof.terminated.push(index); terminate(); };
        return worker;
      },
    });
  });

  await page.goto('/onboarding');
  await expect.poll(async () => (await recoveryProof(page)).ready).toEqual([1]);
  const originalDocument = (await recoveryProof(page)).document;
  await page.evaluate(() => { (window as unknown as { __almameshRecoveryProof: RecoveryProof }).__almameshRecoveryProof.armed = true; });
  await submitReferenceBirth(page);
  await expect(page.getByTestId('retry-generation-button')).toBeVisible();
  await expect(page.getByTestId('reset-app-data-button')).toBeVisible();
  expect(page.url()).toContain('/onboarding');
  expect(await page.getByTestId('chart-visualization').count()).toBe(0);
  const failed = await recoveryProof(page);
  expect(failed.workers).toBe(1);
  expect(failed.injected).toHaveLength(1);
  expect(failed.injected[0]).toMatchObject({ worker: 1, kind: 'generateChart' });
  expect(Number.isSafeInteger(failed.injected[0].id)).toBe(true);
  expect(failed.sent.some((request) => request.kind === 'generateChart')).toBe(false);
  expect(bootRetries).toEqual([]);
  // The controlled onboarding error deliberately logs this one stable code.
  // Require its exact cardinality here; every additional console/page error
  // remains fatal throughout recovery and the subsequent computation.
  expect(consoleErrors).toEqual(['[almamesh:error:app.typed_error]']);

  await page.getByTestId('retry-generation-button').click();
  await passOnboardingAiStep(page, { timeout: 120_000 });
  await expect(page.getByTestId('chart-visualization').first()).toBeVisible();
  const recovered = await recoveryProof(page);
  expect(recovered.document).toBe(originalDocument);
  expect(recovered.workers).toBe(2);
  expect(recovered.ready).toEqual([1, 2]);
  expect(recovered.terminated).toContain(1);
  expect(recovered.injected).toEqual(failed.injected);
  expect(recovered.sent.some((request) => request.worker === 2 && request.kind === 'generateChart')).toBe(true);

  // A date computation after Retry proves the new engine can do fresh work.
  await page.getByTestId('dashboard-time-travel-button').click();
  await page.getByTestId('time-travel-tab-month').click();
  await page.getByTestId('time-travel-month').selectOption('03');
  await page.getByTestId('time-travel-month-year').selectOption('2019');
  // Every trip needs a place (3f338a94): Go waits until the offered birth place is confirmed.
  await expect(page.getByTestId('time-travel-go')).toBeDisabled();
  await page.getByTestId('time-travel-where-suggestion').click();
  await page.getByTestId('time-travel-go').click();
  await expect(page.getByTestId('time-travel-sheet')).toBeHidden();
  await expect(page.getByTestId('dashboard-time-travel-banner')).toContainText('March');
  await expect(page.getByTestId('dashboard-time-travel-banner')).toContainText('2019');
  const transits = page.getByTestId('time-travel-moment-transits');
  await expect(transits).toBeVisible();
  const saturn = transits.getByTestId('gochara-table').getByRole('row')
    .filter({ has: page.getByRole('cell', { name: 'Saturn', exact: true }) }).getByRole('cell').nth(1);
  await expect(saturn).toHaveText('Sagittarius');
  const final = await recoveryProof(page);
  expect(final.document).toBe(originalDocument);
  expect(final.workers).toBe(2);
  expect(final.sent.some((request) => request.worker === 2 && request.kind === 'computePredictive'
    && request.referenceInstant?.startsWith('2019-03'))).toBe(true);
  expect(bootRetries).toEqual([]);
  const proofPath = testInfo.outputPath('post-ready-recovery.json');
  await writeFile(proofPath, JSON.stringify({ ...final, consoleErrors, bootRetries }, null, 2));
  await testInfo.attach('post-ready-recovery', { path: proofPath, contentType: 'application/json' });
  expect(consoleErrors).toEqual(['[almamesh:error:app.typed_error]']);
  await page.screenshot({ path: testInfo.outputPath('dashboard-after-post-ready-recovery.png') });
});

test('a failed engine boot on the dashboard shows the Life Atlas failure and a Retry that recovers, never "still starting up"', async ({ page }, testInfo) => {
  test.setTimeout(420_000);
  const consoleErrors: string[] = [];
  page.on('console', (message) => { if (message.type() === 'error') consoleErrors.push(message.text()); });
  page.on('pageerror', (error) => consoleErrors.push(`pageerror: ${error.message}`));

  await page.goto('/onboarding');
  await submitReferenceBirth(page);
  await passOnboardingAiStep(page, { timeout: 120_000 });
  await expect(page.getByTestId('chart-visualization').first()).toBeVisible();

  // From here on, the FIRST chart Worker of each document answers its boot
  // with a failure the runtime does not retry. The Retry's fresh Worker is real.
  await page.addInitScript(() => {
    let workers = 0;
    const NativeWorker = window.Worker;
    window.Worker = new Proxy(NativeWorker, {
      construct(Target, args: [string | URL, WorkerOptions?]) {
        const worker = Reflect.construct(Target, args) as Worker;
        if (!String(args[0]).includes('chartWorker') || ++workers > 1) return worker;
        const postMessage = worker.postMessage.bind(worker);
        worker.postMessage = ((request: { id: number; kind: string }, transfer?: Transferable[] | StructuredSerializeOptions) => {
          if (request.kind === 'boot') {
            queueMicrotask(() => worker.dispatchEvent(new MessageEvent('message', {
              data: { ok: false, id: request.id, error: 'Program terminated with exit(1)' },
            })));
            return;
          }
          if (Array.isArray(transfer)) postMessage(request, transfer);
          else postMessage(request, transfer);
        }) as Worker['postMessage'];
        return worker;
      },
    });
  });
  await page.goto('/dashboard');

  const atlas = page.getByTestId('life-atlas');
  const retry = atlas.getByTestId('life-atlas-retry');
  await expect(retry, 'a failed boot must surface a Retry, not "still starting up"').toBeVisible({ timeout: 120_000 });
  await expect(atlas.getByTestId('life-atlas-gate')).toContainText('Program terminated with exit(1)');
  await expect(atlas).not.toContainText('still starting up');
  await page.screenshot({ path: testInfo.outputPath('life-atlas-engine-failed.png'), fullPage: true });

  await retry.click();
  await expect(atlas.getByText(/^As of /)).toBeVisible({ timeout: 240_000 });
  await page.screenshot({ path: testInfo.outputPath('life-atlas-after-retry.png'), fullPage: true });
  expect(consoleErrors).toEqual([]);
});
