/**
 * PlanetaryTable — scannable planetary positions, observatory style.
 *
 * Built on the `@almamesh/store` `ChartGeometry` model and the shared UI
 * primitives (`Card`, `Badge`). It RESHAPES engine data only; no astrology is
 * computed here.
 *
 * Two entry shapes are accepted so existing callers keep working:
 *   • `geometry` — the preferred, degree-accurate path.
 *   • `planets`  — the legacy raw `SiderealPlanet` record (adapted internally).
 *
 * Columns: Planet (glyph + name), Sign, Degree (mono, in-sign), House,
 * Nakshatra (Pada), Dignity (status-coloured Badge), Lords (engine
 * `houses_ruled`, with the Yogakaraka mark), Retro, Combust. Honest by
 * construction: NO per-planet strength numbers live here — the real,
 * quantified Ṣaḍbala/Aṣṭakavarga strength is computed lazily in the
 * Predictive panel, which the table footer points to.
 */

import type { ReactElement } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { colors } from '@almamesh/constants';
import type { ChartGeometry, ChartPlanet } from '@almamesh/store';
import type { SiderealPlanet } from '@almamesh/shared-types';
import { Badge, Card } from '../../ui';
import { cn } from '../../ui/cn';

interface SharedSelectionProps {
  readonly selectedPlanet?: string | null;
  readonly onSelectPlanet?: (id: string | null) => void;
}

interface GeometryProps extends SharedSelectionProps {
  readonly geometry: ChartGeometry;
  readonly planets?: never;
}

interface LegacyProps extends SharedSelectionProps {
  readonly planets: Record<string, SiderealPlanet> | null;
  readonly geometry?: never;
}

export type PlanetaryTableProps = GeometryProps | LegacyProps;

const PLANET_ORDER: readonly string[] = [
  'sun',
  'moon',
  'mars',
  'mercury',
  'jupiter',
  'venus',
  'saturn',
  'rahu',
  'ketu',
];

const PLANET_LABELS: Readonly<Record<string, string>> = {
  sun: 'Su',
  moon: 'Mo',
  mars: 'Ma',
  mercury: 'Me',
  jupiter: 'Ju',
  venus: 'Ve',
  saturn: 'Sa',
  rahu: 'Ra',
  ketu: 'Ke',
};

type BadgeVariant = 'default' | 'brass' | 'lapis' | 'success' | 'warning' | 'error';

/** Map an engine dignity string onto a Badge variant + human label. */
function dignityBadge(dignity: string): { variant: BadgeVariant; label: string } | null {
  switch (dignity.toLowerCase()) {
    case 'exalted':
      return { variant: 'success', label: 'Exalted' };
    case 'debilitated':
      return { variant: 'error', label: 'Debilitated' };
    case 'own':
    case 'own_sign':
      return { variant: 'lapis', label: 'Own' };
    case 'moolatrikona':
      return { variant: 'brass', label: 'Moolatrikona' };
    case 'great_friend':
    case 'friend':
      return { variant: 'default', label: 'Friend' };
    case 'enemy':
    case 'bitter_enemy':
      return { variant: 'default', label: 'Enemy' };
    case 'neutral':
      return { variant: 'default', label: 'Neutral' };
    default:
      return dignity ? { variant: 'default', label: titleCase(dignity) } : null;
  }
}

function titleCase(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1).replace(/_/g, ' ');
}

/** `12°34'` from a 0–30 in-sign degree. */
function formatSignDegrees(signDegrees: number): string {
  const whole = Math.floor(signDegrees);
  const minutes = Math.floor((signDegrees - whole) * 60);
  return `${whole}°${String(minutes).padStart(2, '0')}'`;
}

function formatNakshatra(nakshatra: string, pada: number): string {
  if (!nakshatra) return '—';
  const name = nakshatra.split(' (')[0];
  return `${name} · ${pada}`;
}

/** The legacy `SiderealPlanet` lacks in-sign degrees; derive from longitude. */
function inSignDegrees(longitude: number): number {
  return ((longitude % 30) + 30) % 30;
}

/** Adapt a single legacy `SiderealPlanet` into the geometry planet shape. */
function fromLegacy(name: string, raw: SiderealPlanet): ChartPlanet {
  return {
    name,
    label: PLANET_LABELS[name] ?? name.slice(0, 2),
    longitude: raw.longitude,
    sign: raw.sign as ChartPlanet['sign'],
    signIndex: 0,
    signDegrees: inSignDegrees(raw.longitude),
    house: raw.house,
    nakshatra: raw.nakshatra ?? '',
    pada: raw.nakshatra_pada ?? 0,
    dignity: '',
    isRetrograde: Boolean(raw.is_retrograde),
    isCombust: Boolean(raw.is_combust),
    // The legacy `SiderealPlanet` never carried the separation. null means
    // "not measured here", which a renderer must show as absent rather than
    // as a confident 0.00 degrees.
    combustionSeparationDeg: null,
    housesRuled: raw.houses_ruled ?? [],
    isYogakaraka: Boolean(raw.is_yogakaraka),
    color: colors.text.muted,
  };
}

/** Resolve either entry shape to an ordered planet list. */
function resolvePlanets(props: PlanetaryTableProps): readonly ChartPlanet[] {
  if (props.geometry) {
    const byName = new Map(props.geometry.planets.map((p) => [p.name, p]));
    return PLANET_ORDER.map((n) => byName.get(n)).filter(
      (p): p is ChartPlanet => p !== undefined,
    );
  }
  const raw = props.planets;
  if (!raw) return [];
  return PLANET_ORDER.filter((n) => raw[n]).map((n) => fromLegacy(n, raw[n]));
}

