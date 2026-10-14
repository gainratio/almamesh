/**
 * Life Atlas — pure helpers for the eight life-domain surfaces.
 *
 * The dashboard's Life Atlas grid and the `/life/:domain` detail pages share
 * this single source of truth for: the canonical domain order, route-slug
 * validation, "next timed window" selection, and the mapping from an engine
 * domain to its matching AI-interpretation section (where one exists — the
 * `family` and `obstacles` domains are deliberately engine-only, the structured
 * interpretation has no section for them and we never fake one).
 *
 * No astrology here: the engine emits `DomainsCtx` verbatim; these helpers
 * only select and route already-computed values.
 */

import type {
  DomainWindowData,
  LifeDomain,
  LifeDomainForecastData,
  Persona,
  VedicInterpretation,
} from '@almamesh/shared-types';

/** The eight canonical life domains, in stable render/route order. */
export const LIFE_DOMAINS: readonly LifeDomain[] = [
  'career',
  'finances',
  'health',
  'relationships',
  'spiritual',
  'education',
  'family',
  'obstacles',
];

const LIFE_DOMAIN_SET: ReadonlySet<string> = new Set(LIFE_DOMAINS);

/** Route-slug guard: `/life/:domain` only accepts the canonical slugs. */
export function isLifeDomain(value: string): value is LifeDomain {
  return LIFE_DOMAIN_SET.has(value);
}

/**
 * The earliest upcoming timed window for a domain, or null when the engine
 * emitted none. The engine already emits future windows; sorting defensively
 * keeps "next" honest even if emission order ever changes.
 */
export function nextWindow(forecast: LifeDomainForecastData): DomainWindowData | null {
  if (forecast.upcoming_windows.length === 0) {
    return null;
  }
  return [...forecast.upcoming_windows].sort((a, b) => a.date.localeCompare(b.date))[0];
}

/** Interpretation sections that carry per-domain guidance. */
export type DomainGuidanceKey =
  | 'career_guidance'
  | 'finances_guidance'
  | 'health_guidance'
  | 'relationship_guidance'
  | 'spiritual_guidance'
  | 'education_guidance';

/**
 * Engine domain → structured-interpretation section. `family` and `obstacles`
 * map to null: the interpretation schema has no section for them and the Life
 * Atlas labels those domains engine-only rather than borrowing an unrelated reading.
 */
export const DOMAIN_GUIDANCE_KEY: Record<LifeDomain, DomainGuidanceKey | null> = {
  career: 'career_guidance',
  finances: 'finances_guidance',
  health: 'health_guidance',
  relationships: 'relationship_guidance',
  spiritual: 'spiritual_guidance',
  education: 'education_guidance',
  family: null,
  obstacles: null,
};

/**
 * Domains whose name alone could mislead get one plain-language line under it
 * (an i18n key in the `life` namespace). Obstacles is framed as a theme to watch.
 */
export const DOMAIN_NOTE_KEY: Partial<Record<LifeDomain, string>> = {
  obstacles: 'atlas.obstacles_note',
};

/** The Life Atlas card's one short subtitle for a domain whose name alone could mislead; its note is the tooltip. */
export const DOMAIN_SUBTITLE_KEY: Partial<Record<LifeDomain, string>> = {
  obstacles: 'atlas.obstacles_subtitle',
};

/**
 * Whether a domain's natal strength band is its signal. Not for obstacles: the engine reads
 * that area by period activation and keeps its key graha's (Saturn's) Shadbala as context only
 * (recipe activation_only), so a "Strong" badge there would read as strong obstacles.
 */
export function showsStrengthBand(domain: LifeDomain): boolean {
  return domain !== 'obstacles';
}

/**
 * The AI-narrated guidance for a domain, or null when the interpretation (or
 * the matching section, or any usable text in it) is absent.
 */
export function domainGuidance(
  interpretation: VedicInterpretation | null | undefined,
  domain: LifeDomain,
): Persona | null {
  const key = DOMAIN_GUIDANCE_KEY[domain];
  if (!interpretation || key === null) {
    return null;
  }
  const section = interpretation[key];
  if (!section) {
    return null;
  }
  const hasText =
    (section.layman?.trim().length ?? 0) > 0 || (section.technical?.trim().length ?? 0) > 0;
  return hasText ? section : null;
}
