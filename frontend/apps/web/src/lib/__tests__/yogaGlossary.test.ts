import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { SiderealChart, YogaData } from '@almamesh/browser/types';
import {
  predictionClaims,
  reflectionIssues,
  type ReflectionLanguage,
} from '@almamesh/llm/reflection';
import enReport from '../../locales/en/report.json';
import hiReport from '../../locales/hi/report.json';
import esReport from '../../locales/es/report.json';
import ptReport from '../../locales/pt/report.json';
import { buildYogas } from '../../components/report-pdf/buildReportSections';
import {
  formatYogaBasisLine,
  formatYogaFormation,
  formatYogaMeaning,
  formatYogaMeaningLine,
} from '../yogaGlossary';

const CATALOGS: Readonly<Record<ReflectionLanguage, typeof enReport>> = {
  en: enReport,
  hi: hiReport,
  es: esReport,
  pt: ptReport,
};

function syntheticYoga(
  name: string,
  rule: string,
  planets: readonly string[] = ['jupiter'],
  description = 'Technical rule summary.',
): YogaData {
  return {
    name,
    display_name: name,
    category: 'raja',
    description,
    effects: 'SHORT_FALLBACK_SENTINEL',
    grade: 'strong',
    strength_factors: [],
    planets_involved: planets,
    houses_involved: [1],
    planetary_signature: `${name}-${rule}`,
    formation_rules: [
      {
        rule,
        description: `${name} formation detail`,
        source: 'BPHS',
        planets: [...planets],
        houses: [1],
      },
    ],
  };
}

const RULE_CASES: ReadonlyArray<readonly [string, string, readonly string[]]> = [
  ['Ruchaka Yoga', 'mahapurusha.kendra_dignity', ['mars']],
  ['Bhadra Yoga', 'mahapurusha.kendra_dignity', ['mercury']],
  ['Hamsa Yoga', 'mahapurusha.kendra_dignity', ['jupiter']],
  ['Malavya Yoga', 'mahapurusha.kendra_dignity', ['venus']],
  ['Sasa Yoga', 'mahapurusha.kendra_dignity', ['saturn']],
  ['Gajakesari Yoga', 'gajakesari.jupiter_kendra_from_moon', ['jupiter', 'moon']],
  ['Budha-Aditya Yoga', 'budha_aditya.conjunction', ['sun', 'mercury']],
  ['Chandra-Mangala Yoga', 'chandra_mangala.conjunction', ['moon', 'mars']],
  ['Guru-Mangala Yoga', 'guru_mangala.conjunction', ['jupiter', 'mars']],
  ['Sunapha Yoga', 'chandra.sunapha', ['mars']],
  ['Anapha Yoga', 'chandra.anapha', ['venus']],
  ['Durudhara Yoga', 'chandra.durudhara', ['mars', 'venus']],
  ['Kemadruma Yoga', 'chandra.kemadruma', ['moon']],
  ['Vesi Yoga', 'surya.vesi', ['mercury']],
  ['Vasi Yoga', 'surya.vasi', ['jupiter']],
  ['Ubhayachari Yoga', 'surya.ubhayachari', ['mercury', 'jupiter']],
  ['Adhi Yoga', 'adhi.benefics_678_from_moon', ['mercury', 'jupiter', 'venus']],
  ['Amala Yoga', 'amala.benefic_only_10th', ['jupiter']],
  ['Shubha Kartari Yoga', 'kartari.shubha', ['venus', 'jupiter']],
  ['Papa Kartari Yoga', 'kartari.papa', ['mars', 'saturn']],
  ['Raja Yoga', 'raja.kendra_trikona_conjunction', ['sun', 'venus']],
  ['Yogakaraka', 'yogakaraka.kendra_trikona_lord', ['venus']],
  ['Neecha Bhanga Raja Yoga', 'neecha_bhanga.dispositor_in_kendra', ['jupiter', 'saturn']],
  ['Vipareeta Raja Yoga', 'vipareeta.harsha', ['saturn']],
  ['Vipareeta Raja Yoga', 'vipareeta.sarala', ['mars']],
  ['Vipareeta Raja Yoga', 'vipareeta.vimala', ['jupiter']],
  ['Parivartana Yoga', 'parivartana.maha', ['sun', 'jupiter']],
  ['Parivartana Yoga', 'parivartana.khala', ['mars', 'mercury']],
  ['Parivartana Yoga', 'parivartana.dainya', ['saturn', 'venus']],
  ['Dhana Yoga', 'dhana.lord_placed', ['jupiter', 'mercury']],
  ['Kala Sarpa Yoga', 'kala_sarpa.all_grahas_one_side', ['rahu', 'ketu']],
  ['Chatussagara Yoga', 'chatussagara.all_kendras_occupied', ['sun', 'moon', 'mars', 'jupiter']],
  ['Saraswati Yoga', 'saraswati.benefics_kendra_trikona_2nd', ['mercury', 'jupiter', 'venus']],
];

