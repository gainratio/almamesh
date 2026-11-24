/**
 * VarshaphalaPanel — Annual Solar Return (Tajaka Varshaphala) surface inside
 * `/predictive?tab=varshaphala`.
 *
 * Computes the exact sidereal solar return on-device via `engine.computeVarshaphala`
 * (zero JS astrology math — 100% Python engine output) and renders:
 * - Year selector (birth year .. 2052)
 * - Varsha Pravesh timestamp, Varsha Lagna North-Indian Kundli SVG
 * - Muntha (progressed ascendant), Varshesha (Year Lord + Panchadhikari roles)
 * - Panchavargiya Bala table (0-20 Virupas across all 7 classical grahas)
 * - Annual Mudda Dasha timeline (with current period highlighted)
 * - Tajaka Yogas (Ithasala / Easarpha with orbs)
 */

import { useEffect, useMemo, useState, type ReactElement } from 'react';
import { useTranslation } from 'react-i18next';
import type { VarshaphalaContext } from '@almamesh/browser/types';
import { buildChartGeometry, useAyanamsaStore, type StoredChart } from '@almamesh/store';
import type { ProcessedBirthData } from '@almamesh/shared-types';

import { NorthIndianChartSVG } from '../../chart/NorthIndianChartSVG';
import { Badge, Card, Select, Spinner } from '../../ui';
import { useOptionalChartEngine } from '../../../providers/chartEngineContext';
import { formatDisplayDate } from '../../../lib/dates';

// Capped at 2051 so next_solar_return_utc (targetYear + 1 = 2052) stays inside DE421.
const MAX_EPHEMERIS_YEAR = 2051;

export interface VarshaphalaPanelProps {
  readonly storedChart: StoredChart | undefined;
  readonly referenceInstant: string;
}

function birthYearFrom(birth: ProcessedBirthData | undefined): number {
  const iso = birth?.birth_datetime_utc;
  if (!iso) return 2000;
  const parsed = Number.parseInt(iso.slice(0, 4), 10);
  return Number.isFinite(parsed) ? parsed : 2000;
}

function defaultSolarYear(
  birth: ProcessedBirthData | undefined,
  birthYear: number,
  referenceInstant: string,
): number {
  const refYear = Number.parseInt(referenceInstant.slice(0, 4), 10);
  const currentYear = Number.isFinite(refYear) ? refYear : new Date().getUTCFullYear();
  const birthMmDd = birth?.birth_datetime_utc?.slice(5, 10) ?? '01-01';
  const refMmDd = referenceInstant.slice(5, 10);
  // Before the user's birthday in calendar year Y, their active solar year began in Y - 1.
  const activeYear = refMmDd && refMmDd < birthMmDd ? currentYear - 1 : currentYear;
  return Math.min(MAX_EPHEMERIS_YEAR, Math.max(birthYear, activeYear));
}

function yearOptions(birthYear: number): readonly number[] {
  const start = Math.max(1900, birthYear);
  const out: number[] = [];
  for (let y = start; y <= MAX_EPHEMERIS_YEAR; y += 1) {
    out.push(y);
  }
  return out;
}

function formatUtcStamp(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.valueOf())) return iso;
  return `${formatDisplayDate(d, { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' })} · ${d.toISOString().slice(11, 16)} UTC`;
}

function bandVariant(band: 'strong' | 'moderate' | 'weak'): 'success' | 'warning' | 'default' {
  if (band === 'strong') return 'success';
  if (band === 'moderate') return 'warning';
  return 'default';
}

