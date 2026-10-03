import { useChartLibraryStore } from '@almamesh/store'
import { usePrewarmEngineOnIntent, type PrewarmEngineHandlers } from './usePrewarmEngineOnIntent'

/**
 * The single source of truth for what a landing CTA should DO, so the three
 * splash CTAs (nav, hero, final) stay consistent in target, label, and
 * engine-prewarm behaviour.
 *
 * - First-time visitor (no local chart): route to `/onboarding`, show the
 *   "Generate my chart" label, and carry `usePrewarmEngineOnIntent()` so the
 *   ~38 MB engine starts syncing on the first sign of intent (hover/focus/click).
 * - Returning visitor (a chart already exists locally): route straight to
 *   `/dashboard` to open the existing chart, show the "Open my chart" label, and
 *   DO NOT prewarm — there is no engine work to warm up for a saved chart.
 *
 * The boot barrier hydrates chart state from SQLite before this hook renders.
 * Subscribing to the chart map keeps every mounted CTA correct after an import,
 * reset, or cross-tab refresh without a second durable route flag.
 */
export interface ChartCta {
  /** Route target: `/dashboard` for a returning visitor, else `/onboarding`. */
  readonly to: string
  /** i18n key suffix inside each CTA's own block (`cta` or `ctaReturning`). */
  readonly labelKey: 'cta' | 'ctaReturning'
  /** Engine-prewarm handlers to spread onto the CTA — empty for a saved chart. */
  readonly intentProps: Partial<PrewarmEngineHandlers>
}

export function useChartCta(): ChartCta {
  // Rules of hooks: always call the prewarm hook; only SPREAD it when warming
  // up actually helps (a first-time visitor about to generate a chart).
  const prewarm = usePrewarmEngineOnIntent()
  const hasChart = useChartLibraryStore((state) => Object.keys(state.charts).length > 0)

  if (hasChart) {
    return { to: '/dashboard', labelKey: 'ctaReturning', intentProps: {} }
  }
  return { to: '/onboarding', labelKey: 'cta', intentProps: prewarm }
}
