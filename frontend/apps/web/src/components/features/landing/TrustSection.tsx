import type { ReactElement } from 'react';
import { useTranslation } from 'react-i18next';

/**
 * The engine you can trust — Skyfield + DE421, sub-arcsecond external validation,
 * deterministic byte-identical compute, and the load-bearing honesty line: the
 * engine is the source of truth, the AI narrates and never invents.
 */
export function TrustSection(): ReactElement {
  const { t } = useTranslation('landing');
  const points = t('trust.points', { returnObjects: true }) as string[];

  return (
    <section
      className="relative border-y border-ui-border/60 bg-background-darker py-24"
      aria-labelledby="trust-title"
    >
      <div className="mx-auto w-full max-w-5xl px-5 md:px-8">
        <div className="mb-12 max-w-2xl">
          <p className="mb-3 text-xs uppercase tracking-[0.24em] text-accent-gold">07 — The engine</p>
          <h2
            id="trust-title"
            className="font-display text-3xl font-light leading-tight text-text-primary sm:text-4xl/10"
          >
            {t('trust.title')}
          </h2>
          <p className="mt-4 text-lg leading-relaxed text-text-secondary">{t('trust.body')}</p>
        </div>

        <ul className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          {points.map((point) => (
            <li
              key={point}
              className="flex items-start gap-3 rounded-lg border border-ui-border bg-background-secondary/60 p-5"
            >
              <span aria-hidden="true" className="mt-1 text-accent-gold">
                &#10022;
              </span>
              <span className="text-base leading-relaxed text-text-body">{point}</span>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
