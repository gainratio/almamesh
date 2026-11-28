/**
 * `subperiodGuide` — pure, deterministic presenter for Vimśottarī sub-periods
 * (Antardaśā & Pratyantardaśā). Computes ZERO astrology in TypeScript (`CLAUDE.md`
 * Rule #2): formats verbatim engine natal fields + dated `TransitCtx` events
 * overlapping `[startDate, endDate]`, honoring `layman` ("For You") vs `astrologer`.
 */
import type { TFunction } from 'i18next';
import type { TransitCtx } from '@almamesh/shared-types';
import { grahaName, signName } from './predictiveEventCopy';
import { collectSkyBullets, type SlowHitItem } from './subperiodSky';

export type SubperiodAudience = 'layman' | 'astrologer';

export interface SubperiodPlanetFact {
  readonly house: number;
  readonly sign: string;
  readonly houses_ruled?: readonly number[];
  readonly dignity?: string;
  readonly is_yogakaraka?: boolean;
  readonly is_retrograde?: boolean;
  readonly is_combust?: boolean;
}

export interface SubperiodYogaFact {
  readonly display_name: string;
  readonly planets_involved: readonly string[];
}

export interface SubperiodGuideInput {
  readonly mahaLord: string;
  readonly subLord: string;
  readonly parentAntarLord?: string;
  readonly level: 'antar' | 'pratyantar';
  readonly startDate: string;
  readonly endDate: string;
  readonly audience: SubperiodAudience;
  readonly planets?: Readonly<Record<string, SubperiodPlanetFact>> | null;
  readonly yogas?: readonly SubperiodYogaFact[] | null;
  readonly transitCtx?: TransitCtx;
  readonly sortedHits?: readonly SlowHitItem[];
  readonly t: TFunction;
}

export interface SubperiodGuide {
  readonly meaning: string;
  readonly bullets: readonly string[];
}

const KNOWN_LORDS = new Set(['sun', 'moon', 'mars', 'mercury', 'jupiter', 'venus', 'saturn', 'rahu', 'ketu']);
const NODES = new Set(['rahu', 'ketu']);
const STEADY_DIGNITIES = new Set(['exalted', 'own', 'own_sign', 'great_friend', 'friend']);
const CAREFUL_DIGNITIES = new Set(['debilitated', 'enemy', 'bitter_enemy']);

function findPlanet(
  planets: Readonly<Record<string, SubperiodPlanetFact>> | null | undefined,
  lord: string,
): SubperiodPlanetFact | null {
  if (!planets) return null;
  return planets[lord.toLowerCase()] ?? planets[lord] ?? null;
}

function buildMeaning(input: SubperiodGuideInput): string {
  const { t, audience, level } = input;
  const mahaKey = input.mahaLord.toLowerCase();
  const subKey = input.subLord.toLowerCase();
  const maha = grahaName(t, mahaKey);
  const sub = grahaName(t, subKey);
  const subTheme = KNOWN_LORDS.has(subKey) ? t(`predictive:subperiod.core.${subKey}.${audience}`) : sub;
  if (level === 'pratyantar') {
    const antar = grahaName(t, (input.parentAntarLord ?? input.mahaLord).toLowerCase());
    return t(`predictive:subperiod.meaning.pratyantar.${audience}`, { maha, antar, sub, subTheme });
  }
  if (mahaKey === subKey) return t(`predictive:subperiod.meaning.antar_same.${audience}`, { maha, subTheme });
  const mahaTheme = KNOWN_LORDS.has(mahaKey) ? t(`predictive:subperiod.core.${mahaKey}.${audience}`) : maha;
  return t(`predictive:subperiod.meaning.antar_pair.${audience}`, { maha, mahaTheme, sub, subTheme });
}

