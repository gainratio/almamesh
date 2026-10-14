/**
 * LifeDomainPage — `/life/:domain`, the detail view behind each Life Atlas card.
 *
 * Two clearly-labeled layers, never blended:
 *  1. ENGINE FORECAST (deterministic, on-device): strength summary, current
 *     emphasis, the timed-window list and a "show the working" reveal of the
 *     house/kāraka/varga significators — the same blocks the Sky & Timing
 *     panel renders, verbatim from `DomainsCtx`.
 *  2. AI READING (optional): the matching section of the structured
 *     interpretation where one exists; `family` is honestly engine-only.
 *
 * The ~30s predictive synthesis is FOUNDATIONAL, like the dashboard's Life
 * Atlas: it computes AUTOMATICALLY once the engine + chart are ready (off the
 * UI thread), with an informational warming/computing gate and an error+retry
 * recovery path — never a manual button, never a dead-end.
 */

import type { ReactElement, ReactNode } from 'react';
import { Link, Navigate, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useChartLibraryStore, useInterpretationStore, useProfilesStore } from '@almamesh/store';
import type { LifeDomain, LifeDomainForecastData } from '@almamesh/shared-types';
import type { DomainStrengthReceipt } from '@almamesh/browser/types';

import { Button, Card, Disclosure, Spinner } from '../components/ui';
import { ContentModeToggle } from '../components/ui/ContentModeToggle';
import { DualModeContent } from '../components/ui/DualModeContent';
import {
  EmphasisBlock,
  WindowsBlock,
  WorkingBlock,
} from '../components/features/predictive/DomainsPanel';
import { BandBadge } from '../components/features/predictive/PredictiveBadges';
import { StrengthEvidencePanels } from '../components/features/predictive/StrengthEvidencePanels';
import { useElapsedSeconds, formatElapsed } from '../hooks/useElapsedSeconds';
import { usePredictiveLayer, type PredictiveLayer } from '../hooks/usePredictiveLayer';
import { displayInterpretationForChart } from '../hooks/useStreamingInterpretation';
import { domainGuidance, DOMAIN_GUIDANCE_KEY, DOMAIN_NOTE_KEY, isLifeDomain } from '../lib/lifeAtlas';
import { formatRupas, selectPrimaryStoredChart } from '../lib/predictive';
import { grahaName } from '../lib/predictiveEventCopy';

/** Section header: small-caps heading + an honest provenance badge. */
function SectionHead({ heading, badge }: { heading: string; badge: string }): ReactElement {
  return (
    <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
      <h2 className="font-display text-lg text-text-primary">{heading}</h2>
      <span className="rounded-full border border-ui-border px-2 py-0.5 text-[11px] uppercase tracking-wider text-text-tertiary">
        {badge}
      </span>
    </div>
  );
}

function DomainGate({ layer, elapsed }: { layer: PredictiveLayer; elapsed: number }): ReactElement {
  const { t } = useTranslation('life');
  if (layer.status === 'loading') {
    return (
      <Card data-testid="life-domain-gate">
        <p className="flex items-start gap-3 text-sm leading-relaxed text-text-secondary">
          <Spinner size="sm" className="mt-0.5 shrink-0" />
          <span>{t('atlas.computing_body', { elapsed: formatElapsed(elapsed) })}</span>
        </p>
      </Card>
    );
  }
  if (layer.status === 'error') {
    return (
      <Card title={t('atlas.error_title')} data-testid="life-domain-gate">
        <div className="space-y-3">
          {layer.error && <p className="text-sm text-status-error">{layer.error}</p>}
          <Button
            onClick={layer.compute}
            disabled={!layer.canCompute}
            data-testid="life-domain-retry"
          >
            {t('atlas.retry')}
          </Button>
        </div>
      </Card>
    );
  }
  // Idle/starting: the predictive synthesis computes automatically once the
  // engine is ready (see `usePredictiveLayer({ auto: true })`). The gate is
  // purely informational here — never a manual button, never a dead-end.
  return (
    <Card data-testid="life-domain-gate">
      <p className="flex items-center gap-2 text-sm text-text-tertiary">
        <Spinner size="sm" />
        {t('atlas.engine_warming')}
      </p>
    </Card>
  );
}

function StrengthLine({ forecast }: { forecast: LifeDomainForecastData }): ReactElement {
  const { t } = useTranslation('predictive');
  const strength = forecast.strength_summary;
  return (
    <p className="text-sm text-text-secondary">
      {t('domains.strength_line', {
        graha: grahaName(t, strength.key_graha),
        rupas: formatRupas(strength.key_graha_rupas),
        bindus: strength.sav_bindus,
      })}
      {strength.approximated && (
        <span className="ml-1 text-text-tertiary" title={strength.note}>
          ≈
        </span>
      )}
    </p>
  );
}

