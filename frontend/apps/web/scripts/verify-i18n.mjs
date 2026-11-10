#!/usr/bin/env node
/**
 * i18n live-drive — REAL browser (headless Chromium via Playwright) against a
 * production build + preview. Proves the offline bundled catalogs, the mounted
 * I18nextProvider, and the language-store → i18next/<html lang> sync actually
 * render translated screens — not just that unit tests pass.
 *
 * Usage:  node scripts/verify-i18n.mjs [baseURL]   (default http://localhost:4173)
 *   Expects a build already previewed at baseURL (vite build && vite preview).
 */
import { chromium } from '@playwright/test'

const BASE_URL = process.argv[2] ?? 'http://localhost:4173'

// The onboarding "Name" step is the first translated surface we assert against
// (it renders directly at /onboarding — no chart needed). We assert the step
// title AND the shared Continue button (common namespace) to prove both catalogs
// load. NOTE: `/` now serves the marketing splash for fresh visitors (the
// landing-splash feature), so we drive /onboarding explicitly rather than `/`.
const ONBOARDING_URL = '/onboarding'
const CASES = [
  { lang: 'en', title: "What's your name?", cta: 'Continue' },
  { lang: 'es', title: '¿Cómo te llamas?', cta: 'Continuar' },
  { lang: 'pt', title: 'Qual é o seu nome?', cta: 'Continuar' },
  { lang: 'hi', title: 'आपका नाम क्या है?', cta: 'जारी रखें' },
]

const PERSIST_KEY = 'almamesh-language'

function fail(msg) {
  console.error(`\n❌ ${msg}`)
  process.exitCode = 1
}

const browser = await chromium.launch()
try {
  for (const { lang, title, cta } of CASES) {
    const context = await browser.newContext()
    // Seed the persisted language BEFORE the app boots (zustand persist format).
    await context.addInitScript(
      ([key, value]) => {
        localStorage.setItem(key, JSON.stringify({ state: { language: value }, version: 0 }))
      },
      [PERSIST_KEY, lang],
    )
    const page = await context.newPage()
    const consoleErrors = []
    page.on('console', (m) => {
      if (m.type() === 'error') consoleErrors.push(m.text())
    })

    await page.goto(`${BASE_URL}${ONBOARDING_URL}`, { waitUntil: 'domcontentloaded' })
    // Wait for the translated welcome heading to render.
    await page.waitForSelector(`text=${title}`, { timeout: 15000 }).catch(() => {})

    const bodyText = await page.evaluate(() => document.body.innerText)
    const htmlLang = await page.evaluate(() => document.documentElement.lang)

    const titleOk = bodyText.includes(title)
    const ctaOk = bodyText.includes(cta)
    const langOk = htmlLang === lang
    if (titleOk && ctaOk && langOk) {
      console.log(`✅ [${lang}] step="${title}"  cta="${cta}"  <html lang>=${htmlLang}`)
    } else {
      if (!titleOk) fail(`[${lang}] expected step title "${title}" — not found on screen`)
      if (!ctaOk) fail(`[${lang}] expected Continue button "${cta}" — not found on screen`)
      if (!langOk) fail(`[${lang}] expected <html lang>="${lang}" but got "${htmlLang}"`)
    }
    if (consoleErrors.length) {
      // Ignore the known benign favicon/network noise; fail on anything else.
      const real = consoleErrors.filter((e) => !/favicon|manifest|404/i.test(e))
      if (real.length) fail(`[${lang}] console errors: ${real.join(' | ')}`)
    }
    await context.close()
  }

  for (const { lang, title, cta } of CASES) {
    const context = await browser.newContext()
    const page = await context.newPage()
    await page.goto(`${BASE_URL}${ONBOARDING_URL}?lang=${lang}`, { waitUntil: 'domcontentloaded' })
    await page.waitForSelector(`text=${title}`, { timeout: 15000 }).catch(() => {})
    const bodyText = await page.evaluate(() => document.body.innerText)
    const htmlLang = await page.evaluate(() => document.documentElement.lang)
    if (bodyText.includes(title) && bodyText.includes(cta) && htmlLang === lang) {
      console.log(`✅ [?lang=${lang}] step="${title}"  cta="${cta}"  <html lang>=${htmlLang}`)
    } else {
      fail(`[?lang=${lang}] URL query boot failed (htmlLang="${htmlLang}", title=${bodyText.includes(title)}, cta=${bodyText.includes(cta)})`)
    }
    await context.close()
  }
} finally {
  await browser.close()
}

if (process.exitCode) {
  console.error('\ni18n live-drive FAILED')
} else {
  console.log('\n✅ i18n live-drive PASSED — offline catalogs render translated screens in en/es/pt/hi')
}
