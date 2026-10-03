/**
 * LifeAtlas — the dashboard centerpiece: seven life-domain cards, each linking
 * to its `/life/:domain` detail page.
 *
 * Data is the engine's lazy predictive synthesis (`DomainsCtx`, ~30s on-device
 * Pyodide run). It is FOUNDATIONAL: the computation starts AUTOMATICALLY the
 * moment the engine + chart are ready (in a background Worker, in parallel with
 * the LLM interpretation, so it never blocks first paint). The cards render
 * IMMEDIATELY in a designed pending state; the gate is purely informational
 * (warming / computing / error+retry) — never a manual button, never a
 * dead-end for a returning visitor.
 *
 * Card face (ready): domain name, engine strength band, the current-emphasis
 * one-liner, and the next timed window. Everything verbatim from the engine.
 */

import type { ReactElement } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import type { LifeDomain, LifeDomainForecastData } from '@almamesh/shared-types';

import { Button, Card, Spinner } from '../../ui';
import { useElapsedSeconds, formatElapsed } from '../../../hooks/useElapsedSeconds';
import { usePredictiveLayer, type PredictiveLayer } from '../../../hooks/usePredictiveLayer';
import { LIFE_DOMAINS, nextWindow } from '../../../lib/lifeAtlas';
import { formatPredictiveDate } from '../../../lib/predictive';
import { domainWindowLabel } from '../../../lib/predictiveEventCopy';
import { BandBadge } from '../predictive/PredictiveBadges';

/** Shared card frame so pending and ready faces carry one grammar. */
const CARD_FRAME =
  'flex min-h-[10rem] flex-col rounded-lg border border-ui-border bg-background-secondary p-5';

function PendingCardFace({
  domain,
  computing,
}: {
  domain: LifeDomain;
  computing: boolean;
}): ReactElement {
  const { t } = useTranslation(['life', 'predictive']);
  return (
    <div
      className={`${CARD_FRAME} ${computing ? 'animate-pulse motion-reduce:animate-none' : ''}`}
      data-testid={`life-atlas-card-${domain}`}
    >
      <h3 className="font-display text-base text-text-secondary">
        {t(`predictive:domains.names.${domain}`)}
      </h3>
      <p className="mt-auto pt-4 text-xs uppercase tracking-wider text-text-tertiary">
        {t('life:atlas.pending_hint')}
      </p>
    </div>
  );
}

function EmphasisLine({ forecast }: { forecast: LifeDomainForecastData }): ReactElement {
  const { t } = useTranslation(['life', 'predictive']);
  const emphasis = forecast.current_emphasis;
  return (
    <p className="mt-2 text-sm leading-relaxed text-text-secondary">
      {emphasis.active_dasha_significator
        ? t('life:atlas.emphasis_active', { levels: emphasis.dasha_levels.join(' · ') })
        : t('life:atlas.emphasis_quiet')}
      <span className="block text-xs text-text-tertiary">
        {t('life:atlas.tone_label', {
          severity: t(`predictive:severity.${emphasis.transit_severity}`),
        })}
        {emphasis.under_sade_sati && (
          <span className="text-status-warning">
            {' · '}
            {t('life:atlas.sade_sati')}
          </span>
        )}
      </span>
    </p>
  );
}

function DomainCardFace({ forecast }: { forecast: LifeDomainForecastData }): ReactElement {
  const { t } = useTranslation(['life', 'predictive']);
  const domainName = t(`predictive:domains.names.${forecast.domain}`);
  const window = nextWindow(forecast);
  return (
    <Link
      to={`/life/${forecast.domain}`}
      aria-label={t('life:atlas.open_domain', { domain: domainName })}
      data-testid={`life-atlas-card-${forecast.domain}`}
      className={`${CARD_FRAME} group transition-colors hover:border-accent-gold/50 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-accent-gold/60`}
    >
      <div className="flex items-baseline justify-between gap-3">
        <h3 className="font-display text-base text-text-primary transition-colors group-hover:text-accent-gold-bright">
          {domainName}
        </h3>
        <BandBadge band={forecast.strength_summary.band} />
      </div>
      <EmphasisLine forecast={forecast} />
      <div className="mt-auto pt-4">
        <p className="text-[11px] uppercase tracking-wider text-text-tertiary">
          {t('life:atlas.next_window')}
        </p>
        {window ? (
          <p className="mt-1 text-sm text-text-primary">
            <span className="mr-2 font-mono text-xs text-text-tertiary">
              {formatPredictiveDate(window.date)}
            </span>
            {domainWindowLabel(t, window)}
          </p>
        ) : (
          <p className="mt-1 text-sm text-text-tertiary">{t('life:atlas.no_window')}</p>
        )}
      </div>
    </Link>
  );
}

