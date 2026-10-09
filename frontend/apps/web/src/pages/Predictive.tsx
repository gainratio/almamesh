/**
 * Predictive — the "Sky & Timing" page (`/predictive`).
 *
 * One home for the timing surfaces: Transits & Timing (the next 12 months),
 * the Vimśottarī Periods explorer, the full Shodasavarga gallery, planetary
 * strength (Ashtakavarga + Shadbala) and the seven life-domain forecasts.
 *
 * Two data tempos, honestly separated: the PERIODS tab renders INSTANTLY from
 * the natal chart's stored daśā payload (no compute), while the other four
 * tabs read the lazily-computed engine contexts — mounting the page triggers
 * the idempotent `ensurePredictive` (auto mode), and any not-yet-ready tab
 * shows the honest progress/gate card (live elapsed time, on-device note),
 * never a bare spinner. All values render verbatim from the engine.
 * `?tab=periods` deep-links straight to the explorer (the dashboard link).
 */

import { useState, type ReactElement } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../components/ui';
import {
  DomainsPanel,
  PeriodsPanel,
  PredictiveStatusCard,
  ShodasavargaPanel,
  StrengthPanel,
  TransitsPanel,
} from '../components/features/predictive';
import { usePredictiveLayer } from '../hooks/usePredictiveLayer';
import { formatReferenceDay } from '../lib/predictive';

type PredictiveTab = 'timing' | 'periods' | 'vargas' | 'strength' | 'domains';

const TAB_VALUES: readonly PredictiveTab[] = ['timing', 'periods', 'vargas', 'strength', 'domains'];

/** Map a raw `?tab=` / tab-change value onto a known tab (default: timing). */
function resolveTab(raw: string | null): PredictiveTab {
  return TAB_VALUES.find((value) => value === raw) ?? 'timing';
}

export default function PredictivePage(): ReactElement {
  const { t } = useTranslation('predictive');
  const layer = usePredictiveLayer({ auto: true });
  const [searchParams] = useSearchParams();
  const [tab, setTab] = useState<PredictiveTab>(() => resolveTab(searchParams.get('tab')));

  const ready =
    layer.status === 'ready' &&
    layer.transitCtx !== undefined &&
    layer.vargaCtxFull !== undefined &&
    layer.strengthCtx !== undefined &&
    layer.domainsCtx !== undefined;

  return (
    <main className="mx-auto max-w-6xl space-y-6 px-2 py-2" data-testid="predictive-page">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="font-display text-3xl text-text-primary">{t('page.title')}</h1>
          <p className="mt-1 max-w-2xl text-sm text-text-secondary">{t('page.subtitle')}</p>
          {ready && layer.transitCtx && (
            <p className="mt-1 text-xs text-text-tertiary" data-testid="predictive-as-of">
              {t('page.as_of', { date: formatReferenceDay(layer.transitCtx.instant) })}
            </p>
          )}
        </div>
        <Link
          to="/dashboard"
          className="text-sm text-accent-gold transition-colors hover:text-accent-gold-bright"
          data-testid="predictive-back-dashboard"
        >
          {t('common:nav.dashboard')}
        </Link>
      </div>

      {/* No chart at all → the single honest gate (no tabs to offer). */}
      {!layer.hasBirthData && <PredictiveStatusCard layer={layer} auto />}

      {layer.hasBirthData && (
        <Tabs value={tab} onValueChange={(value) => setTab(resolveTab(value))}>
          <TabsList className="mb-6 w-full overflow-x-auto">
            <TabsTrigger value="timing">{t('tabs.timing')}</TabsTrigger>
            <TabsTrigger value="periods" data-testid="periods-tab">
              {t('tabs.periods')}
            </TabsTrigger>
            <TabsTrigger value="vargas">{t('tabs.vargas')}</TabsTrigger>
            <TabsTrigger value="strength">{t('tabs.strength')}</TabsTrigger>
            <TabsTrigger value="domains" data-testid="domains-tab">
              {t('tabs.domains')}
            </TabsTrigger>
          </TabsList>

          <TabsContent value="timing">
            {ready && layer.transitCtx ? (
              <TransitsPanel transitCtx={layer.transitCtx} />
            ) : (
              <PredictiveStatusCard layer={layer} auto />
            )}
          </TabsContent>

          {/* Natal-payload tab: renders instantly, independent of the compute. */}
          <TabsContent value="periods">
            <PeriodsPanel dashas={layer.natalDashas} />
          </TabsContent>

          <TabsContent value="vargas">
            {ready && layer.vargaCtxFull ? (
              <ShodasavargaPanel vargaCtxFull={layer.vargaCtxFull} />
            ) : (
              <PredictiveStatusCard layer={layer} auto />
            )}
          </TabsContent>

          <TabsContent value="strength">
            {ready && layer.strengthCtx ? (
              <StrengthPanel strengthCtx={layer.strengthCtx} birthTimeZone={layer.birthTimeZone} />
            ) : (
              <PredictiveStatusCard layer={layer} auto />
            )}
          </TabsContent>

          <TabsContent value="domains">
            {ready && layer.domainsCtx ? (
              <div className="space-y-4">
                <p className="max-w-2xl text-sm text-text-secondary">{t('domains.subtitle')}</p>
                {/* Surface the sealed per-domain strength receipts + their per-boot
                    signer (Spec 062) so each band carries an on-screen, verifiable
                    tamper-evidence badge — the same check the PDF export runs
                    silently. Absent on an older payload → cards render unchanged. */}
                <DomainsPanel
                  domainsCtx={layer.domainsCtx}
                  receipts={layer.rawContexts?.domain_strength_receipts}
                  signerPublicKey={layer.rawContexts?.strength_signer_public_key}
                />
              </div>
            ) : (
              <PredictiveStatusCard layer={layer} auto />
            )}
          </TabsContent>
        </Tabs>
      )}
    </main>
  );
}
