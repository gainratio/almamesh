import { test, expect } from '@playwright/test';

/**
 * The landing page must fit a phone with no sideways scroll.
 *
 * Bug that prompted this lane: at 390 px the top bar (wordmark, GitHub link,
 * language select, "Generate my chart") measured ~433 px, so the nav CTA was
 * clipped off the right edge and the whole page scrolled horizontally.
 *
 * Run in every UI language: es/pt labels are longer than en, so an English-only
 * check would pass while Spanish and Portuguese visitors still overflow.
 */

const LOCALES = [
  { lang: 'en', locale: 'en-US', cta: 'Generate my chart' },
  { lang: 'es', locale: 'es-ES', cta: 'Generar mi carta' },
  { lang: 'pt', locale: 'pt-BR', cta: 'Gerar meu mapa' },
] as const;

for (const { lang, locale, cta } of LOCALES) {
  test.describe(`landing header fits a phone (${lang})`, () => {
    test.use({ locale });

    test.beforeEach(async ({ page }) => {
      await page.goto('/welcome');
      // Wait for the translated label, not just `<html lang>`: the attribute
      // flips before the locale's strings render, and measuring in between
      // reads the narrower placeholder layout.
      await expect(page.locator('html')).toHaveAttribute('lang', new RegExp(`^${lang}`));
      await expect(page.getByTestId('landing-nav-cta')).toHaveText(cta);
      await page.evaluate(() => document.fonts.ready.then(() => undefined));
    });

    test('never scrolls horizontally', async ({ page }) => {
      // Compare against the DEVICE width, not only innerWidth: under mobile
      // emulation an over-wide page widens the layout viewport (innerWidth grew
      // to 434 at a 320 px device), so `scrollWidth <= innerWidth` alone passes
      // while the phone shows a zoomed-out or sideways-scrolling page.
      const width = page.viewportSize()?.width ?? 0;
      const { scrollWidth, innerWidth } = await page.evaluate(() => ({
        scrollWidth: document.documentElement.scrollWidth,
        innerWidth: window.innerWidth,
      }));
      expect(innerWidth).toBe(width);
      expect(scrollWidth).toBeLessThanOrEqual(innerWidth);
    });

    test('keeps the nav CTA fully inside the viewport', async ({ page }) => {
      const box = await page.getByTestId('landing-nav-cta').boundingBox();
      const width = page.viewportSize()?.width ?? 0;
      expect(box).not.toBeNull();
      expect(box!.x).toBeGreaterThanOrEqual(0);
      expect(box!.x + box!.width).toBeLessThanOrEqual(width);
    });

    test('keeps every header control inside the viewport', async ({ page }) => {
      const width = page.viewportSize()?.width ?? 0;
      const outside = await page.evaluate((viewportWidth) => {
        const controls = Array.from(document.querySelectorAll('header a, header select'));
        return controls
          .filter((el) => {
            const r = el.getBoundingClientRect();
            return r.width > 0 && (r.left < 0 || r.right > viewportWidth);
          })
          .map((el) => el.getAttribute('aria-label') ?? el.textContent?.trim() ?? '');
      }, width);
      expect(outside).toEqual([]);
    });
  });
}
