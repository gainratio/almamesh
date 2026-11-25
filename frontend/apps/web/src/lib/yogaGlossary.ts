/**
 * Deterministic plain-language glossary and chart-formation formatter for the
 * classical yogas emitted by `almamesh.yogas.rules`. Recomputes zero astrology:
 * maps engine rule IDs and canonical yoga names onto localized reflective copy.
 */

import type { TFunction } from 'i18next';
import type { YogaData } from '@almamesh/browser/types';
import enReport from '../locales/en/report.json';

type YogaGlossaryKey = keyof typeof enReport.yogas.glossary;

const MAHAPURUSHA_BY_PLANET: Readonly<Record<string, YogaGlossaryKey>> = {
  mars: 'ruchaka',
  mercury: 'bhadra',
  jupiter: 'hamsa',
  venus: 'malavya',
  saturn: 'sasa',
};

const RULE_TO_KEY: Readonly<Record<string, YogaGlossaryKey>> = {
  gajakesari: 'gajakesari',
  'gajakesari.jupiter_kendra_from_moon': 'gajakesari',
  'budha_aditya.conjunction': 'budha_aditya',
  'chandra_mangala.conjunction': 'chandra_mangala',
  'guru_mangala.conjunction': 'guru_mangala',
  'chandra.sunapha': 'sunapha',
  'chandra.anapha': 'anapha',
  'chandra.durudhara': 'durudhara',
  'chandra.kemadruma': 'kemadruma',
  'surya.vesi': 'vesi',
  'surya.vasi': 'vasi',
  'surya.ubhayachari': 'ubhayachari',
  'adhi.benefics_678_from_moon': 'adhi',
  'amala.benefic_only_10th': 'amala',
  'kartari.shubha': 'shubha_kartari',
  'kartari.papa': 'papa_kartari',
  'yogakaraka.kendra_trikona_lord': 'yogakaraka',
  'vipareeta.harsha': 'vipareeta_harsha',
  'vipareeta.sarala': 'vipareeta_sarala',
  'vipareeta.vimala': 'vipareeta_vimala',
  'parivartana.maha': 'parivartana_maha',
  'parivartana.khala': 'parivartana_khala',
  'parivartana.dainya': 'parivartana_dainya',
  'kala_sarpa.all_grahas_one_side': 'kala_sarpa',
  'chatussagara.all_kendras_occupied': 'chatussagara',
  'saraswati.benefics_kendra_trikona_2nd': 'saraswati',
};

const NAME_TO_KEY: Readonly<Record<string, YogaGlossaryKey>> = {
  ruchaka: 'ruchaka',
  bhadra: 'bhadra',
  hamsa: 'hamsa',
  malavya: 'malavya',
  sasa: 'sasa',
  shasha: 'sasa',
  gajakesari: 'gajakesari',
  gaja_kesari: 'gajakesari',
  budha_aditya: 'budha_aditya',
  chandra_mangala: 'chandra_mangala',
  guru_mangala: 'guru_mangala',
  sunapha: 'sunapha',
  anapha: 'anapha',
  durudhara: 'durudhara',
  kemadruma: 'kemadruma',
  vesi: 'vesi',
  vasi: 'vasi',
  ubhayachari: 'ubhayachari',
  adhi: 'adhi',
  amala: 'amala',
  shubha_kartari: 'shubha_kartari',
  papa_kartari: 'papa_kartari',
  raja: 'raja',
  yogakaraka: 'yogakaraka',
  neecha_bhanga: 'neecha_bhanga',
  neecha_bhanga_raja: 'neecha_bhanga',
  dhana: 'dhana',
  kala_sarpa: 'kala_sarpa',
  chatussagara: 'chatussagara',
  saraswati: 'saraswati',
};

const VIPAREETA_SUBTYPES: ReadonlyArray<readonly [RegExp, YogaGlossaryKey]> = [
  [/\bharsha\b/i, 'vipareeta_harsha'],
  [/\bsarala\b/i, 'vipareeta_sarala'],
  [/\bvimala\b/i, 'vipareeta_vimala'],
];

