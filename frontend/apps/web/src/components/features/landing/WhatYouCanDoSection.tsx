import type { ReactElement } from 'react';
import { useTranslation } from 'react-i18next';

interface Capability {
  readonly title: string;
  readonly body: string;
}

/**
 * WHAT YOU CAN DO — the feature set reframed as capabilities (verbs): cast,
 * rectify, narrate, predict. Rectification is given deliberate visual weight as
 * a FEATURED honesty card (its own panel, gold "honesty point" badge), because
 * birth-time accuracy is the input that makes or breaks every prediction — the
 * one place AlmaMesh refuses to fake confidence the way paid sites do. The other
 * four capabilities follow as a quieter grid.
 *
 * Engine-respect: like every landing module this is intentionally engine-free —
 * it NEVER imports `@almamesh/browser`, so it adds nothing to the bouncing
 * visitor's download.
 */
export function WhatYouCanDoSection(): ReactElement {
  const { t } = useTranslation('landing');
  const items = t('features.items', { returnObjects: true }) as Capability[];

  return (
    <section
      className="relative mx-auto w-full max-w-6xl px-5 py-24 md:px-8"
      aria-labelledby="features-title"
    >
      <div className="mb-14 max-w-2xl">
        <p className="mb-3 text-xs uppercase tracking-[0.24em] text-accent-gold">02 — What you can do</p>
        <h2
          id="features-title"
          className="font-display text-3xl font-light leading-tight text-text-primary sm:text-4xl/10"
        >
          {t('features.title')}
        </h2>
        <p className="mt-4 text-base leading-relaxed text-text-secondary">{t('features.intro')}</p>
      </div>

      {/* The featured honesty card — rectification gets its own panel, set apart
          with a warm gold wash + lapis spine so the eye lands here first. */}
      <article
        data-testid="features-rectify"
        className="relative overflow-hidden rounded-2xl border border-accent-gold/35 bg-gradient-to-br from-accent-gold/[0.07] via-background-secondary to-background-secondary p-7 shadow-[0_8px_50px_-20px_rgba(201,162,75,0.45)] md:p-10"
      >
        {/* A faint celestial glow anchoring the headline corner. */}
        <div
          aria-hidden="true"
          className="pointer-events-none absolute -right-16 -top-16 h-48 w-48 rounded-full bg-[radial-gradient(circle,rgba(201,162,75,0.18),transparent_70%)]"
        />
        <div className="relative">
          <p className="mb-4 inline-flex items-center gap-2 rounded-full border border-accent-gold/40 bg-accent-gold/10 px-3.5 py-1 text-[0.65rem] font-medium uppercase tracking-[0.22em] text-accent-gold">
            <span className="h-1.5 w-1.5 rounded-full bg-accent-gold" aria-hidden="true" />
            {t('features.rectify.badge')}
          </p>
          <h3 className="max-w-3xl font-display text-2xl font-light leading-snug text-text-primary sm:text-3xl/9">
            {t('features.rectify.title')}
          </h3>
          <p className="mt-5 max-w-3xl border-l-2 border-accent-gold/40 pl-5 text-base leading-relaxed text-text-secondary">
            {t('features.rectify.body')}
          </p>
        </div>
      </article>

      {/* The remaining capabilities — a quieter grid beneath the featured card. */}
      <ul className="mt-6 grid grid-cols-1 gap-px overflow-hidden rounded-xl border border-ui-border bg-ui-border sm:grid-cols-2">
        {items.map((item, i) => (
          <li
            key={item.title}
            className="group flex flex-col gap-2 bg-background-secondary p-6 transition-colors hover:bg-background-tertiary"
          >
            <div className="flex items-baseline gap-3">
              <span
                aria-hidden="true"
                className="font-mono text-sm text-accent-gold/70 transition-colors group-hover:text-accent-gold"
              >
                {String(i + 1).padStart(2, '0')}
              </span>
              <h3 className="font-display text-xl text-text-primary">{item.title}</h3>
            </div>
            <p className="text-base leading-relaxed text-text-secondary">{item.body}</p>
          </li>
        ))}
      </ul>
    </section>
  );
}
