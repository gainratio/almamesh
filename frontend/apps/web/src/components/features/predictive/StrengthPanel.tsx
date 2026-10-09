/**
 * StrengthPanel — Ashtakavarga + Shadbala, engine StrengthCtx verbatim.
 *
 * SAV: a 12-cell per-sign bindu grid with the canonical total (337) shown.
 * BAV: per-graha bindu totals. Shadbala: per-graha rūpas against the classical
 * required minimum, with the engine's `approximated` component flags surfaced
 * honestly (≈ on the row + a footnote), never hidden.
 */

import type { ReactElement } from 'react';
import { useTranslation } from 'react-i18next';
import type {
  PlanetName,
  PlanetShadbalaData,
  StrengthCtx,
  ZodiacSign,
} from '@almamesh/shared-types';
import { Badge, Card } from '../../ui';
import { formatRupas, hasApproximatedComponents, sunriseBasisParams } from '../../../lib/predictive';
import { grahaName, signName } from '../../../lib/predictiveEventCopy';

const SIGN_ORDER: readonly ZodiacSign[] = [
  'aries', 'taurus', 'gemini', 'cancer', 'leo', 'virgo',
  'libra', 'scorpio', 'sagittarius', 'capricorn', 'aquarius', 'pisces',
];

function SavGrid({ ctx }: { ctx: StrengthCtx }): ReactElement {
  const { t } = useTranslation('predictive');
  const { sarva } = ctx.ashtakavarga;
  return (
    <Card
      title={t('strength.sav_heading')}
      subtitle={t('strength.sav_subtitle', { total: sarva.total })}
      actions={
        <Badge variant="brass" data-testid="sav-total">
          {t('strength.sav_total', { total: sarva.total })}
        </Badge>
      }
      data-testid="sav-card"
    >
      <dl className="grid grid-cols-3 gap-2 sm:grid-cols-4 lg:grid-cols-6" data-testid="sav-grid">
        {SIGN_ORDER.map((sign) => (
          <div
            key={sign}
            className="rounded-md border border-ui-border/60 px-3 py-2 text-center"
          >
            <dt className="text-xs uppercase tracking-wider text-text-tertiary">
              {signName(t, sign)}
            </dt>
            <dd className="mt-1 font-mono text-lg text-text-primary">{sarva.bindus[sign]}</dd>
          </div>
        ))}
      </dl>
    </Card>
  );
}

function BavTotals({ ctx }: { ctx: StrengthCtx }): ReactElement {
  const { t } = useTranslation('predictive');
  const rows = Object.values(ctx.ashtakavarga.bhinna).filter(
    (row): row is NonNullable<typeof row> => row !== undefined,
  );
  return (
    <Card
      title={t('strength.bav_heading')}
      subtitle={t('strength.bav_subtitle')}
      data-testid="bav-card"
    >
      <ul className="flex flex-wrap gap-2">
        {rows.map((row) => (
          <li
            key={row.planet}
            className="rounded-full border border-ui-border px-3 py-1 text-sm text-text-secondary"
          >
            <span className="font-medium text-text-primary">{grahaName(t, row.planet)}</span>{' '}
            {t('strength.bindus', { count: row.total })}
          </li>
        ))}
      </ul>
    </Card>
  );
}

