/**
 * ONE analysis instant across UI, PDF and the AI prompt.
 *
 * A chart is computed at instant R. Five years later (the clock mocked to
 * R + 5 y) the screen, the PDF and the prompt must still name the SAME current
 * maha (the one running at R) and the SAME "as of" date (R's date). Before this
 * change the screen cover printed today, the prompt re-decided "current" from
 * the wall clock, and the adapter fell back to the wall clock when the engine
 * omitted `current_maha`.
 */
import '../../i18n/config';

import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { SiderealChart } from '@almamesh/browser/types';
import { buildChatMessages, sanitizeChartForLlm } from '@almamesh/llm';
import type { ProcessedBirthData } from '@almamesh/shared-types';
import { siderealChartToChartData, type BirthMeta } from '@almamesh/store';

import golden from '../../../../../../backend/tests/fixtures/chart_golden_de421.json';
import { ProvenanceFooter } from '../../components/ProvenanceFooter';
import { ReportCover } from '../../components/features/report/ReportCover';
import { buildReportPdfData } from '../../components/report-pdf/buildReportPdfData';
import type { ReportPdfLabels } from '../../components/report-pdf/types';
import { formatDisplayDate } from '../dates';
import { formatReportDate } from '../reportData';
import { storedChartAnalysisInstant } from '../analysisInstant';

// Bengaluru 1988: Jupiter maha at R (2025-01-01), Saturn by R + 5 y.
const chart = (golden as Record<string, SiderealChart>)['1988-08-08T01:14:00+00:00']!;
const R = chart.snapshot!.reference_date;
const R_PLUS_5Y = new Date('2030-01-01T12:00:00Z');

const BIRTH_META: BirthMeta = {
  name: 'Reference Native',
  location_name: 'Bengaluru',
  date: '1988-08-08',
  time: '06:44',
  latitude: 12.9716,
  longitude: 77.5946,
  timezone: 'Asia/Kolkata',
};

function storedAtR(sidereal: SiderealChart = chart) {
  return { ...siderealChartToChartData(sidereal, BIRTH_META, R), sidereal_chart: sidereal };
}

function localIsoDate(instant: string): string {
  const d = new Date(instant);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function pdfData(stored: ReturnType<typeof storedAtR>) {
  return buildReportPdfData({
    personName: 'Reference Native',
    audienceLabel: 'For You',
    subtitle: 'subtitle',
    kicker: 'kicker',
    generatedAt: stored.astronomical_calculations.calculation_timestamp,
    birth: stored.birth_data as ProcessedBirthData,
    lagna: chart.lagna,
    chart: { ayanamsa_value: chart.ayanamsa_value },
    sidereal: stored.sidereal_chart,
    audience: 'you',
    chartCaptions: { rasi: 'Rasi', navamsa: 'Navamsa' },
    detailLabels: {
      dateOfBirth: 'Date of Birth',
      timeOfBirth: 'Time of Birth',
      placeOfBirth: 'Place of Birth',
      ascendant: 'Ascendant',
    },
    chromeLabels: {} as ReportPdfLabels,
    interpretation: undefined,
  });
}

beforeEach(() => {
  vi.useFakeTimers({ now: R_PLUS_5Y, toFake: ['Date'] });
});
afterEach(() => {
  vi.useRealTimers();
});

describe('one analysis instant: UI = PDF = prompt, five years after the chart', () => {
  it('names the same current maha everywhere: the one running at R', () => {
    const stored = storedAtR();

    const ui = stored.astronomical_calculations.dasha_ctx!.maha_dasha.lord;
    const pdf = pdfData(stored).dasha.mahaSequence.find((row) => row.isCurrent)!.lord;
    const sanitized = sanitizeChartForLlm(chart, storedChartAnalysisInstant(stored));
    const promptCurrentRows = sanitized
      .dashas!.maha_dasha_sequence.filter((row) => String(row.status).startsWith('current'))
      .map((row) => row.lord);

    expect(ui.toLowerCase()).toBe('jupiter');
    expect(pdf.toLowerCase()).toBe('jupiter');
    expect(sanitized.dashas!.current_maha!.lord).toBe('jupiter');
    expect(promptCurrentRows).toEqual(['jupiter']);
    const prompt = buildChatMessages(sanitized, 'What period am I in?')
      .map((m) => m.content)
      .join('\n');
    expect(prompt).toContain('- Mahadasha: jupiter');
    expect(prompt).toContain(`(as of ${localIsoDate(R)}, the chart's analysis date)`);
  });

  it('prints the same as-of date everywhere: R, not today', () => {
    const stored = storedAtR();
    const calculatedAt = stored.astronomical_calculations.calculation_timestamp;

    render(
      <MemoryRouter>
        <ReportCover
          personName="Reference Native"
          audience="you"
          birth={stored.birth_data as ProcessedBirthData}
          lagna={chart.lagna}
          asOf={calculatedAt}
        />
        <ProvenanceFooter calculations={stored.astronomical_calculations} />
      </MemoryRouter>,
    );
    const sanitized = sanitizeChartForLlm(chart, storedChartAnalysisInstant(stored));

    const humanR = formatReportDate(R);
    expect(screen.getByTestId('report-generated-date').textContent).toContain(humanR);
    expect(pdfData(stored).generatedOn).toBe(humanR);
    expect(screen.getByTestId('provenance-footer').textContent).toContain(
      `As of ${formatDisplayDate(new Date(R), { year: 'numeric', month: 'short', day: 'numeric' })}`,
    );
    expect(sanitized.as_of).toEqual({ date: localIsoDate(R), basis: 'chart' });
    expect(screen.getByTestId('report-generated-date').textContent).not.toContain('2030');
  });

  it('falls back to R, not the wall clock, when the engine omits current_maha', () => {
    const olderBundle = { ...chart, dashas: { ...chart.dashas, current_maha: null } };

    const stored = storedAtR(olderBundle as SiderealChart);

    expect(stored.astronomical_calculations.dasha_ctx!.maha_dasha.lord.toLowerCase()).toBe(
      'jupiter',
    );
  });

  it("uses a legacy chart's stored instant when it predates snapshots", () => {
    const { snapshot: _none, ...legacy } = chart;
    const stored = storedAtR(legacy);

    const asOf = storedChartAnalysisInstant(stored);

    expect(asOf).toEqual({ basis: 'chart', instant: new Date(R) });
  });
});
