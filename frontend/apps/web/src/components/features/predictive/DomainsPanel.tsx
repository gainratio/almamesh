/**
 * DomainsPanel — the eight per-life-domain forecasts (engine DomainsCtx,
 * verbatim). Each card: strength band + key-graha line, the current emphasis
 * (daśā activation, Sade Sati, transit tone — with the engine's `approximated`
 * heuristic flag surfaced), the next timed windows with locale dates, and a
 * "show the working" disclosure for the house/kāraka/varga significators.
 *
 * Structured engine data FIRST — the AI narration stays on the existing
 * interpretation cards; nothing here is generated.
 */

import type { ReactElement } from 'react';
import { useTranslation } from 'react-i18next';
import type {
  DomainsCtx,
  LifeDomain,
  LifeDomainForecastData,
} from '@almamesh/shared-types';
import type { DomainStrengthReceipt } from '@almamesh/browser/types';
import { Card, Disclosure } from '../../ui';
import { LIFE_DOMAINS } from '../../../lib/lifeAtlas';
import { formatPredictiveDate, formatRupas } from '../../../lib/predictive';
import { domainWindowLabel, grahaName, signName } from '../../../lib/predictiveEventCopy';
import { BandBadge, SeverityBadge } from './PredictiveBadges';
import { StrengthEvidencePanels } from './StrengthEvidencePanels';

/** Stable render order for the eight domains (single source: lib/lifeAtlas). */
export const DOMAIN_ORDER: readonly LifeDomain[] = LIFE_DOMAINS;

/** Current-emphasis block — shared with the `/life/:domain` detail page. */
export function EmphasisBlock({ forecast }: { forecast: LifeDomainForecastData }): ReactElement {
  const { t } = useTranslation('predictive');
  const emphasis = forecast.current_emphasis;
  return (
    <div className="space-y-1.5" data-testid={`domain-emphasis-${forecast.domain}`}>
      <h4 className="text-xs uppercase tracking-wider text-text-tertiary">
        {t('domains.emphasis_heading')}
      </h4>
      <p className="text-sm leading-relaxed text-text-secondary">
        {emphasis.active_dasha_significator
          ? t('domains.active_dasha', { levels: emphasis.dasha_levels.join(' · ') })
          : t('domains.no_active_dasha')}
        {emphasis.matched_dasha_lords.length > 0 && (
          <>
            {' '}
            {t('domains.matched_lords', {
              lords: emphasis.matched_dasha_lords.map((lord) => grahaName(t, lord)).join(', '),
            })}
          </>
        )}
      </p>
      <p className="flex flex-wrap items-center gap-2 text-sm text-text-secondary">
        <span>{t('domains.transit_tone', { severity: t(`severity.${emphasis.transit_severity}`) })}</span>
        {emphasis.under_sade_sati && (
          <span className="rounded-full border border-status-warning/40 bg-status-warning/10 px-2 py-0.5 text-xs text-status-warning">
            {t('domains.under_sade_sati')}
          </span>
        )}
        {emphasis.approximated && (
          <span className="text-xs text-text-tertiary" title={emphasis.note}>
            {t('domains.approx_mark')}
          </span>
        )}
      </p>
    </div>
  );
}

