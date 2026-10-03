import type { ReactElement } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { cn, buttonVariants } from '../../ui';
import { useChartCta } from '../../../hooks/useChartCta';
import { HeroForceField } from './HeroForceField';
import { GITHUB_URL, GithubMark } from './LandingFooter';

/**
 * Above-the-fold hero: the approved headline + subhead + the single committing
 * CTA, set over the signature force-field (static fixture, no engine). The text
 * paints immediately; the WebGL scene hydrates lazily behind it.
 *
 * The CTA is adaptive (`useChartCta`): a first-time visitor gets "Generate my
 * chart" → onboarding (prewarming the engine on intent); a returning visitor
 * with a saved chart gets "Open my chart" → straight to the dashboard.
 */
export function Hero(): ReactElement {
  const { t } = useTranslation('landing');
  const { to, labelKey, intentProps } = useChartCta();

  return (
    <section className="relative isolate overflow-hidden">
      {/* Decorative force-field backdrop (engine-free, aria-hidden). */}
      <HeroForceField />

      {/* Vertical vignette: darker top-and-bottom to seat the hero in the page. */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 bg-gradient-to-b from-background-primary/50 via-background-primary/25 to-background-primary"
      />

      {/* Radial scrim centered on the text block: darkest directly behind the
          headline/subhead (over the force-field's bright core) and fading to
          transparent toward the edges, so the copy stays legible while the
          animation still shows through around it. Token-tinted, no hardcoded hex. */}
      <div
        aria-hidden="true"
        data-testid="hero-text-scrim"
        className="pointer-events-none absolute inset-0 bg-background-primary/85 [mask-image:radial-gradient(ellipse_58%_46%_at_50%_46%,#000_0%,#000_34%,transparent_75%)] [-webkit-mask-image:radial-gradient(ellipse_58%_46%_at_50%_46%,#000_0%,#000_34%,transparent_75%)]"
      />

      <div className="relative mx-auto flex min-h-[88vh] w-full max-w-5xl flex-col items-center justify-center px-5 py-24 text-center md:px-8">
        <p className="mb-6 inline-flex items-center gap-2 rounded-full border border-accent-gold/30 bg-accent-gold/5 px-4 py-1.5 text-xs uppercase tracking-[0.22em] text-accent-gold">
          <span className="h-1.5 w-1.5 rounded-full bg-accent-gold" aria-hidden="true" />
          {t('hero.microcopy')}
        </p>

        <h1 className="max-w-4xl font-display text-4xl font-light leading-[1.08] tracking-tight text-text-primary sm:text-5xl/none md:text-6xl/none lg:text-7xl/none">
          {t('hero.headline')}
        </h1>

        <p className="mt-7 max-w-2xl text-base leading-relaxed text-text-secondary sm:text-lg/7">
          {t('hero.subhead')}
        </p>

        <div className="mt-10 flex flex-col items-center gap-4">
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

          {/* Goodwill signal: free, open source, no accounts — one click to the repo. */}
          <a
            href={GITHUB_URL}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-2 rounded-full border border-ui-border/60 bg-background-primary/40 px-4 py-1.5 text-xs text-text-secondary backdrop-blur-xs transition-colors hover:border-accent-gold/60 hover:text-accent-gold-bright"
            data-testid="hero-github-badge"
          >
            <GithubMark className="h-3.5 w-3.5" />
            {t('hero.openSource')}
          </a>
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
