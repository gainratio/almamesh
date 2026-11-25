import { describe, expect, it } from 'vitest';
import type { YogaData } from '@almamesh/browser/types';
import i18n from '../../i18n/config';
import { formatYogaActivation } from '../yogaActivation';
import { buildEvidenceLedger } from '../evidence';
import { buildEvidenceSection } from '../../components/report-pdf/buildEvidenceSection';
import { buildTransitsSection } from '../../components/report-pdf/buildComprehensiveSections';
import { nearCuspChart } from '../evidence/__tests__/evidenceFixtures';
import { TRANSIT_CTX } from '../../test/predictiveFixtures';

const REAL_YOGA_OBSERVATION = `yoga:${nearCuspChart().yogas[0]!.name}`;

describe('formatYogaActivation — deterministic Yoga × Daśā activation across locales', () => {
  const rajaYoga: YogaData = {
    name: 'Raja Yoga',
    display_name: 'Sun-Venus Raja Yoga',
    category: 'raja',
    description: 'Association of kendra and trikona lords',
    effects: 'Constructive responsibility',
    grade: 'moderate',
    strength_factors: [],
    planets_involved: ['sun', 'venus'],
    houses_involved: [1],
    planetary_signature: 'sun+venus',
    formation_rules: [],
    dasha_activation: {
      status: 'direct',
      direct_lords: [{ level: 'antar', lord: 'venus' }],
      dispositor_chains: [
        { level: 'maha', lord: 'saturn', chain: ['saturn', 'venus'] },
        { level: 'pratyantar', lord: 'ketu', chain: ['ketu', 'mercury', 'saturn', 'venus'] },
      ],
      aspect_links: [{ level: 'maha', lord: 'saturn', target: 'venus', house_offset: 10 }],
      mitigating_factors: [
        { kind: 'combust', planet: 'venus' },
        { kind: 'lagna_near_cusp' },
      ],
    },
  };

  it.each(['en', 'hi', 'es', 'pt'] as const)(
    'formats direct, dispositor chain, drishti, and mitigating factors cleanly in %s',
    (lng) => {
      const tr = i18n.getFixedT(lng, 'report');
      const tp = i18n.getFixedT(lng, 'predictive');
      const formatted = formatYogaActivation(rajaYoga, tr, tp);
      expect(formatted).toBeDefined();
      expect(formatted).toContain('10');
      expect(formatted).not.toContain('yogas.activation');
    },
  );
});

describe('buildEvidenceSection — explicit per-row and section-level diagnostics', () => {
  const tr = i18n.getFixedT('en', 'report');

  it('distinguishes withheld reflection, rejected citation, and model-omitted rows', () => {
    const ledger = buildEvidenceLedger(nearCuspChart(), {
      readings: [
        { observation_id: 'lagna', interpretation: 'You will get married in 2027.' },
        {
          observation_id: REAL_YOGA_OBSERVATION,
          interpretation: 'Steady collaborative synthesis.',
          also_cites: ['dignity:pluto'],
        },
      ],
    });
    const section = buildEvidenceSection(ledger, tr, undefined, { hasReading: true });
    const lagnaRow = section.rows.find((r) => r.observationId === 'lagna');
    const yogaRow = section.rows.find((r) => r.observationId === REAL_YOGA_OBSERVATION);
    const dashaRow = section.rows.find((r) => r.observationId.startsWith('dasha:maha:'));

    expect(lagnaRow?.interpretation).toContain('withheld for non-reflective phrasing');
    expect(yogaRow?.interpretation).toContain('citing an uncomputed factor');
    expect(dashaRow?.interpretation).toContain('No separate annotation was returned');
  });

  it('surfaces annotation generation failure on empty rows and in rejectedNote', () => {
    const ledger = buildEvidenceLedger(nearCuspChart(), undefined);
    const section = buildEvidenceSection(ledger, tr, undefined, {
      hasReading: true,
      annotationError: 'ai.provider.rate_limited',
    });
    expect(section.rows[0]?.interpretation).toContain('annotation request did not complete');
    expect(section.rejectedNote).toContain('ai.provider.rate_limited');
  });
});

describe('buildTransitsSection — Pratyantar fusion, chronological slow hits, and timestamp', () => {
  it('sorts slow hits chronologically, exposes Pratyantar lord + Moon house, and stamps timezone', () => {
    const tr = i18n.getFixedT('en', 'report');
    const tp = i18n.getFixedT('en', 'predictive');
    const ctx = {
      ...TRANSIT_CTX,
      gochara: {
        ...TRANSIT_CTX.gochara,
        instant: '2026-11-25T05:31:00Z',
      },
      slow_hits: [
        {
          graha: 'saturn' as const,
          kind: 'return' as const,
          natal_point: 'natal_saturn',
          exact: '2033-01-31T00:00:00Z',
          severity: 'challenging' as const,
        },
        {
          graha: 'jupiter' as const,
          kind: 'sign_ingress' as const,
          natal_point: 'moon',
          exact: '2031-07-03T00:00:00Z',
          severity: 'supportive' as const,
        },
      ],
      fusion: {
        ...TRANSIT_CTX.fusion,
        antar_lord: 'venus' as const,
        antar_lord_transit_house_from_moon: 2,
        pratyantar_lord: 'ketu' as const,
        pratyantar_lord_transit_house_from_moon: 7,
      },
    };
    const section = buildTransitsSection(ctx, { tr, tp });
    expect(section.slowHits.rows[0]?.cells[0]).toContain('2031');
    expect(section.slowHits.rows[1]?.cells[0]).toContain('2033');
    const pratyantar = section.fusion.find((item) => item.label === 'Pratyantar lord');
    expect(pratyantar?.value).toContain('Ketu');
    expect(pratyantar?.value).toContain('house 7');
    expect(section.asOf).toMatch(/\([A-Za-z0-9_+-]+(?:\/[A-Za-z0-9_+-]+)*\)|UTC/);
  });
});