/** Timed-windows block — shared with the `/life/:domain` detail page. */
export function WindowsBlock({
  forecast,
  maxWindows,
}: {
  forecast: LifeDomainForecastData;
  maxWindows: number;
}): ReactElement {
  const { t } = useTranslation('predictive');
  const windows = forecast.upcoming_windows.slice(0, maxWindows);
  return (
    <div className="space-y-1.5" data-testid={`domain-windows-${forecast.domain}`}>
      <h4 className="text-xs uppercase tracking-wider text-text-tertiary">
        {t('domains.windows_heading')}
      </h4>
      {windows.length === 0 ? (
        <p className="text-sm text-text-secondary">{t('domains.windows_empty')}</p>
      ) : (
        <ul className="space-y-1.5">
          {windows.map((window) => (
            <li
              key={`${window.date}-${window.descriptor}`}
              className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 text-sm"
            >
              <span>
                <span className="mr-2 font-mono text-xs text-text-tertiary">
                  {formatPredictiveDate(window.date)}
                </span>
                <span className="text-text-primary">{domainWindowLabel(t, window)}</span>
                <span className="ml-2 text-xs text-text-tertiary">
                  ({t(`domains.source.${window.source}`)})
                </span>
              </span>
              <SeverityBadge severity={window.severity} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** House/kāraka/varga "show the working" — shared with `/life/:domain`. */
export function WorkingBlock({ forecast }: { forecast: LifeDomainForecastData }): ReactElement {
  const { t } = useTranslation('predictive');
  return (
    <div className="space-y-3 text-sm text-text-secondary">
      <div>
        <h4 className="mb-1 text-xs uppercase tracking-wider text-text-tertiary">
          {t('domains.houses_heading')}
        </h4>
        <ul className="space-y-1">
          {forecast.houses.map((house) => (
            <li key={`${house.house}-${house.rule}`}>
              {t('domains.house_line', {
                house: house.house,
                sign: signName(t, house.sign),
                lord: grahaName(t, house.lord),
                lordHouse: house.lord_house,
                dignity: t(`dignity.${house.lord_dignity}`),
              })}
            </li>
          ))}
        </ul>
      </div>
      <div>
        <h4 className="mb-1 text-xs uppercase tracking-wider text-text-tertiary">
          {t('domains.karakas_heading')}
        </h4>
        <ul className="space-y-1">
          {forecast.karakas.map((karaka) => (
            <li key={`${karaka.graha}-${karaka.rule}`}>
              {t('domains.karaka_line', {
                graha: grahaName(t, karaka.graha),
                house: karaka.house,
                sign: signName(t, karaka.sign),
                dignity: t(`dignity.${karaka.dignity}`),
              })}
              {karaka.is_retrograde && (
                <span className="ml-1 text-xs text-text-tertiary">
                  ({t('domains.retrograde_mark')})
                </span>
              )}
            </li>
          ))}
        </ul>
      </div>
      <p className="flex flex-wrap items-center gap-2">
        {t('domains.varga_line', {
          chart: forecast.varga.chart,
          graha: grahaName(t, forecast.varga.graha),
          sign: signName(t, forecast.varga.sign),
        })}
        {forecast.varga.vargottama && (
          <span className="rounded-full border border-accent-gold/40 bg-accent-gold/10 px-2 py-0.5 text-xs text-accent-gold">
            {t('domains.vargottama_badge')}
          </span>
        )}
        {!forecast.varga.vargottama && forecast.varga.same_sign_as_d1 && (
          <span className="rounded-full border border-ui-border px-2 py-0.5 text-xs text-text-tertiary">
            {t('domains.same_sign_badge')}
          </span>
        )}
      </p>
    </div>
  );
}

export function DomainCard({
  forecast,
  maxWindows = 3,
  receipt,
  signerPublicKey,
}: {
  forecast: LifeDomainForecastData;
  maxWindows?: number;
  /** The domain's sealed strength receipt, when the compute produced one. */
  receipt?: DomainStrengthReceipt;
  /** The per-boot signer to verify the receipt against. */
  signerPublicKey?: string;
}): ReactElement {
  const { t } = useTranslation('predictive');
  const strength = forecast.strength_summary;
  return (
    <Card
      title={t(`domains.names.${forecast.domain}`)}
      subtitle={
        <span data-testid={`domain-strength-${forecast.domain}`}>
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
        </span>
      }
      actions={<BandBadge band={strength.band} />}
      data-testid={`domain-card-${forecast.domain}`}
    >
      <div className="space-y-4">
        <StrengthEvidencePanels
          forecast={forecast}
          receipt={receipt}
          signerPublicKey={signerPublicKey}
        />
        <EmphasisBlock forecast={forecast} />
        <WindowsBlock forecast={forecast} maxWindows={maxWindows} />
        <Disclosure
          toggleLabel={t('domains.details_show')}
          toggleLabelOpen={t('domains.details_hide')}
          summary={<span className="sr-only">{t(`domains.names.${forecast.domain}`)}</span>}
          contentClassName="pt-3"
        >
          <WorkingBlock forecast={forecast} />
        </Disclosure>
      </div>
    </Card>
  );
}

export interface DomainsPanelProps {
  readonly domainsCtx: DomainsCtx;
  /** Cap the timed windows per card (dashboard uses a tighter cut). */
  readonly maxWindows?: number;
  /**
   * Sealed per-domain strength receipts (Spec 062), keyed by domain. When
   * present with `signerPublicKey`, each domain that has a receipt shows an
   * on-screen VERIFIED/NOT-VERIFIED badge; domains without one render unchanged.
   */
  readonly receipts?: Readonly<Record<string, DomainStrengthReceipt>>;
  /** The per-boot signer the receipts are verified against. */
  readonly signerPublicKey?: string;
}

/** All eight life-domain forecast cards. */
export function DomainsPanel({
  domainsCtx,
  maxWindows = 3,
  receipts,
  signerPublicKey,
}: DomainsPanelProps): ReactElement {
  return (
    <div className="grid grid-cols-1 gap-4 md:grid-cols-2" data-testid="domains-panel">
      {DOMAIN_ORDER.map((domain) => (
        <DomainCard
          key={domain}
          forecast={domainsCtx.forecasts[domain]}
          maxWindows={maxWindows}
          receipt={receipts?.[domain]}
          signerPublicKey={signerPublicKey}
        />
      ))}
    </div>
  );
}
