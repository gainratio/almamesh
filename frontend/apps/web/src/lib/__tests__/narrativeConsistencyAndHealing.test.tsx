import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { READING_WITHHELD } from '@almamesh/llm';
import { useInterpretationStore } from '@almamesh/store';
import type { SiderealChart } from '@almamesh/browser/types';
import type { VedicInterpretation } from '@almamesh/shared-types';

import '../../i18n/config';
import i18n from '../../i18n/config';
import golden from '../../../../../../backend/tests/fixtures/chart_golden_de421.json';
import { buildObservationPrompts } from '../../hooks/evidenceAnnotations';
import { buildEvidenceLedger, formatDashaBoundaryDay } from '../evidence';
import { buildEvidenceSection } from '../../components/report-pdf/buildEvidenceSection';
import { buildNarrative } from '../../components/report-pdf/buildReportSections';
import { ReportInterpretation } from '../../components/features/report/ReportInterpretation';

const BASE_CHART = Object.values(golden as Record<string, SiderealChart>)[0]!;

function chartWithUtcBoundaryRollover(): SiderealChart {
  const maha = {
    lord: 'saturn',
    start_date: '2017-02-08T12:00:00Z',
    end_date: '2036-02-09T12:00:00Z',
    duration_years: 19,
    antar_sequence: [
      {
        lord: 'venus',
        start_date: '2023-12-01T12:00:00Z',
        // 2027-01-31 04:18 UTC == 2027-01-30 20:18 America/Los_Angeles!
        end_date: '2027-01-31T04:18:00Z',
        duration_years: 3.17,
      },
    ],
  };
  return {
    ...BASE_CHART,
    dashas: {
      ...BASE_CHART.dashas,
      convention: 'julian_365_25',
      maha_dasha_sequence: [maha],
      current_maha: maha,
      current_antar: maha.antar_sequence[0]!,
      current_pratyantar: {
        lord: 'ketu',
        start_date: '2026-11-24T12:00:00Z',
        end_date: '2027-01-31T04:18:00Z',
        duration_years: 0.18,
      },
      pratyantar_sequence: [
        {
          lord: 'ketu',
          start_date: '2026-11-24T12:00:00Z',
          end_date: '2027-01-31T04:18:00Z',
          duration_years: 0.18,
        },
      ],
    },
  };
}

describe('canonical dasha boundary formatting and narrative date consistency', () => {
  it('formats UTC dasha boundaries in the target timezone identically across prompt and ledger', () => {
    const chart = chartWithUtcBoundaryRollover();
    expect(formatDashaBoundaryDay('2027-01-31T04:18:00Z', 'America/Los_Angeles')).toBe(
      '2027-01-30',
    );
    expect(formatDashaBoundaryDay('2027-01-31T04:18:00Z', 'UTC')).toBe('2027-01-31');

    const prompts = buildObservationPrompts(chart, 'America/Los_Angeles');
    const antarPrompt = prompts.observations.find(
      (obs) => obs.id === 'dasha:antar:saturn/venus',
    );
    const pratyantarPrompt = prompts.observations.find(
      (obs) => obs.id === 'dasha:pratyantar:saturn/venus/ketu',
    );
    expect(antarPrompt?.evidence).toContain('2023-12-01 to 2027-01-30');
    expect(antarPrompt?.evidence).not.toContain('2027-01-31');
    expect(pratyantarPrompt?.evidence).toContain('2026-11-24 to 2027-01-30');
    expect(pratyantarPrompt?.evidence).not.toContain('2027-01-31');
  });

  it('rejects narrative dasha annotations whose stated date contradicts the computed record', () => {
    const chart = chartWithUtcBoundaryRollover();
    const t = i18n.getFixedT('en', 'report');

    const mismatched = buildEvidenceLedger(
      chart,
      {
        readings: [
          {
            observation_id: 'dasha:antar:saturn/venus',
            interpretation:
              'Within the Saturn maha dasha, the Venus antar dasha (December 1, 2023 to January 31, 2027) puts emphasis on stability.',
          },
          {
            observation_id: 'dasha:pratyantar:saturn/venus/ketu',
            interpretation:
              'The Ketu pratyantar dasha (November 24, 2026 to January 30, 2027) narrows attention to selective creative work.',
          },
        ],
      },
      'America/Los_Angeles',
    );

    expect(mismatched.dateMismatchCount).toBe(1);
    const antarRow = mismatched.rows.find(
      (row) => row.observation.id === 'dasha:antar:saturn/venus',
    );
    const ketuRow = mismatched.rows.find(
      (row) => row.observation.id === 'dasha:pratyantar:saturn/venus/ketu',
    );
    expect(antarRow?.interpretation).toBeNull();
    expect(antarRow?.rejectionReason).toBe('date-mismatch');
    expect(ketuRow?.interpretation).toContain('January 30, 2027');

    const section = buildEvidenceSection(mismatched, t, undefined, { hasReading: true });
    const renderedAntar = section.rows.find(
      (row) => row.observationId === 'dasha:antar:saturn/venus',
    );
    expect(renderedAntar?.interpretation).toContain(
      'disagreed with the computed period boundary',
    );
    expect(section.rejectedNote).toContain(
      '1 model statement was withheld because its stated date disagreed with the computed period boundary.',
    );
  });
});