describe('yogaGlossary — locale parity and reflection discipline', () => {
  it('defines identical 35 glossary keys across en, hi, es, and pt with zero reflection violations', () => {
    const enKeys = Object.keys(enReport.yogas.glossary).sort();
    expect(enKeys).toHaveLength(35);

    for (const [lang, catalog] of Object.entries(CATALOGS) as [
      ReflectionLanguage,
      typeof enReport,
    ][]) {
      expect(Object.keys(catalog.yogas.glossary).sort()).toEqual(enKeys);
      expect(catalog.yogas.primer.trim().length).toBeGreaterThan(40);
      expect(catalog.yogas.meaning_label.trim().length).toBeGreaterThan(2);
      expect(catalog.yogas.formation_label.trim().length).toBeGreaterThan(2);
      expect(catalog.pdf.yogas_intro.trim().length).toBeGreaterThan(40);

      for (const [key, value] of [
        ['primer', catalog.yogas.primer],
        ['pdf.yogas_intro', catalog.pdf.yogas_intro],
        ...Object.entries(catalog.yogas.glossary),
      ]) {
        expect(predictionClaims(value, lang), `${lang}:${key}`).toEqual([]);
        expect(reflectionIssues(value), `${lang}:${key}`).toEqual([]);
      }
    }
  });

  it('resolves every engine rule ID and name subtype without falling back to terse effects', () => {
    const seenMeanings = new Set<string>();
    for (const [name, rule, planets] of RULE_CASES) {
      const yoga = syntheticYoga(name, rule, planets);
      const meaning = formatYogaMeaning(yoga);
      expect(meaning, `${name} (${rule})`).not.toBe('SHORT_FALLBACK_SENTINEL');
      expect(meaning.length).toBeGreaterThan(45);
      seenMeanings.add(meaning);
    }
    expect(seenMeanings.size).toBe(RULE_CASES.length);

    // Name-only fallbacks when an older payload carries an unrecognized rule ID
    expect(formatYogaMeaning(syntheticYoga('Vipareeta Raja Yoga', 'custom', ['saturn'], 'Harsha subtype'))).toContain(
      'Harsha',
    );
    expect(formatYogaMeaning(syntheticYoga('Vipareeta Raja Yoga', 'custom', ['saturn'], 'Plain reversal'))).toContain(
      'challenging house',
    );
    expect(formatYogaMeaning(syntheticYoga('Parivartana Yoga', 'custom', ['sun', 'venus'], 'Mutual exchange'))).toContain(
      'mutual reception',
    );
  });

  it('covers 100% of formed yogas across chart_golden_de421.json and populates PDF meaning + basis', () => {
    const goldenPath = resolve(
      __dirname,
      '../../../../../../backend/tests/fixtures/chart_golden_de421.json',
    );
    const raw = JSON.parse(readFileSync(goldenPath, 'utf8')) as Record<
      string,
      { readonly chart?: SiderealChart } & Partial<SiderealChart>
    >;
    let totalYogas = 0;

    for (const [chartId, entry] of Object.entries(raw)) {
      const chart = (entry.chart ?? entry) as SiderealChart;
      if (!Array.isArray(chart.yogas)) continue;
      const pdfYogas = buildYogas(chart);
      expect(pdfYogas).toHaveLength(chart.yogas.length);

      chart.yogas.forEach((yoga, idx) => {
        totalYogas += 1;
        const meaning = formatYogaMeaning(yoga);
        expect(meaning, `${chartId}:${yoga.name}`).not.toBe(yoga.effects);
        expect(meaning.length, `${chartId}:${yoga.name}`).toBeGreaterThan(45);
        expect(formatYogaMeaningLine(yoga)).toMatch(/^What it means: /);
        expect(formatYogaBasisLine(yoga)).toMatch(/^In this chart: /);
        expect(pdfYogas[idx]?.meaning).toContain('What it means:');
        expect(pdfYogas[idx]?.basis).toContain('In this chart:');
      });
    }
    expect(totalYogas).toBeGreaterThan(20);
  });

  it('joins multi-rule formations while deduplicating identical classical sources', () => {
    const neechaBhanga: YogaData = {
      ...syntheticYoga('Neecha Bhanga Raja Yoga', 'neecha_bhanga.dispositor_in_kendra'),
      formation_rules: [
        {
          rule: 'neecha_bhanga.dispositor_in_kendra',
          description: 'Saturn (lord of Capricorn) in kendra from Ascendant',
          source: 'BPHS / Phaladeepika 6.26–30',
          planets: ['jupiter', 'saturn'],
          houses: [1],
        },
        {
          rule: 'neecha_bhanga.exaltation_lord_of_sign_in_kendra',
          description: 'Mars (exalted in Capricorn) in kendra from Moon',
          source: 'BPHS / Phaladeepika 6.26–30',
          planets: ['jupiter', 'mars'],
          houses: [4],
        },
      ],
    };
    const formation = formatYogaFormation(neechaBhanga);
    expect(formation.basis).toBe(
      'Saturn (lord of Capricorn) in kendra from Ascendant; Mars (exalted in Capricorn) in kendra from Moon',
    );
    expect(formation.sources).toBe('BPHS / Phaladeepika 6.26–30');
  });
});