const TH = 'px-3 py-2 text-left font-mono text-xs font-medium tracking-wide text-text-muted';
const TD = 'px-3 py-2.5 align-middle text-text-secondary';

export function PlanetaryTable(props: PlanetaryTableProps): ReactElement {
  const { t } = useTranslation('astrology');
  const planets = resolvePlanets(props);

  if (planets.length === 0) {
    return (
      <Card title={t('planetary.title')} subtitle={t('planetary.subtitle')}>
        <p className="text-sm text-text-muted">{t('planetary.unavailable')}</p>
      </Card>
    );
  }

  return (
    <Card title={t('planetary.title')} subtitle={t('planetary.subtitle')}>
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className="border-b border-ui-border">
              <th scope="col" className={TH}>{t('tables.planet')}</th>
              <th scope="col" className={TH}>{t('tables.sign')}</th>
              <th scope="col" className={cn(TH, 'text-right')}>{t('tables.degree')}</th>
              <th scope="col" className={cn(TH, 'text-right')}>{t('tables.house')}</th>
              <th scope="col" className={TH}>{t('tables.nakshatra_pada')}</th>
              <th scope="col" className={TH}>{t('tables.dignity')}</th>
              <th scope="col" className={TH}>{t('tables.lords')}</th>
              <th scope="col" className={TH}>{t('tables.retro')}</th>
              <th scope="col" className={TH}>{t('tables.combust')}</th>
            </tr>
          </thead>
          <tbody>
            {planets.map((planet) => {
              const dignity = dignityBadge(planet.dignity);
              const isSelected = props.selectedPlanet === planet.name;
              const handleToggle = () => {
                props.onSelectPlanet?.(isSelected ? null : planet.name);
              };
              return (
                <tr
                  key={planet.name}
                  onClick={props.onSelectPlanet ? handleToggle : undefined}
                  className={cn(
                    'border-b border-ui-border-dark transition-colors last:border-0',
                    props.onSelectPlanet && 'cursor-pointer',
                    isSelected
                      ? 'bg-accent-gold/12 hover:bg-accent-gold/16'
                      : 'hover:bg-background-tertiary/40',
                  )}
                >
                  <td className={cn(TD, 'whitespace-nowrap')}>
                    {props.onSelectPlanet ? (
                      <button
                        type="button"
                        aria-pressed={isSelected}
                        onClick={(e) => {
                          e.stopPropagation();
                          handleToggle();
                        }}
                        className="inline-flex min-h-6 items-center gap-2 rounded px-1 py-0.5 text-left focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-gold"
                      >
                        <span
                          className="inline-flex h-5 w-7 items-center justify-center rounded-sm font-mono text-[11px] font-semibold"
                          style={{ color: planet.color, backgroundColor: `${planet.color}1A` }}
                        >
                          {planet.label}
                        </span>
                        <span className="capitalize text-text-primary">{planet.name}</span>
                      </button>
                    ) : (
                      <span className="inline-flex items-center gap-2">
                        <span
                          className="inline-flex h-5 w-7 items-center justify-center rounded-sm font-mono text-[11px] font-semibold"
                          style={{ color: planet.color, backgroundColor: `${planet.color}1A` }}
                        >
                          {planet.label}
                        </span>
                        <span className="capitalize text-text-primary">{planet.name}</span>
                      </span>
                    )}
                  </td>
                  <td className={cn(TD, 'capitalize')}>{planet.sign}</td>
                  <td className={cn(TD, 'text-right font-mono text-text-primary')}>
                    {formatSignDegrees(planet.signDegrees)}
                  </td>
                  <td className={cn(TD, 'text-right font-mono')}>{planet.house}</td>
                  <td className={TD}>{formatNakshatra(planet.nakshatra, planet.pada)}</td>
                  <td className={TD}>
                    {dignity ? (
                      <Badge variant={dignity.variant}>{dignity.label}</Badge>
                    ) : (
                      <span className="text-text-muted">—</span>
                    )}
                  </td>
                  <td className={cn(TD, 'whitespace-nowrap')}>
                    {planet.housesRuled.length > 0 ? (
                      <span className="inline-flex items-center gap-1.5">
                        <span className="font-mono">{planet.housesRuled.join(', ')}</span>
                        {planet.isYogakaraka && (
                          <Badge variant="brass" aria-label={t('planetary.yogakaraka_aria')}>
                            ★
                          </Badge>
                        )}
                      </span>
                    ) : (
                      // Rahu/Ketu lord no sign in the Parashari scheme.
                      <span className="text-text-muted">—</span>
                    )}
                  </td>
                  <td className={TD}>
                    {planet.isRetrograde ? (
                      <Badge variant="warning" aria-label={t('planetary.retrograde_aria')}>
                        ℞
                      </Badge>
                    ) : (
                      <span className="text-text-muted">—</span>
                    )}
                  </td>
                  <td className={TD}>
                    {planet.isCombust ? (
                      <Badge variant="error" aria-label={t('planetary.combust_aria')}>
                        ☉
                      </Badge>
                    ) : (
                      <span className="text-text-muted">—</span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {/* Quiet pointer: quantified strength is real, lazy, and lives elsewhere. */}
      <p className="mt-3 border-t border-ui-border-dark pt-3 text-xs leading-relaxed text-text-tertiary">
        {t('planetary.strength_pointer')}{' '}
        <Link
          to="/predictive"
          className="text-accent-gold transition-colors hover:text-accent-gold-bright"
        >
          {t('planetary.strength_pointer_link')}
        </Link>
      </p>
    </Card>
  );
}
