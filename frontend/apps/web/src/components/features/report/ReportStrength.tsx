/**
 * ReportStrength — the printed planetary-strength section: the SAV per-sign
 * bindu grid (with the canonical 337 total), the per-planet Bhinnāṣṭakavarga
 * bindu matrix (sign × graha, straight from `ashtakavarga.bhinna`), and the
 * Ṣaḍbala table with all six classical components (Sthāna · Dig · Kāla ·
 * Cheṣṭā · Naisargika · Dṛk, in virūpas) beside the rūpa totals and the
 * classical minimum, with `approximated` component flags shown honestly
 * (≈ + footnote). Engine StrengthCtx verbatim; numbers render through the
 * shared two-decimal strength formatter (`formatRupas`) — pure presentation.
 */

import type { ReactElement } from 'react';
import { useTranslation } from 'react-i18next';
import type {
  BhinnashtakavargaData,
  PlanetShadbalaData,
  StrengthCtx,
  ZodiacSign,
} from '@almamesh/shared-types';
import { formatRupas, sunriseBasisParams } from '../../../lib/predictive';
import { grahaName, signName } from '../../../lib/predictiveEventCopy';
import { hasApproximatedComponents } from '../predictive/StrengthPanel';
import { ReportSectionHeading } from './ReportSectionHeading';
import { sectionNumeral } from '../../../lib/reportSections';

const SIGN_ORDER: readonly ZodiacSign[] = [
  'aries', 'taurus', 'gemini', 'cancer', 'leo', 'virgo',
  'libra', 'scorpio', 'sagittarius', 'capricorn', 'aquarius', 'pisces',
];

/** The seven classical grahas of Parashari Ashtakavarga/Shadbala, in order. */
const GRAHA_ORDER: readonly string[] = [
  'sun', 'moon', 'mars', 'mercury', 'jupiter', 'venus', 'saturn',
];

/** Emitted rows of a per-planet map, in canonical graha order. */
function orderedRows<T extends { readonly planet: string }>(
  byPlanet: Partial<Record<string, T | undefined>>,
): readonly T[] {
  return GRAHA_ORDER.map((name) => byPlanet[name]).filter((row): row is T => row !== undefined);
}

interface ReportStrengthProps {
  readonly strengthCtx: StrengthCtx;
  /** IANA zone of the birthplace: the sunrise is printed on its calendar. */
  readonly birthTimeZone?: string;
}

/** Ashtakavarga (SAV + BAV) + six-component Shadbala for print. */
export function ReportStrength({ strengthCtx, birthTimeZone }: ReportStrengthProps): ReactElement {
  const { t } = useTranslation('report');
  const { t: tp } = useTranslation('predictive');
  const sarva = strengthCtx.ashtakavarga.sarva;
  const bavRows: readonly BhinnashtakavargaData[] = orderedRows(strengthCtx.ashtakavarga.bhinna);
  const shadbalaRows: readonly PlanetShadbalaData[] = orderedRows(strengthCtx.shadbala.planets);
  const anyApprox = shadbalaRows.some(hasApproximatedComponents);

  return (
    <section className="report-section" data-testid="report-strength">
      <ReportSectionHeading index={sectionNumeral('strength')} title={t('strength.heading')} />

      <h3 className="report-subsection-title">
        {t('strength.sav_heading')} — {t('strength.sav_total', { total: sarva.total })}
      </h3>
      <dl className="report-sign-grid report-avoid-break" data-testid="report-sav-grid">
        {SIGN_ORDER.map((sign) => (
          <div className="report-sign-cell" key={sign}>
            <dt>{signName(tp, sign)}</dt>
            <dd>{sarva.bindus[sign]}</dd>
          </div>
        ))}
      </dl>

      {/* Bhinnāṣṭakavarga: the per-planet bindu matrix (rows = signs, columns =
          the emitting grahas, closed by each graha's bindu total). */}
      {bavRows.length > 0 && (
        <>
          <h3 className="report-subsection-title">{t('strength.bav_heading')}</h3>
          <table className="report-table" data-testid="report-bav">
            <thead>
              <tr>
                <th scope="col">{t('strength.col_sign')}</th>
                {bavRows.map((row) => (
                  <th scope="col" key={row.planet}>
                    {grahaName(tp, row.planet)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {SIGN_ORDER.map((sign) => (
                <tr key={sign} className="report-avoid-break">
                  <td>{signName(tp, sign)}</td>
                  {bavRows.map((row) => (
                    <td key={row.planet}>{row.bindus[sign]}</td>
                  ))}
                </tr>
              ))}
              <tr className="report-avoid-break" data-testid="report-bav-totals">
                <td>{t('strength.bav_total_row')}</td>
                {bavRows.map((row) => (
                  <td key={row.planet}>{row.total}</td>
                ))}
              </tr>
            </tbody>
          </table>
        </>
      )}

      <h3 className="report-subsection-title">{t('strength.shadbala_heading')}</h3>
      <table className="report-table" data-testid="report-shadbala">
        <thead>
          <tr>
            <th scope="col">{t('strength.col_graha')}</th>
            <th scope="col">{t('strength.col_sthana')}</th>
            <th scope="col">{t('strength.col_dig')}</th>
            <th scope="col">{t('strength.col_kala')}</th>
            <th scope="col">{t('strength.col_cheshta')}</th>
            <th scope="col">{t('strength.col_naisargika')}</th>
            <th scope="col">{t('strength.col_drik')}</th>
            <th scope="col">{t('strength.col_rupas')}</th>
            <th scope="col">{t('strength.col_required')}</th>
            <th scope="col">{t('strength.col_verdict')}</th>
          </tr>
        </thead>
        <tbody>
          {shadbalaRows.map((row) => (
            <tr key={row.planet} className="report-avoid-break">
              <td>
                {grahaName(tp, row.planet)}
                {hasApproximatedComponents(row) ? ' ≈' : ''}
              </td>
              <td>{formatRupas(row.sthana.total_virupas)}</td>
              <td>{formatRupas(row.dig.virupas)}</td>
              <td>{formatRupas(row.kala.total_virupas)}</td>
              <td>{formatRupas(row.cheshta.virupas)}</td>
              <td>{formatRupas(row.naisargika.virupas)}</td>
              <td>{formatRupas(row.drik.virupas)}</td>
              <td>{formatRupas(row.total_rupas)}</td>
              <td>{formatRupas(row.required_rupas)}</td>
              <td>{row.meets_minimum ? t('strength.meets') : t('strength.below')}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="report-note">{t('strength.components_note')}</p>
      {anyApprox && <p className="report-note">{tp('strength.approx_footnote')}</p>}
      <p className="report-note" data-testid="report-sunrise-basis">
        {tp('strength.sunrise_basis_zoned', {
          ...sunriseBasisParams(strengthCtx.sunrise_utc_iso, birthTimeZone),
        })}
      </p>
    </section>
  );
}
