import type { ReactElement } from 'react';
import { useTranslation } from 'react-i18next';

/**
 * WHAT it computes — the real engine outputs as a grid of cards, grounding the
 * "faithful Vedic chart" claim in concrete deliverables (planets, nakshatras,
 * dashas, vargas, transits, strength systems).
 */
export function WhatSection(): ReactElement {
  const { t } = useTranslation('landing');
  const items = t('what.items', { returnObjects: true }) as string[];

  return (
    <section className="relative mx-auto w-full max-w-6xl px-5 py-24 md:px-8" aria-labelledby="what-title">
      <div className="mb-14 max-w-2xl">
        <p className="mb-3 text-xs uppercase tracking-[0.24em] text-accent-gold">01 — The chart</p>
        <h2
          id="what-title"
          className="font-display text-3xl font-light leading-tight text-text-primary sm:text-4xl/10"
        >
          {t('what.title')}
        </h2>
        <p className="mt-4 text-base leading-relaxed text-text-secondary">{t('what.intro')}</p>
      </div>

      <ul className="grid grid-cols-1 gap-px overflow-hidden rounded-xl border border-ui-border bg-ui-border sm:grid-cols-2 lg:grid-cols-3">
        {items.map((item, i) => (
          <li
            key={item}
            className="group flex items-start gap-4 bg-background-secondary p-6 transition-colors hover:bg-background-tertiary"
          >
            <span
              aria-hidden="true"
              className="mt-0.5 font-mono text-sm text-accent-gold/70 transition-colors group-hover:text-accent-gold"
            >
              {String(i + 1).padStart(2, '0')}
            </span>
            <span className="text-base leading-snug text-text-body">{item}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}