function ShadbalaTable({
  ctx,
  birthTimeZone,
}: {
  ctx: StrengthCtx;
  birthTimeZone?: string;
}): ReactElement {
  const { t } = useTranslation('predictive');
  const rows = Object.values(ctx.shadbala.planets).filter(
    (row): row is PlanetShadbalaData => row !== undefined,
  );
  const anyApprox = rows.some(hasApproximatedComponents);
  return (
    <Card
      title={t('strength.shadbala_heading')}
      subtitle={t('strength.shadbala_subtitle')}
      data-testid="shadbala-card"
    >
      <div className="overflow-x-auto">
        <table className="w-full text-sm" data-testid="shadbala-table">
        <thead>
          <tr className="border-b border-ui-border text-left text-xs uppercase tracking-wider text-text-tertiary">
            <th scope="col" className="py-2 pr-3 font-medium">{t('strength.col_graha')}</th>
            <th scope="col" className="py-2 pr-3 font-medium">{t('strength.col_rupas')}</th>
            <th scope="col" className="py-2 pr-3 font-medium">{t('strength.col_required')}</th>
            <th scope="col" className="py-2 font-medium">{t('strength.col_verdict')}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.planet} className="border-b border-ui-border/50 last:border-0">
              <td className="py-2 pr-3 font-medium text-text-primary">
                {grahaName(t, row.planet)}
                {hasApproximatedComponents(row) && (
                  <span
                    className="ml-1 text-status-warning"
                    title={t('vargas.approximated')}
                    aria-label={t('vargas.approximated')}
                  >
                    ≈
                  </span>
                )}
              </td>
              <td className="py-2 pr-3 font-mono text-text-secondary">{formatRupas(row.total_rupas)}</td>
              <td className="py-2 pr-3 font-mono text-text-secondary">{formatRupas(row.required_rupas)}</td>
              <td className="py-2">
                <Badge variant={row.meets_minimum ? 'success' : 'warning'}>
                  {row.meets_minimum ? t('strength.meets') : t('strength.below')}
                </Badge>
              </td>
            </tr>
          ))}
        </tbody>
        </table>
      </div>
      <div className="mt-3 space-y-1">
        {anyApprox && (
          <p className="text-xs leading-relaxed text-text-tertiary" data-testid="shadbala-approx-note">
            {t('strength.approx_footnote')}
          </p>
        )}
        <SunriseBasis ctx={ctx} birthTimeZone={birthTimeZone} />
      </div>
    </Card>
  );
}

/** The graha the engine awarded Varabala (the weekday lord), if any. */
export function vedicDayLord(ctx: StrengthCtx): PlanetName | undefined {
  const rows = Object.values(ctx.shadbala.planets).filter(
    (row): row is PlanetShadbalaData => row !== undefined,
  );
  return rows.find((row) => row.kala.vara.virupas > 0)?.planet;
}

/**
 * The Kalabala sunrise on the BIRTHPLACE's calendar and clock, plus the weekday
 * lord. The Vedic day runs sunrise to sunrise at the birthplace, so a viewer in
 * another zone must not see the sunrise moved onto their own date. Without the
 * birthplace zone the instant is shown in UTC and labelled so — never the
 * viewer's zone.
 */
function SunriseBasis({
  ctx,
  birthTimeZone,
}: {
  ctx: StrengthCtx;
  birthTimeZone?: string;
}): ReactElement {
  const { t } = useTranslation('predictive');
  const lord = vedicDayLord(ctx);
  return (
    <>
      <p className="text-xs leading-relaxed text-text-tertiary" data-testid="strength-sunrise-basis">
        {t('strength.sunrise_basis_zoned', { ...sunriseBasisParams(ctx.sunrise_utc_iso, birthTimeZone) })}
      </p>
      {lord && (
        <p className="text-xs leading-relaxed text-text-tertiary" data-testid="strength-day-lord">
          {t('strength.day_lord', { lord: grahaName(t, lord) })}
        </p>
      )}
    </>
  );
}

export interface StrengthPanelProps {
  readonly strengthCtx: StrengthCtx;
  /** IANA zone of the birthplace: the sunrise is shown on its calendar. */
  readonly birthTimeZone?: string;
}

/** Ashtakavarga + Shadbala, rendered verbatim from the engine. */
export function StrengthPanel({ strengthCtx, birthTimeZone }: StrengthPanelProps): ReactElement {
  return (
    <div className="space-y-6" data-testid="strength-panel">
      <SavGrid ctx={strengthCtx} />
      <BavTotals ctx={strengthCtx} />
      <ShadbalaTable ctx={strengthCtx} birthTimeZone={birthTimeZone} />
    </div>
  );
}