function buildPlacementBullet(
  t: TFunction,
  subKey: string,
  planet: SubperiodPlanetFact,
  audience: SubperiodAudience,
): string | null {
  if (planet.house < 1 || planet.house > 12) return null;
  const ruled = (planet.houses_ruled ?? []).filter((h) => h >= 1 && h <= 12);
  if (audience === 'layman') {
    const placedArea = t(`predictive:subperiod.house_area.${planet.house}`);
    const ruledAreas = ruled.filter((h) => h !== planet.house).map((h) => t(`predictive:subperiod.house_area.${h}`));
    return ruledAreas.length > 0
      ? t('predictive:subperiod.placement.ruled_layman', { placedArea, ruledAreas: ruledAreas.join(', ') })
      : t('predictive:subperiod.placement.single_layman', { placedArea });
  }
  const sub = grahaName(t, subKey);
  const sign = signName(t, planet.sign.toLowerCase());
  if (ruled.length > 0) {
    const ruledHouses = ruled.map((h) => t('predictive:gochara.house_n', { house: h })).join(', ');
    return t('predictive:subperiod.placement.ruled_astrologer', { sub, house: planet.house, sign, ruledHouses });
  }
  const key = NODES.has(subKey) ? 'node_astrologer' : 'plain_astrologer';
  return t(`predictive:subperiod.placement.${key}`, { sub, house: planet.house, sign });
}

function laymanFootingKey(planet: SubperiodPlanetFact): 'steady' | 'careful' | 'balanced' {
  const dignity = planet.dignity?.toLowerCase() ?? '';
  if (CAREFUL_DIGNITIES.has(dignity)) return 'careful';
  if (STEADY_DIGNITIES.has(dignity) || planet.is_yogakaraka) return 'steady';
  return 'balanced';
}

function buildAstrologerConditionNotes(
  t: TFunction,
  subKey: string,
  planet: SubperiodPlanetFact | null,
  matchedYogas: readonly string[],
): string[] {
  const notes: string[] = [];
  const rawDignity = planet?.dignity?.toLowerCase() ?? '';
  if (planet?.is_yogakaraka) notes.push(t('predictive:subperiod.condition.tag_yogakaraka'));
  if (rawDignity.length > 0) notes.push(t(`predictive:dignity.${rawDignity === 'own_sign' ? 'own' : rawDignity}`));
  if (planet?.is_retrograde && !NODES.has(subKey)) notes.push(t('predictive:gochara.retrograde'));
  if (planet?.is_combust) notes.push(t('predictive:subperiod.condition.tag_combust'));
  if (matchedYogas.length > 0) notes.push(t('predictive:subperiod.condition.tag_yogas', { yogas: matchedYogas.join(', ') }));
  return notes;
}

function buildConditionBullet(
  t: TFunction,
  subKey: string,
  planet: SubperiodPlanetFact | null,
  yogas: readonly SubperiodYogaFact[] | null | undefined,
  audience: SubperiodAudience,
): string | null {
  if (audience === 'astrologer') {
    const matchedYogas = (yogas ?? [])
      .filter((y) => y.planets_involved.some((p) => p.toLowerCase() === subKey))
      .slice(0, 2)
      .map((y) => y.display_name);
    const notes = buildAstrologerConditionNotes(t, subKey, planet, matchedYogas);
    return notes.length > 0
      ? t('predictive:subperiod.condition.astrologer_line', { sub: grahaName(t, subKey), notes: notes.join(' · ') })
      : null;
  }
  if (!planet) return null;
  const parts = [t(`predictive:subperiod.condition.${laymanFootingKey(planet)}_layman`)];
  if (planet.is_retrograde && !NODES.has(subKey)) parts.push(t('predictive:subperiod.condition.retro_layman'));
  if (planet.is_combust) parts.push(t('predictive:subperiod.condition.combust_layman'));
  return parts.join(' ');
}

export function buildSubperiodGuide(input: SubperiodGuideInput): SubperiodGuide {
  const { t, audience } = input;
  const subKey = input.subLord.toLowerCase();
  const bullets: string[] = KNOWN_LORDS.has(subKey) ? [t(`predictive:subperiod.focus.${subKey}.${audience}`)] : [];
  const planet = findPlanet(input.planets, subKey);
  const placement = planet ? buildPlacementBullet(t, subKey, planet, audience) : null;
  if (placement) bullets.push(placement);
  const condition = buildConditionBullet(t, subKey, planet, input.yogas, audience);
  if (condition) bullets.push(condition);
  bullets.push(
    ...collectSkyBullets({
      t,
      transitCtx: input.transitCtx,
      sortedHits: input.sortedHits,
      startDate: input.startDate,
      endDate: input.endDate,
      audience,
    }),
  );
  return { meaning: buildMeaning(input), bullets: bullets.slice(0, 6) };
}
