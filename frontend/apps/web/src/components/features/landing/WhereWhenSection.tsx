import type { ReactElement } from 'react';
import { useTranslation } from 'react-i18next';

/**
 * WHERE / WHEN — every OS, installable PWA, offline after first load; available
 * now, free, no waitlist. Two short statements set as a confident diptych.
 */
export function WhereWhenSection(): ReactElement {
  const { t } = useTranslation('landing');

  return (
    <section className="relative mx-auto w-full max-w-6xl px-5 py-24 md:px-8" aria-labelledby="wherewhen-title">
      <div className="mb-14 max-w-2xl">
        <p className="mb-3 text-xs uppercase tracking-[0.24em] text-accent-gold">05 — Where &amp; when</p>
        <h2
          id="wherewhen-title"
          className="font-display text-3xl font-light leading-tight text-text-primary sm:text-4xl/10"
        >
          {t('whereWhen.title')}
        </h2>
      </div>

      <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
        <div className="rounded-xl border border-ui-border bg-background-secondary p-8">
          <p className="font-mono text-xs uppercase tracking-[0.24em] text-accent-gold/70">Where</p>
          <p className="mt-4 text-lg leading-relaxed text-text-body">{t('whereWhen.where')}</p>
        </div>
        <div className="rounded-xl border border-accent-gold/30 bg-accent-gold/5 p-8">
          <p className="font-mono text-xs uppercase tracking-[0.24em] text-accent-gold/70">When</p>
          <p className="mt-4 text-lg leading-relaxed text-text-body">{t('whereWhen.when')}</p>
        </div>
      </div>
    </section>
  );
}
