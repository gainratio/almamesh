/**
 * The onboarding AI step, as seen by the browser gates.
 *
 * Since 2026-10-15 a fresh chart with no AI set up lands on `/onboarding/ai`
 * ("Connect AI" / "Not now") instead of going straight to `/dashboard`. Gates
 * that drive real onboarding and then test the dashboard call this to take the
 * "Not now" path. With AI already set up the step is skipped and this just waits
 * for the dashboard. Resolves to which way the journey went.
 */

export const ONBOARDING_AI_PATH = '/onboarding/ai'

/**
 * @param {import('playwright').Page} page
 * @param {{ timeout: number }} options
 * @returns {Promise<'ai-step' | 'dashboard'>}
 */
export async function passOnboardingAiStep(page, { timeout }) {
  await page.waitForURL(
    (url) => url.pathname === '/dashboard' || url.pathname === ONBOARDING_AI_PATH,
    { timeout },
  )
  if (new URL(page.url()).pathname !== ONBOARDING_AI_PATH) return 'dashboard'
  await page.getByTestId('onboarding-ai-not-now').click({ timeout: 30_000 })
  await page.waitForURL('**/dashboard', { timeout: 30_000 })
  return 'ai-step'
}
