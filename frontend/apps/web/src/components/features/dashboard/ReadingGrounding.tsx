/**
 * ReadingGrounding — a quiet, closed-by-default explainer of WHY this reading
 * is trustworthy. AlmaMesh is anti-scam by design: the ENGINE (deterministic,
 * externally-validated astronomy) is the accurate part, and the AI only
 * NARRATES it. So this affordance makes NO accuracy claim about the AI model.
 * It states four factual points (all true per the repo's integrity mandate):
 *
 *   1. The chart is deterministic astronomy computed on the user's device.
 *   2. Positions are externally validated (Skyfield + JPL DE421, sub-arcsecond
 *      vs. astropy + JPL Horizons; no Swiss Ephemeris, no fudge factors).
 *   3. The AI narration is grounded — it reads back the exact engine-computed
 *      placements, not a generic pre-written horoscope.
 *   4. Privacy — without AI nothing leaves the device; with the optional AI on,
 *      the sanitized chart (no name, but planet positions and period dates that
 *      can reveal the birth date) goes to the user's chosen endpoint.
 *
 * It computes NO astrology and makes NO LLM call — pure static, i18n-driven
 * copy. Reuses the shared `Disclosure` primitive (closed by default, opens in
 * place) and the DashboardInterpretation collapsible tokens so it sits quietly
 * beside the reading.
 */

import type { ReactElement } from 'react';
import { useTranslation } from 'react-i18next';
import { Disclosure } from '../../ui/Disclosure';

/** The four honest grounding points, in narrative order. */
const POINT_KEYS = [
  'grounding.point_engine',
  'grounding.point_validated',
  'grounding.point_grounded',
  'grounding.point_privacy',
] as const;

export function ReadingGrounding(): ReactElement {
  const { t } = useTranslation('dashboard');

  return (
    <div data-testid="reading-grounding">
      <Disclosure
        summary={
          <span className="inline-flex items-center gap-2 text-sm font-medium text-text-secondary">
            <svg
              aria-hidden="true"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              className="h-4 w-4 text-accent-gold/70"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z"
              />
            </svg>
            {t('grounding.summary')}
          </span>
        }
        toggleLabel={t('interpretation.expand')}
        toggleLabelOpen={t('interpretation.collapse')}
        className="rounded-xl border border-ui-border/70 bg-background-secondary/40 transition-colors hover:border-accent-gold/40 hover:bg-background-secondary/60"
        triggerClassName="px-4 py-3"
        contentClassName="mx-4 border-t border-ui-border/70 pb-4 pt-3"
      >
        <p className="text-sm leading-relaxed text-text-secondary">{t('grounding.intro')}</p>
        <ul className="mt-3 space-y-2.5">
          {POINT_KEYS.map((key) => (
            <li
              key={key}
              className="flex gap-2.5 text-sm leading-relaxed text-text-secondary"
            >
              <span
                aria-hidden="true"
                className="mt-[0.55rem] h-1 w-1 shrink-0 rounded-full bg-accent-gold/70"
              />
              <span>{t(key)}</span>
            </li>
          ))}
        </ul>
      </Disclosure>
    </div>
  );
}
