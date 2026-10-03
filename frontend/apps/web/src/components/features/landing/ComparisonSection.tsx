import type { ReactElement } from 'react';
import { useTranslation } from 'react-i18next';

interface ComparisonRow {
  readonly a: string;
  readonly b: string;
}

/**
 * WHY we're different — framed by the quiet "a gift, not a scheme" anchor line,
 * then a bold side-by-side ledger contrasting AlmaMesh with the *pattern* of a
 * typical paid astrology site (never naming brands). Each row stacks on mobile.
 */
export function ComparisonSection(): ReactElement {
  const { t } = useTranslation('landing');
  const rows = t('why.rows', { returnObjects: true }) as ComparisonRow[];

  return (
    <section
      className="relative border-y border-ui-border/60 bg-background-darker py-24"
      aria-labelledby="why-title"
    >
      <div className="mx-auto w-full max-w-5xl px-5 md:px-8">
        <p className="mb-3 text-xs uppercase tracking-[0.24em] text-accent-gold">03 — The difference</p>
        <h2
          id="why-title"
          className="max-w-3xl font-display text-3xl font-light leading-tight text-text-primary sm:text-4xl/10"
        >
          {t('why.title')}
        </h2>

        {/* The anchor: a quiet framing line, set apart like a margin note. */}
        <p
          className="mt-6 max-w-2xl border-l-2 border-accent-gold/50 pl-5 font-display text-lg italic leading-relaxed text-text-secondary"
          data-testid="why-anchor"
        >
          {t('why.anchor')}
        </p>

        {/* The ledger. Column headers visible from sm up; rows label inline on mobile. */}
        <div className="mt-12 overflow-hidden rounded-xl border border-ui-border">
          <div className="hidden grid-cols-2 border-b border-ui-border bg-background-secondary sm:grid">
            <div className="px-6 py-4 font-display text-lg text-accent-gold">{t('why.colA')}</div>
            <div className="border-l border-ui-border px-6 py-4 font-display text-lg text-text-muted">
              {t('why.colB')}
            </div>
          </div>

          <ul>
            {rows.map((row, i) => (
              <li
                key={row.a}
                className={`grid grid-cols-1 sm:grid-cols-2 ${
                  i % 2 === 0 ? 'bg-background-primary/40' : 'bg-transparent'
                }`}
              >
                <div className="border-b border-ui-border/60 px-6 py-5 sm:border-b-0">
                  <span className="mb-1 block text-[0.65rem] uppercase tracking-[0.2em] text-accent-gold/70 sm:hidden">
                    {t('why.colA')}
                  </span>
                  <span className="font-medium leading-snug text-text-body">{row.a}</span>
                </div>
                <div className="border-b border-ui-border/60 px-6 py-5 sm:border-b-0 sm:border-l sm:border-ui-border">
                  <span className="mb-1 block text-[0.65rem] uppercase tracking-[0.2em] text-text-muted sm:hidden">
                    {t('why.colB')}
                  </span>
                  <span className="leading-snug text-text-muted">{row.b}</span>
                </div>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </section>
  );
}
