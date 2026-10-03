import type { ReactElement } from 'react';
import { useTranslation } from 'react-i18next';

/**
 * WHO it's for — the curious, the privacy-conscious, skeptics who want a
 * verifiable engine, and practitioners who want a professional-grade tool free.
 */
export function WhoSection(): ReactElement {
  const { t } = useTranslation('landing');
  const items = t('who.items', { returnObjects: true }) as string[];

  return (
    <section
      className="relative border-y border-ui-border/60 bg-background-darker py-24"
      aria-labelledby="who-title"
    >
      <div className="mx-auto w-full max-w-6xl px-5 md:px-8">
        <div className="mb-14 max-w-2xl">
          <p className="mb-3 text-xs uppercase tracking-[0.24em] text-accent-gold">05 — Who it's for</p>
          <h2
            id="who-title"
            className="font-display text-3xl font-light leading-tight text-text-primary sm:text-4xl/10"
          >
            {t('who.title')}
          </h2>
        </div>

        <div className="grid grid-cols-1 gap-6 sm:grid-cols-2">
          {items.map((item, i) => (
            <div
              key={item}
              className="flex items-start gap-5 rounded-xl border border-ui-border bg-background-secondary p-6 transition-colors hover:border-accent-gold/40"
            >
              <span className="font-display text-3xl leading-none text-accent-gold/60" aria-hidden="true">
                {String(i + 1).padStart(2, '0')}
              </span>
              <p className="text-base leading-relaxed text-text-body">{item}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