/** Eighth grid cell: what these forecasts are — and the door to the full panel. */
function AboutCell(): ReactElement {
  const { t } = useTranslation('life');
  return (
    <div className={`${CARD_FRAME} border-dashed`} data-testid="life-atlas-about">
      <h3 className="text-[11px] font-medium uppercase tracking-[0.18em] text-text-tertiary">
        {t('atlas.about_title')}
      </h3>
      <p className="mt-2 text-xs leading-relaxed text-text-secondary">{t('atlas.about_body')}</p>
      <Link
        to="/predictive"
        className="mt-auto pt-4 text-sm text-accent-gold transition-colors hover:text-accent-gold-bright"
      >
        {t('atlas.about_link')}
      </Link>
    </div>
  );
}

function GateBar({ layer, elapsed }: { layer: PredictiveLayer; elapsed: number }): ReactElement {
  const { t } = useTranslation('life');
  if (layer.status === 'loading') {
    return (
      <Card data-testid="life-atlas-gate">
        <p className="flex items-start gap-3 text-sm leading-relaxed text-text-secondary">
          <Spinner size="sm" className="mt-0.5 shrink-0" />
          <span>{t('atlas.computing_body', { elapsed: formatElapsed(elapsed) })}</span>
        </p>
      </Card>
    );
  }
  if (layer.status === 'error') {
    return (
      <Card title={t('atlas.error_title')} data-testid="life-atlas-gate">
        <div className="space-y-3">
          {layer.error && <p className="text-sm text-status-error">{layer.error}</p>}
          <Button onClick={layer.compute} disabled={!layer.canCompute} data-testid="life-atlas-retry">
            {t('atlas.retry')}
          </Button>
        </div>
      </Card>
    );
  }
  // Idle/starting: the compute fires automatically once the engine is ready
  // (see `usePredictiveLayer({ auto: true })`). The gate is purely informational
  // here — never a manual button — so a returning visitor is never dead-ended.
  return (
    <Card data-testid="life-atlas-gate">
      <p className="flex items-center gap-2 text-sm text-text-tertiary">
        <Spinner size="sm" />
        {t('atlas.engine_warming')}
      </p>
    </Card>
  );
}

/** The Life Atlas section: heading, gate (until ready) and the domain grid. */
export function LifeAtlas(): ReactElement | null {
  const { t } = useTranslation('life');
  // The Life Atlas is FOUNDATIONAL: it computes automatically the moment the
  // engine + chart are ready, in parallel with the LLM interpretation — never
  // behind a manual button.
  const layer = usePredictiveLayer({ auto: true });
  const elapsed = useElapsedSeconds(layer.status === 'loading');

  // A chart-less device shows the onboarding path elsewhere; stay silent here.
  if (!layer.hasBirthData) {
    return null;
  }

  const domainsCtx = layer.status === 'ready' ? layer.domainsCtx : undefined;

  return (
    <section className="space-y-5" data-testid="life-atlas">
      <header className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1">
        <div>
          <h2 className="font-display text-xl text-text-primary">{t('atlas.heading')}</h2>
          <p className="mt-1 max-w-prose text-sm text-text-secondary">{t('atlas.subtitle')}</p>
        </div>
        {domainsCtx && (
          <p className="text-xs text-text-tertiary">
            {t('atlas.as_of', { date: formatPredictiveDate(domainsCtx.instant) })}
          </p>
        )}
      </header>

      {!domainsCtx && <GateBar layer={layer} elapsed={elapsed} />}

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
        {LIFE_DOMAINS.map((domain) =>
          domainsCtx ? (
            <DomainCardFace key={domain} forecast={domainsCtx.forecasts[domain]} />
          ) : (
            <PendingCardFace key={domain} domain={domain} computing={layer.status === 'loading'} />
          ),
        )}
        <AboutCell />
      </div>
    </section>
  );
}
