import { Suspense, type ReactElement } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { cn, buttonVariants } from '../../ui';
import { useChartCta } from '../../../hooks/useChartCta';
import { HeroForceField } from './HeroForceField';
import { GITHUB_URL, GithubMark } from './LandingFooter';
import { lazyWithRetry } from '../../../lib/lazyWithRetry';

// Lazy so the landing chunk stays small: the restore flow (backup service,
// dialogs) only loads for a first-time visitor, after the hero has painted.
const RestoreFromBackup = lazyWithRetry(async () => {
  const { RestoreFromBackup: Restore } = await import('../backup/RestoreFromBackup');
  return { default: () => <Restore className="mt-2" /> };
}, 'RestoreFromBackup');

/**
 * Above-the-fold hero: the approved headline + subhead + the single committing
 * CTA, set over the signature force-field (static fixture, no engine). The text
 * paints immediately; the WebGL scene hydrates lazily behind it.
 *
 * The CTA is adaptive (`useChartCta`): a first-time visitor gets "Generate my
 * chart" → onboarding (prewarming the engine on intent); a returning visitor
 * with a saved chart gets "Open my chart" → straight to the dashboard.
 *
 * A first-time visitor also gets "Restore from a backup": someone moving to a
 * new phone restores their file here instead of creating a chart first.
 */
