import type { Locator, Page } from '@playwright/test';

const POLL_MS = 250;
const SNAPSHOT_TIMEOUT_MS = 2_000;

interface EngineSnapshot {
  stage: string | null;
  error: string | null;
  gate: string | null;
}

/** The engine's published boot stage/error and the Life Atlas gate text, bounded. */
async function engineSnapshot(page: Page): Promise<EngineSnapshot | 'unavailable'> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      page.evaluate((): EngineSnapshot => {
        const w = window as unknown as { __ALMAMESH_STAGE__?: string; __ALMAMESH_ERROR__?: string };
        const gate = document.querySelector('[data-testid="life-atlas-gate"]');
        return { stage: w.__ALMAMESH_STAGE__ ?? null, error: w.__ALMAMESH_ERROR__ ?? null, gate: gate?.textContent ?? null };
      }),
      new Promise<'unavailable'>((resolve) => { timer = setTimeout(() => resolve('unavailable'), SNAPSHOT_TIMEOUT_MS); }),
    ]);
  } catch {
    return 'unavailable';
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Wait for today's Life Atlas reading. Fails at once, naming the engine's stage
 * and error, when the Atlas shows an engine failure (its Retry) instead of
 * waiting out the whole budget; a timeout carries the same snapshot.
 */
export async function waitForLifeAtlasAsOf(page: Page, timeoutMs = 240_000): Promise<Locator> {
  const atlas = page.getByTestId('life-atlas');
  const asOf = atlas.getByText(/^As of /);
  const retry = atlas.getByTestId('life-atlas-retry');
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await asOf.isVisible()) return asOf;
    if (await retry.isVisible()) {
      throw new Error(`Life Atlas shows an engine failure: ${JSON.stringify(await engineSnapshot(page))}`);
    }
    if (Date.now() >= deadline) {
      throw new Error(`Life Atlas "As of" not visible after ${timeoutMs} ms: ${JSON.stringify(await engineSnapshot(page))}`);
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
}