function EngineSection({
  forecast,
  receipt,
  signerPublicKey,
}: {
  forecast: LifeDomainForecastData;
  receipt?: DomainStrengthReceipt;
  signerPublicKey?: string;
}): ReactElement {
  const { t } = useTranslation(['life', 'predictive']);
  return (
    <section className="space-y-5" data-testid="life-domain-engine">
      <SectionHead heading={t('life:domain.engine_heading')} badge={t('life:domain.engine_badge')} />
      <Card>
        <div className="space-y-5">
          <EmphasisBlock forecast={forecast} />
          <WindowsBlock forecast={forecast} maxWindows={12} />
          <StrengthEvidencePanels
            forecast={forecast}
            receipt={receipt}
            signerPublicKey={signerPublicKey}
            showReceiptDetails
          />
          <Disclosure
            toggleLabel={t('predictive:domains.details_show')}
            toggleLabelOpen={t('predictive:domains.details_hide')}
            summary={
              <span className="sr-only">{t(`predictive:domains.names.${forecast.domain}`)}</span>
            }
            contentClassName="pt-3"
          >
            <WorkingBlock forecast={forecast} />
          </Disclosure>
        </div>
      </Card>
    </section>
  );
}

function AiSection({ domain }: { domain: LifeDomain }): ReactElement {
  const { t } = useTranslation('life');
  const charts = useChartLibraryStore((s) => s.charts);
  const activeProfileId = useProfilesStore((s) => s.activeProfileId);
  const chartId = selectPrimaryStoredChart(charts, activeProfileId)?.chart_id ?? null;
  useInterpretationStore((s) => (chartId ? s.byChart[chartId] : undefined));
  const interpretation = displayInterpretationForChart(chartId);
  const guidance = domainGuidance(interpretation, domain);

  let body: ReactNode;
  if (guidance) {
    body = <DualModeContent layman={guidance.layman} technical={guidance.technical} />;
  } else if (DOMAIN_GUIDANCE_KEY[domain] === null) {
    body = <p className="max-w-prose text-sm text-text-secondary">{t('domain.engine_only')}</p>;
  } else {
    body = <p className="max-w-prose text-sm text-text-secondary">{t('domain.ai_missing')}</p>;
  }

  return (
    <section className="space-y-5" data-testid="life-domain-ai">
      <SectionHead heading={t('domain.ai_heading')} badge={t('domain.ai_badge')} />
      <Card>{body}</Card>
    </section>
  );
}

function LifeDomainContent({ domain }: { domain: LifeDomain }): ReactElement {
  const { t } = useTranslation(['life', 'predictive']);
  // Foundational, like the dashboard Life Atlas: compute automatically once the
  // engine + chart are ready — opening this page no longer requires a click.
  const layer = usePredictiveLayer({ auto: true });
  const elapsed = useElapsedSeconds(layer.status === 'loading');
  const forecast = layer.status === 'ready' ? layer.domainsCtx?.forecasts[domain] : undefined;
  // The sealed strength receipt for THIS domain + its per-boot signer (Spec 062).
  // Absent on an older persisted payload — the page renders exactly as before.
  const receipt = layer.rawContexts?.domain_strength_receipts?.[domain];
  const signerPublicKey = layer.rawContexts?.strength_signer_public_key;
  const noteKey = DOMAIN_NOTE_KEY[domain];

  return (
    <div className="space-y-8" data-testid="life-domain-page">
      <nav>
        <Link
          to="/dashboard"
          className="inline-flex items-center gap-1.5 text-sm text-text-muted transition-colors hover:text-text-primary"
          data-testid="life-domain-back"
        >
          <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
          </svg>
          {t('life:domain.back')}
        </Link>
      </nav>

      <header className="flex flex-wrap items-start justify-between gap-x-6 gap-y-4 border-b border-ui-border pb-6">
        <div className="min-w-0">
          <p className="text-[11px] font-medium uppercase tracking-[0.18em] text-text-tertiary">
            {t('life:domain.kicker')}
          </p>
          <h1 className="mt-1 font-display text-3xl leading-tight text-text-primary">
            {t(`predictive:domains.names.${domain}`)}
          </h1>
          {noteKey && (
            <p className="mt-2 max-w-prose text-sm text-text-secondary" data-testid="life-domain-note">
              {t(`life:${noteKey}`)}
            </p>
          )}
          {forecast && (
            <div className="mt-3 flex flex-wrap items-center gap-3">
              <BandBadge band={forecast.strength_summary.band} />
              <StrengthLine forecast={forecast} />
            </div>
          )}
        </div>
        <ContentModeToggle />
      </header>

      {forecast ? (
        <EngineSection forecast={forecast} receipt={receipt} signerPublicKey={signerPublicKey} />
      ) : (
        <DomainGate layer={layer} elapsed={elapsed} />
      )}

      <AiSection domain={domain} />

      <div className="flex flex-wrap items-center gap-4 border-t border-ui-border pt-6">
        <Link
          to="/dashboard?chat=open"
          className="inline-flex items-center gap-2 rounded-lg border border-accent-gold px-4 py-2 text-sm font-medium text-accent-gold transition-colors hover:bg-accent-gold/10"
          data-testid="life-domain-chat-link"
        >
          {t('life:domain.chat')}
        </Link>
        <Link
          to="/predictive"
          className="text-sm text-text-muted transition-colors hover:text-text-primary"
        >
          {t('life:domain.open_timing')}
        </Link>
      </div>
    </div>
  );
}

export default function LifeDomainPage(): ReactElement {
  const { domain } = useParams();
  if (!domain || !isLifeDomain(domain)) {
    return <Navigate to="/dashboard" replace />;
  }
  return <LifeDomainContent domain={domain} />;
}