const PARIVARTANA_SUBTYPES: ReadonlyArray<readonly [RegExp, YogaGlossaryKey]> = [
  [/\bmaha\b/i, 'parivartana_maha'],
  [/\bkhala\b/i, 'parivartana_khala'],
  [/\bdainya\b/i, 'parivartana_dainya'],
];

function uniqueParts(values: readonly string[], separator = '; '): string {
  const seen = new Set<string>();
  const kept = values.map((v) => v.trim()).filter((v) => v.length > 0 && !seen.has(v) && seen.add(v));
  return kept.join(separator);
}

function normalizeYogaSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/\([^)]*\)/g, '')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .replace(/_yoga$/, '');
}

function resolveSubtype(
  yoga: YogaData,
  patterns: ReadonlyArray<readonly [RegExp, YogaGlossaryKey]>,
  fallback: YogaGlossaryKey,
): YogaGlossaryKey {
  const haystack = `${yoga.display_name} ${yoga.description}`;
  const hit = patterns.find(([regex]) => regex.test(haystack));
  return hit ? hit[1] : fallback;
}

function resolveByRule(yoga: YogaData): YogaGlossaryKey | null {
  const rule = yoga.formation_rules[0]?.rule?.trim().toLowerCase() ?? '';
  if (!rule) return null;
  if (rule === 'mahapurusha.kendra_dignity') {
    const planet = yoga.planets_involved[0]?.toLowerCase() ?? '';
    return MAHAPURUSHA_BY_PLANET[planet] ?? null;
  }
  if (RULE_TO_KEY[rule]) return RULE_TO_KEY[rule];
  if (rule.startsWith('raja.')) return 'raja';
  if (rule.startsWith('neecha_bhanga.')) return 'neecha_bhanga';
  if (rule.startsWith('dhana.')) return 'dhana';
  return null;
}

function resolveYogaKey(yoga: YogaData): YogaGlossaryKey | null {
  const byRule = resolveByRule(yoga);
  if (byRule) return byRule;
  const slug = normalizeYogaSlug(yoga.name);
  if (NAME_TO_KEY[slug]) return NAME_TO_KEY[slug];
  if (slug === 'vipareeta' || slug === 'vipareeta_raja') {
    return resolveSubtype(yoga, VIPAREETA_SUBTYPES, 'vipareeta');
  }
  if (slug === 'parivartana') {
    return resolveSubtype(yoga, PARIVARTANA_SUBTYPES, 'parivartana');
  }
  return null;
}

/** Plain-language reflective meaning for a formed yoga (localized or English fallback). */
export function formatYogaMeaning(yoga: YogaData, tr?: TFunction): string {
  const key = resolveYogaKey(yoga);
  if (!key) {
    return yoga.effects.trim();
  }
  return tr ? tr(`yogas.glossary.${key}`) : enReport.yogas.glossary[key];
}

/** Pre-labeled meaning line ("What it means: ...") for PDF cards. */
export function formatYogaMeaningLine(yoga: YogaData, tr?: TFunction): string | undefined {
  const meaning = formatYogaMeaning(yoga, tr);
  if (!meaning) return undefined;
  const label = tr ? tr('yogas.meaning_label') : enReport.yogas.meaning_label;
  return `${label}: ${meaning}`;
}

/** Deduplicated chart-specific formation text and classical text citations. */
export function formatYogaFormation(yoga: YogaData): {
  readonly basis: string;
  readonly sources: string;
} {
  return {
    basis: uniqueParts(yoga.formation_rules.map((r) => r.description)),
    sources: uniqueParts(yoga.formation_rules.map((r) => r.source)),
  };
}

/** Pre-labeled formation + source line ("In this chart: ... — BPHS") for PDF cards. */
export function formatYogaBasisLine(yoga: YogaData, tr?: TFunction): string | undefined {
  const { basis, sources } = formatYogaFormation(yoga);
  if (!basis) return undefined;
  const label = tr ? tr('yogas.formation_label') : enReport.yogas.formation_label;
  return sources ? `${label}: ${basis} — ${sources}` : `${label}: ${basis}`;
}