describe('withheld subsection presentation and surgical section patching', () => {
  it('replaces interactive READING_WITHHELD retry copy with formal availability notice in report and PDF', () => {
    const reading: VedicInterpretation = {
      summary: { layman: 'Steady portrait.', technical: 'Steady portrait.' },
      strengths: [],
      challenges: [],
      life_themes: [
        {
          title: 'Making Home Dependable in Small Ways',
          layman: READING_WITHHELD.en,
          technical: '4th house emphasis.',
        },
      ],
    };

    const pdfSections = buildNarrative(reading, 'you');
    const themes = pdfSections.find((s) => s.title === 'Life Themes');
    expect(themes?.paragraphs[0]).toContain('Making Home Dependable in Small Ways.');
    expect(themes?.paragraphs[0]).toContain('Reflective commentary unavailable');
    expect(themes?.paragraphs[0]).not.toContain('Generate the reading again to retry');

    render(<ReportInterpretation interpretation={reading} audience="you" />);
    const renderedThemes = screen.getByTestId('report-life-themes').textContent ?? '';
    expect(renderedThemes).toContain('Making Home Dependable in Small Ways');
    expect(renderedThemes).toContain('Reflective commentary unavailable');
    expect(renderedThemes).not.toContain('Generate the reading again to retry');
  });

  it('patches a single regenerated section without disturbing other sections or evidence annotations', async () => {
    const chartId = 'surgical-patch-test-chart';
    useInterpretationStore.getState().reset(chartId);
    const token = useInterpretationStore.getState().startInterpretation(chartId, 'prof-1');
    await useInterpretationStore.getState().setInterpretation(
      chartId,
      {
        summary: { layman: 'Original summary.', technical: 'Original summary.' },
        strengths: [{ title: 'Strength', layman: 'Keep.', technical: 'Keep.' }],
        challenges: [],
        life_themes: [{ title: 'Home', layman: READING_WITHHELD.en, technical: 'Tech.' }],
        integrated_yoga_narrative: { layman: 'Intact yoga story.', technical: 'Intact.' },
      },
      '2026-11-25T00:00:00Z',
      { engine: 'openai-http', model: 'glm', baseUrl: 'https://openrouter.ai', predictiveAware: true },
      { predictiveRequestKey: 'pred-1' },
      token,
    );
    const annotations = {
      readings: [{ observation_id: 'lagna', interpretation: 'Preserved annotation.' }],
      general_guidance: [],
    };
    await useInterpretationStore.getState().setEvidenceAnnotations(chartId, annotations, token);

    await useInterpretationStore.getState().patchInterpretationSection(
      chartId,
      'core',
      {
        summary: { layman: 'Original summary.', technical: 'Original summary.' },
        strengths: [{ title: 'Strength', layman: 'Keep.', technical: 'Keep.' }],
        challenges: [],
        life_themes: [
          { title: 'Home', layman: 'Healed reflective home theme.', technical: 'Tech.' },
        ],
      },
      '2026-11-25T01:00:00Z',
      { engine: 'openai-http', model: 'glm', baseUrl: 'https://openrouter.ai', predictiveAware: false },
      token,
    );

    const updated = useInterpretationStore.getState().getEntry(chartId);
    expect(updated?.interpretation?.life_themes[0]?.layman).toBe('Healed reflective home theme.');
    expect(updated?.interpretation?.integrated_yoga_narrative?.layman).toBe('Intact yoga story.');
    expect(updated?.provenance?.predictiveAware).toBe(true);
    expect(updated?.evidenceAnnotations).toEqual(annotations);

    // Starting a new full run invalidates the prior runToken so a late surgical patch cannot clobber it.
    const nextToken = useInterpretationStore.getState().startInterpretation(chartId, 'prof-1');
    expect(nextToken).not.toBe(token);
    await useInterpretationStore.getState().patchInterpretationSection(
      chartId,
      'core',
      { life_themes: [{ title: 'Stale', layman: 'Stale.', technical: 'Stale.' }] },
      '2026-11-25T02:00:00Z',
      undefined,
      token,
    );
    expect(useInterpretationStore.getState().getEntry(chartId)?.status).toBe('generating');
    expect(
      useInterpretationStore.getState().getEntry(chartId)?.interpretation?.life_themes[0]?.title,
    ).toBe('Home');
    useInterpretationStore.getState().reset(chartId);
  });
});