export function VarshaphalaPanel({
  storedChart,
  referenceInstant,
}: VarshaphalaPanelProps): ReactElement {
  const { t } = useTranslation('predictive');
  const engineCtx = useOptionalChartEngine();
  const engine = engineCtx?.engine ?? null;
  const ayanamsa = useAyanamsaStore((s) => s.ayanamsa);

  const birth = storedChart?.birth_data as ProcessedBirthData | undefined;
  const location = birth?.birth_location_details;
  const birthYear = birthYearFrom(birth);
  const [targetYear, setTargetYear] = useState<number>(() =>
    defaultSolarYear(birth, birthYear, referenceInstant),
  );
  const [result, setResult] = useState<VarshaphalaContext | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setTargetYear((prev) =>
      prev < birthYear || prev > MAX_EPHEMERIS_YEAR
        ? defaultSolarYear(birth, birthYear, referenceInstant)
        : prev,
    );
  }, [birth, birthYear, referenceInstant]);

  useEffect(() => {
    if (!engine?.computeVarshaphala || !birth?.birth_datetime_utc || !location) {
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    engine
      .computeVarshaphala({
        datetimeUtc: birth.birth_datetime_utc,
        latitude: location.latitude,
        longitude: location.longitude,
        targetYear,
        referenceDate: referenceInstant,
        ...(ayanamsa !== 'LAHIRI' ? { ayanamsaType: ayanamsa } : {}),
      })
      .then((data) => {
        if (!cancelled) {
          setResult(data);
          setLoading(false);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setResult(null);
          setError(t('gate.error_title'));
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [engine, birth?.birth_datetime_utc, location, targetYear, referenceInstant, ayanamsa, t]);

  const varshaGeometry = useMemo(
    () => (result ? buildChartGeometry(result.varsha_chart) : null),
    [result],
  );
  const years = useMemo(() => yearOptions(birthYear), [birthYear]);

  if (!birth?.birth_datetime_utc || !location) {
    return (
      <Card title={t('varshaphala.heading')} data-testid="varshaphala-panel">
        <p className="text-sm text-text-secondary">{t('gate.no_chart')}</p>
      </Card>
    );
  }

  return (
    <div className="space-y-6" data-testid="varshaphala-panel">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h2 className="font-display text-2xl text-text-primary">{t('varshaphala.heading')}</h2>
          <p className="mt-1 max-w-2xl text-sm text-text-secondary">{t('varshaphala.subtitle')}</p>
        </div>
        <div className="flex items-center gap-3">
          <label htmlFor="varshaphala-year-select" className="text-sm text-text-secondary">
            {t('varshaphala.year_label')}
          </label>
          <Select
            id="varshaphala-year-select"
            aria-label={t('varshaphala.year_label')}
            value={String(targetYear)}
            onChange={(e) => setTargetYear(Number.parseInt(e.target.value, 10))}
            className="w-auto min-w-[7rem]"
            data-testid="varshaphala-year-select"
          >
            {years.map((y) => (
              <option key={y} value={String(y)}>
                {y} ({t('varshaphala.age_suffix', { age: y - birthYear })})
              </option>
            ))}
          </Select>
        </div>
      </div>

      {!engine && (
        <Card data-testid="varshaphala-warming">
          <p className="flex items-center gap-3 text-sm text-text-secondary">
            <Spinner size="sm" />
            <span>{t('gate.engine_warming')}</span>
          </p>
        </Card>
      )}

      {engine && loading && (
        <Card data-testid="varshaphala-loading">
          <p className="flex items-center gap-3 text-sm text-text-secondary">
            <Spinner size="sm" />
            <span>{t('varshaphala.computing', { year: targetYear })}</span>
          </p>
        </Card>
      )}

      {error && (
        <Card data-testid="varshaphala-error">
          <p className="text-sm text-status-error">{error}</p>
        </Card>
      )}

      {result && !loading && (
        <>
          <div className="grid gap-4 md:grid-cols-3">
            <Card title={t('varshaphala.solar_return_title')} data-testid="varshaphala-return-card">
              <p className="font-mono text-sm text-text-primary">
                {formatUtcStamp(result.solar_return_utc)}
              </p>
              <p className="mt-2 text-xs text-text-secondary">
                {t('varshaphala.varsha_lagna', {
                  sign: t(`sign.${result.varsha_chart.lagna.sign.toLowerCase()}`, {
                    defaultValue: result.varsha_chart.lagna.sign,
                  }),
                })}{' '}
                · {result.is_day_chart ? t('varshaphala.day_chart') : t('varshaphala.night_chart')}
              </p>
            </Card>

            <Card title={t('varshaphala.muntha_title')} data-testid="varshaphala-muntha-card">
              <p className="text-lg font-medium text-text-primary">
                {t(`sign.${result.muntha.sign.toLowerCase()}`, { defaultValue: result.muntha.sign })}
              </p>
              <p className="mt-1 text-xs text-text-secondary">
                {t('varshaphala.muntha_detail', {
                  house: result.muntha.house_from_varsha_lagna,
                  lord: t(`graha.${result.muntha.sign_lord.toLowerCase()}`, {
                    defaultValue: result.muntha.sign_lord,
                  }),
                })}
              </p>
            </Card>

            <Card title={t('varshaphala.varshesha_title')} data-testid="varshaphala-varshesha-card">
              <div className="flex items-center justify-between gap-2">
                <p className="text-lg font-medium text-text-primary">
                  {t(`graha.${result.varshesha.toLowerCase()}`, { defaultValue: result.varshesha })}
                </p>
                {result.panchavargiya_bala[result.varshesha] && (
                  <Badge variant={bandVariant(result.panchavargiya_bala[result.varshesha].dignity_band)}>
                    {result.panchavargiya_bala[result.varshesha].total.toFixed(1)} / 20
                  </Badge>
                )}
              </div>
              <p className="mt-1 text-xs text-text-secondary">{t('varshaphala.varshesha_note')}</p>
            </Card>
          </div>

          <div className="grid gap-6 lg:grid-cols-2">
            {varshaGeometry && (
              <Card title={t('varshaphala.chart_title', { year: result.target_year })}>
                <div className="mx-auto max-w-sm">
                  <NorthIndianChartSVG geometry={varshaGeometry} size={320} />
                </div>
              </Card>
            )}

            <Card title={t('varshaphala.mudda_title')} data-testid="varshaphala-mudda-table">
              <div className="overflow-x-auto">
                <table className="w-full text-left text-sm">
                  <thead>
                    <tr className="border-b border-ui-border text-xs text-text-tertiary">
                      <th className="py-2 pr-3 font-medium">{t('varshaphala.col_lord')}</th>
                      <th className="py-2 pr-3 font-medium">{t('varshaphala.col_start')}</th>
                      <th className="py-2 pr-3 font-medium">{t('varshaphala.col_end')}</th>
                      <th className="py-2 text-right font-medium">{t('varshaphala.col_days')}</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-ui-border/60">
                    {result.mudda_dasha.map((period) => (
                      <tr
                        key={`${period.lord}-${period.start_utc}`}
                        className={period.is_current ? 'bg-accent-gold/10 font-medium' : ''}
                      >
                        <td className="py-2 pr-3 text-text-primary">
                          {t(`graha.${period.lord.toLowerCase()}`, { defaultValue: period.lord })}
                          {period.is_current && (
                            <span className="ml-2 text-xs text-accent-gold">
                              ({t('periods.running')})
                            </span>
                          )}
                        </td>
                        <td className="py-2 pr-3 font-mono text-xs text-text-secondary">
                          {formatDisplayDate(new Date(period.start_utc), {
                            year: 'numeric',
                            month: 'short',
                            day: 'numeric',
                            timeZone: 'UTC',
                          })}
                        </td>
                        <td className="py-2 pr-3 font-mono text-xs text-text-secondary">
                          {formatDisplayDate(new Date(period.end_utc), {
                            year: 'numeric',
                            month: 'short',
                            day: 'numeric',
                            timeZone: 'UTC',
                          })}
                        </td>
                        <td className="py-2 text-right font-mono text-xs text-text-secondary">
                          {period.duration_days.toFixed(1)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>
          </div>

          <div className="grid gap-6 lg:grid-cols-2">
            <Card title={t('varshaphala.bala_title')}>
              <div className="overflow-x-auto">
                <table className="w-full text-left text-sm">
                  <thead>
                    <tr className="border-b border-ui-border text-xs text-text-tertiary">
                      <th className="py-2 pr-3 font-medium">{t('gochara.col_graha')}</th>
                      <th className="py-2 pr-3 text-right font-medium">{t('varshaphala.col_score')}</th>
                      <th className="py-2 text-right font-medium">{t('varshaphala.col_band')}</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-ui-border/60">
                    {Object.entries(result.panchavargiya_bala).map(([graha, bala]) => (
                      <tr key={graha}>
                        <td className="py-2 pr-3 text-text-primary">
                          {t(`graha.${graha.toLowerCase()}`, { defaultValue: graha })}
                        </td>
                        <td className="py-2 pr-3 text-right font-mono text-xs text-text-secondary">
                          {bala.total.toFixed(2)} / 20
                        </td>
                        <td className="py-2 text-right">
                          <Badge variant={bandVariant(bala.dignity_band)}>
                            {t(`varshaphala.band.${bala.dignity_band}`)}
                          </Badge>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>

            <Card title={t('varshaphala.yogas_title')} data-testid="varshaphala-yogas-card">
              {result.tajaka_yogas.length === 0 ? (
                <p className="text-sm text-text-secondary">{t('varshaphala.yogas_empty')}</p>
              ) : (
                <ul className="divide-y divide-ui-border/60">
                  {result.tajaka_yogas.slice(0, 10).map((yoga) => (
                    <li
                      key={`${yoga.name}-${yoga.faster_planet}-${yoga.slower_planet}`}
                      className="flex items-center justify-between gap-3 py-2 text-sm"
                    >
                      <div>
                        <span className="font-medium text-text-primary">{yoga.name}</span>
                        <span className="ml-2 text-text-secondary">
                          {t(`graha.${yoga.faster_planet.toLowerCase()}`, {
                            defaultValue: yoga.faster_planet,
                          })}{' '}
                          →{' '}
                          {t(`graha.${yoga.slower_planet.toLowerCase()}`, {
                            defaultValue: yoga.slower_planet,
                          })}
                        </span>
                      </div>
                      <span className="font-mono text-xs text-text-tertiary">
                        {yoga.aspect_type} · {yoga.orb_degrees.toFixed(1)}°
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          </div>
        </>
      )}
    </div>
  );
}
