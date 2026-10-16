import { test, expect } from '@playwright/test';

/**
 * The onboarding splash must render consistently across viewports.
 *
 * Owner report that prompted this lane: "mobile splash page different from web
 * in laptop", "too many issues and inconsistent".
 *
 * Two structural defects produced it, and both reproduced at EVERY width:
 *   1. `/onboarding` renders inside `AppLayout` (which owns the sticky header
 *      and wordmark) AND used to render its own `sticky top-0 z-40` header —
 *      a duplicated wordmark plus a dead ghost bar.
 *   2. The page root used `min-h-screen` INSIDE that already-offset shell, so
 *      the document was always 100vh + chrome tall. Measured overflow before
 *      the fix: 105px at 390, 121px at 768 and 1440. `justify-center` then
 *      centred the content against a box taller than the viewport, producing
 *      the large dead gap above the wordmark.
 *
 * These assertions are geometric on purpose — they are the only thing in the
 * repo that can fail on a layout regression.
 */

test.describe('onboarding splash layout', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/onboarding');
    await page.waitForSelector('[data-testid="next-button"]');
  });

  test('never scrolls horizontally', async ({ page }) => {
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - window.innerWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
  });

  test('fits the viewport vertically — no chrome-induced overflow', async ({ page }) => {
    const overflow = await page.evaluate(
      () => document.documentElement.scrollHeight - window.innerHeight,
    );
    // A couple of px of sub-pixel rounding is tolerable; the pre-fix value was
    // 105-121px, i.e. a whole band of chrome.
    expect(overflow).toBeLessThanOrEqual(2);
  });

  test('renders exactly one app header', async ({ page }) => {
    await expect(page.locator('header')).toHaveCount(1);
  });

  test('keeps the primary action above the fold', async ({ page }) => {
    const cta = page.getByTestId('next-button');
    const box = await cta.boundingBox();
    const viewportHeight = page.viewportSize()?.height ?? 0;
    expect(box).not.toBeNull();
    expect(box!.y + box!.height).toBeLessThanOrEqual(viewportHeight);
  });

  test('shows a step indicator that fits its row', async ({ page }) => {
    // Whichever indicator this breakpoint shows (compact counter on a phone,
    // full five-label trail from `sm` up), it must not overflow its container.
    const overflowing = await page.evaluate(() => {
      const rows = Array.from(document.querySelectorAll('main div')).filter((el) => {
        const spans = el.querySelectorAll(':scope > span');
        return (
          spans.length >= 2 &&
          getComputedStyle(el).display.includes('flex') &&
          el.getBoundingClientRect().width > 0
        );
      });
      return rows
        .filter((el) => el.scrollWidth > el.clientWidth + 1)
        .map((el) => el.textContent?.trim() ?? '');
    });
    expect(overflowing).toEqual([]);
  });

  test('keeps the decorative motif inside the viewport', async ({ page }) => {
    // The glow discs were fixed 600px/400px, i.e. wider than any phone, and
    // were clipped asymmetrically by the root `overflow-hidden`.
    const widest = await page.evaluate(() => {
      const glows = Array.from(
        document.querySelectorAll('main ~ div, div.pointer-events-none > div'),
      );
      return Math.max(
        0,
        ...glows.map((el) => Math.round(el.getBoundingClientRect().width)),
      );
    });
    expect(widest).toBeLessThanOrEqual(await page.evaluate(() => window.innerWidth * 1.35));
  });
});

/**
 * Settings → AI renders the shared AI setup panel inside the Settings card.
 * At 390 px three nested padded cards once squeezed the copy into a ~130 px
 * column and shrank the key field; below `sm` the nesting is flattened.
 */
test.describe('Settings → AI layout', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/settings/ai');
    await page.getByTestId('llm-openrouter-key').waitFor();
  });

  test('never scrolls horizontally', async ({ page }) => {
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - window.innerWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
  });

  test('gives the OpenRouter key field at least 300px', async ({ page }) => {
    const box = await page.getByTestId('llm-openrouter-key').boundingBox();
    expect(box).not.toBeNull();
    expect(box!.width).toBeGreaterThanOrEqual(300);
  });
});