export function Hero(): ReactElement {
  const { t } = useTranslation('landing');
  const { to, labelKey, intentProps } = useChartCta();

  const whatItems = t('what.items', { returnObjects: true }) as string[];

  return (
    <section className="relative isolate overflow-hidden">
      {/* Decorative force-field backdrop (engine-free, aria-hidden). */}
      <HeroForceField />

      {/* Subtle architectural celestial astrolabe rings so the observatory atmosphere
          shines even before WebGL hydrates or in headless/reduced-motion views. */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 flex items-center justify-center overflow-hidden"
      >
        <div className="h-[680px] w-[680px] rounded-full border border-accent-gold/15 bg-[radial-gradient(circle_at_50%_50%,rgba(201,162,75,0.10),rgba(58,79,176,0.08)_45%,transparent_72%)]" />
        <div className="absolute h-[500px] w-[500px] rounded-full border border-dashed border-accent-gold/20" />
        <div className="absolute h-[340px] w-[340px] rounded-full border border-accent-indigo/25" />
      </div>

      {/* Vertical vignette: darker top-and-bottom to seat the hero in the page. */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 bg-gradient-to-b from-background-primary/40 via-background-primary/15 to-background-primary"
      />

      {/* Radial scrim centered on the text block: darkest directly behind the
          headline/subhead (over the force-field's bright core) and fading to
          transparent toward the edges, so the copy stays legible while the
          animation still shows through around it. Token-tinted, no hardcoded hex. */}
      <div
        aria-hidden="true"
        data-testid="hero-text-scrim"
        className="pointer-events-none absolute inset-0 bg-background-primary/75 [mask-image:radial-gradient(ellipse_54%_38%_at_50%_32%,#000_0%,#000_30%,transparent_72%)] [-webkit-mask-image:radial-gradient(ellipse_54%_38%_at_50%_32%,#000_0%,#000_30%,transparent_72%)]"
      />

      <div className="relative mx-auto flex min-h-[88vh] w-full max-w-6xl flex-col items-center justify-center px-5 pt-14 pb-20 text-center md:px-8">
        <p className="mb-5 inline-flex items-center gap-2 rounded-full border border-accent-gold/35 bg-accent-gold/10 px-4 py-1.5 text-xs uppercase tracking-[0.22em] text-accent-gold shadow-[0_0_24px_rgba(201,162,75,0.15)]">
          <span className="h-1.5 w-1.5 rounded-full bg-accent-gold" aria-hidden="true" />
          {t('hero.microcopy')}
        </p>

        <h1 className="max-w-4xl font-display text-4xl font-light leading-[1.06] tracking-tight text-text-primary sm:text-5xl md:text-6xl lg:text-7xl">
          {t('hero.headline')}
        </h1>

        <p className="mt-6 max-w-2xl text-base leading-relaxed text-text-secondary sm:text-lg">
          {t('hero.subhead')}
        </p>

        <div className="mt-8 flex flex-col items-center gap-3.5">
          <Link
            to={to}
            {...intentProps}
            className={cn(
              buttonVariants({ variant: 'primary', size: 'lg' }),
              'px-8 text-base shadow-[0_8px_40px_-8px_rgba(201,162,75,0.55)]',
            )}
            data-testid="hero-cta"
          >
            {t(`hero.${labelKey}`)}
          </Link>

          {labelKey === 'cta' && (
            <Suspense fallback={null}>
              <RestoreFromBackup />
            </Suspense>
          )}

          {/* Goodwill signal: free, open source, no accounts — one click to the repo. */}
          <a
            href={GITHUB_URL}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-2 rounded-full border border-ui-border/60 bg-background-primary/50 px-4 py-1.5 text-xs text-text-secondary backdrop-blur-sm transition-colors hover:border-accent-gold/60 hover:text-accent-gold-bright"
            data-testid="hero-github-badge"
          >
            <GithubMark className="h-3.5 w-3.5" />
            {t('hero.openSource')}
          </a>
        </div>

        {/* Celestial Ephemeris & Sidereal Natal Specimen Deck (aria-hidden, zero h2s) */}
        <div
          aria-hidden="true"
          className="mt-14 w-full max-w-5xl rounded-2xl border border-accent-gold/25 bg-background-secondary/80 p-5 text-left shadow-[0_24px_64px_rgba(0,0,0,0.55)] backdrop-blur-md sm:p-6"
        >
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-ui-border/60 pb-3.5 text-[11px] font-medium uppercase tracking-[0.16em] text-text-muted">
            <div className="flex items-center gap-2.5">
              <span className="h-2 w-2 rounded-full bg-accent-gold shadow-[0_0_8px_rgba(201,162,75,0.8)]" />
              <span className="text-text-secondary">
                SIDEREAL OBSERVATORY · JPL DE421 + SKYFIELD IN WASM
              </span>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <span className="rounded-full border border-accent-gold/30 bg-accent-gold/10 px-2.5 py-0.5 font-mono text-[10px] text-accent-gold">
                LAHIRI AYANAMSA 23°51′11″
              </span>
              <span className="rounded-full border border-ui-border/70 bg-background-primary/60 px-2.5 py-0.5 font-mono text-[10px] text-text-secondary">
                &lt; 0.1″ VS JPL HORIZONS · 0 SERVER CALLS
              </span>
            </div>
          </div>

          <div className="mt-5 grid grid-cols-1 gap-4 lg:grid-cols-3">
            {/* Column 1: Graha Longitudes & Nakshatra Padas */}
            <div className="rounded-xl border border-ui-border/60 bg-background-primary/65 p-4">
              <div className="mb-3 flex items-center justify-between text-[10.5px] font-semibold uppercase tracking-[0.14em] text-accent-gold">
                <span>Rāśi (D1) · Graha Positions</span>
                <span className="font-mono text-text-muted">OPFS SQLite</span>
              </div>
              <div className="space-y-2.5 font-mono text-xs">
                <div className="flex items-center justify-between border-b border-ui-border/40 pb-2">
                  <span className="font-sans font-medium text-text-primary">Lagna (Asc)</span>
                  <span className="text-accent-gold">05° 24′ Mithuna · Mrigashira P3</span>
                </div>
                <div className="flex items-center justify-between border-b border-ui-border/40 pb-2">
                  <span className="font-sans font-medium text-text-primary">Sūrya (Sun)</span>
                  <span className="text-text-secondary">10° 30′ Karka · Pushya P2</span>
                </div>
                <div className="flex items-center justify-between border-b border-ui-border/40 pb-2">
                  <span className="font-sans font-medium text-text-primary">Chandra (Moon)</span>
                  <span className="text-text-secondary">20° 00′ Tulā · Vishakha P1</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="font-sans font-medium text-text-primary">Budha (Mercury)</span>
                  <span className="text-emerald-300">20° 00′ Vṛṣabha · Exalted</span>
                </div>
              </div>
            </div>

            {/* Column 2: Sidereal Chart Yantra & Aspect Geometry */}
            <div className="flex flex-col items-center justify-between rounded-xl border border-accent-gold/25 bg-[radial-gradient(circle_at_50%_50%,rgba(201,162,75,0.12),rgba(13,18,36,0.9)_75%)] p-4 text-center">
              <div className="w-full flex items-center justify-between text-[10.5px] font-semibold uppercase tracking-[0.14em] text-accent-gold">
                <span>D1 – D60 Vargas</span>
                <span className="font-mono text-text-muted">27 Nakshatras</span>
              </div>
              <svg
                viewBox="0 0 160 160"
                className="my-2 h-28 w-28 text-accent-gold"
                fill="none"
              >
                <circle cx="80" cy="80" r="72" stroke="currentColor" strokeOpacity="0.35" strokeWidth="1" />
                <circle cx="80" cy="80" r="52" stroke="currentColor" strokeOpacity="0.25" strokeWidth="1" strokeDasharray="3 3" />
                <rect x="29" y="29" width="102" height="102" stroke="currentColor" strokeOpacity="0.3" strokeWidth="1" />
                <polygon points="80,29 131,80 80,131 29,80" stroke="currentColor" strokeOpacity="0.45" strokeWidth="1.2" />
                <line x1="29" y1="29" x2="131" y2="131" stroke="currentColor" strokeOpacity="0.2" strokeWidth="1" />
                <line x1="131" y1="29" x2="29" y2="131" stroke="currentColor" strokeOpacity="0.2" strokeWidth="1" />
                <circle cx="80" cy="29" r="3.5" fill="currentColor" />
                <circle cx="122" cy="62" r="3" fill="#818cf8" />
                <circle cx="52" cy="115" r="3.5" fill="currentColor" />
                <circle cx="80" cy="80" r="4" fill="currentColor" fillOpacity="0.8" />
              </svg>
              <div className="text-[11px] text-text-secondary">
                North &amp; South Indian Kundali · Shadbala · Ashtakavarga
              </div>
            </div>

            {/* Column 3: Vimshottari Dasha & Rectification Timeline */}
            <div className="rounded-xl border border-ui-border/60 bg-background-primary/65 p-4">
              <div className="mb-3 flex items-center justify-between text-[10.5px] font-semibold uppercase tracking-[0.14em] text-accent-gold">
                <span>Vimshottari Dasha</span>
                <span className="font-mono text-text-muted">Maha · Antar</span>
              </div>
              <div className="space-y-3">
                <div className="rounded-lg border border-accent-gold/25 bg-accent-gold/5 p-2.5">
                  <div className="flex items-center justify-between text-xs font-medium text-text-primary">
                    <span>Guru (Jupiter) Mahādashā</span>
                    <span className="font-mono text-[11px] text-accent-gold">2020 – 2036</span>
                  </div>
                  <div className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-background-secondary">
                    <div className="h-full w-[42%] rounded-full bg-accent-gold" />
                  </div>
                </div>
                <div className="rounded-lg border border-ui-border/50 bg-background-secondary/60 p-2.5">
                  <div className="flex items-center justify-between text-xs font-medium text-text-primary">
                    <span>Maṅgala (Mars) Antardashā</span>
                    <span className="font-mono text-[11px] text-text-secondary">Active Window</span>
                  </div>
                  <div className="mt-1 text-[11px] text-text-muted">
                    Birth-time sensitivity &amp; life-event rectification in-tab
                  </div>
                </div>
              </div>
            </div>
          </div>

          {Array.isArray(whatItems) && whatItems.length > 0 && (
            <div className="mt-4 flex flex-wrap items-center justify-center gap-2 border-t border-ui-border/50 pt-3.5">
              {whatItems.map((item) => (
                <span
                  key={item}
                  className="rounded-full border border-ui-border/60 bg-background-primary/50 px-3 py-1 text-xs text-text-secondary"
                >
                  {item}
                </span>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Fade the hero into the next section. */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-0 bottom-0 h-24 bg-gradient-to-b from-transparent to-background-primary"
      />
    </section>
  );
}
