import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, within, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import {
  useChartLibraryStore,
  useInterpretationStore,
  usePredictiveStore,
  useProfilesStore,
  predictiveRequestKey,
  type StoredChart,
} from '@almamesh/store';
import type { VedicInterpretation } from '@almamesh/shared-types';
import {
  DOMAINS_CTX,
  STRENGTH_CTX,
  TRANSIT_CTX,
  VARGA_CTX_FULL,
} from '../../test/predictiveFixtures';

// Initialize i18next with the bundled catalogs so `t()` yields English (the
// authoritative locale) in these assertions; importing the config is a
// synchronous, side-effecting init (inline resources, no async backend).
import '../../i18n/config';

// Mock the PDF pipeline (which dynamically imports @react-pdf/renderer): the
// failure-path tests drive a rejected render — the exact behavior of a
// pdf().toBlob() rejection propagating out of downloadReportPdf.
vi.mock('../../lib/downloadReportPdf', () => ({
  downloadReportPdf: vi.fn(async () => undefined),
}));
import { downloadReportPdf } from '../../lib/downloadReportPdf';
import { formatReportDate } from '../../lib/reportData';

import ReportView from '../ReportView';

const NATAL_ONLY_INPUT = { predictiveRequestKey: null } as const;

// --- A complete-enough engine chart fixture (Title-Case signs, as emitted) ---
import { CHART, FULL_INTERPRETATION, storedChart } from '../../test/reportFixtures';
import { predictiveReferenceInstant } from '../../lib/predictive';
import { storedChartReferenceDay, viewerTimeZone } from '../../lib/analysisInstant';


function seed(interpretationComplete = true): void {
  useChartLibraryStore.setState({ charts: { 'chart-1': storedChart() }, hydrated: true });
  useInterpretationStore.setState({ byChart: {} });
  if (interpretationComplete) {
    useInterpretationStore
      .getState()
      .setInterpretation(
        'chart-1',
        FULL_INTERPRETATION,
        '2026-06-05T00:00:00Z',
        undefined,
        NATAL_ONLY_INPUT,
      );
  }
}

function renderReport(mode: string): ReturnType<typeof render> {
  return render(
    <MemoryRouter initialEntries={[`/report?mode=${mode}`]}>
      <ReportView />
    </MemoryRouter>,
  );
}

describe('ReportView', () => {
  beforeEach(() => {
    useProfilesStore.setState({ activeProfileId: 'chart-1' });
    useChartLibraryStore.setState({ charts: {}, hydrated: true });
    useInterpretationStore.setState({ byChart: {} });
    usePredictiveStore.getState().reset();
  });

  it('renders all major sections when a chart + complete interpretation exist', () => {
    seed();
    renderReport('astrologer');

    expect(screen.getByTestId('report-cover')).toBeTruthy();
    expect(screen.getByTestId('report-charts')).toBeTruthy();
    expect(screen.getByTestId('report-planet-table')).toBeTruthy();
    expect(screen.getByTestId('report-yogas')).toBeTruthy();
    expect(screen.getByTestId('report-dasha')).toBeTruthy();
    expect(screen.getByTestId('report-interpretation')).toBeTruthy();
    expect(screen.getByTestId('report-footer')).toBeTruthy();
  });

  it('does not flatten the independently dated current timeline into the report or PDF', async () => {
    seed();
    void useInterpretationStore.getState().setCurrentTimeline(
      'chart-1',
      {
        upcoming_periods: [
          { title: 'STALE ROAD AHEAD', layman: 'Old timing prose.', technical: 'Old timing.' },
        ],
        current_sky: [
          { title: 'STALE CURRENT SKY', layman: 'Old sky prose.', technical: 'Old sky.' },
        ],
      },
      '2025-01-01T00:00:00Z',
    );

    renderReport('astrologer');

    expect(screen.queryByText('STALE ROAD AHEAD')).toBeNull();
    expect(screen.queryByText('STALE CURRENT SKY')).toBeNull();

    fireEvent.click(screen.getByTestId('report-download-pdf'));
    await waitFor(() => expect(downloadReportPdf).toHaveBeenCalled());
    const [input] = vi.mocked(downloadReportPdf).mock.calls.at(-1)!;
    expect(input).not.toHaveProperty('timeline');
    expect(JSON.stringify(input)).not.toContain('STALE ROAD AHEAD');
    expect(JSON.stringify(input)).not.toContain('STALE CURRENT SKY');
  });

  it('renders legacy yogas without percentages when the fixture omits strength_pct', () => {
    seed();
    renderReport('astrologer');
    const yogas = screen.getByTestId('report-yogas');
    // Both engine-emitted yogas render: only FORMED yogas exist in the contract.
    expect(
      within(yogas).getByText('Gaja-Kesari Yoga (Jupiter in a kendra from the Moon)'),
    ).toBeTruthy();
    expect(
      within(yogas).getByText('Vipareeta Raja Yoga (Harsha: the 6th lord in the 8th)'),
    ).toBeTruthy();
    // This legacy fixture predates the calibrated field, so the grade remains
    // useful on its own and no percentage is invented by the renderer.
    expect(within(yogas).getByText('moderate')).toBeTruthy();
    expect(within(yogas).getByText('weak')).toBeTruthy();
    expect(yogas.textContent ?? '').not.toMatch(/%/);
    // One-line basis + classical citation from the engine's formation trace.
    expect(
      within(yogas).getByText(/The 6th lord Mars placed in the 8th \(dusthana\)/),
    ).toBeTruthy();
    expect(within(yogas).getByText(/BPHS, Chandra-yoga adhyaya/)).toBeTruthy();
    expect(within(yogas).getByText(/Phaladeepika, Vipareeta Raja-yoga adhyaya/)).toBeTruthy();
  });

  // CONTRACT REVERSED (2026-10-05, chart consistency phase 1): this test used
  // to require TODAY's year on the cover, i.e. it asserted the defect. The
  // cover now prints the chart's own analysis date, the same date the PDF
  // prints, so the screen and the PDF can no longer disagree about "as of".
  it("renders the chart's analysis date — never today, 1969 or Invalid", () => {
    seed();
    renderReport('you');
    const generated = screen.getByTestId('report-generated-date').textContent ?? '';
    expect(generated).not.toMatch(/1969/);
    expect(generated).not.toMatch(/invalid/i);
    expect(generated).toContain(
      formatReportDate(storedChart().astronomical_calculations.calculation_timestamp),
    );
    expect(generated).not.toContain(String(new Date().getFullYear()));
  });

  it('renders a place string with no trailing/empty commas', () => {
    seed();
    renderReport('you');
    const place = screen.getByTestId('report-birth-place').textContent ?? '';
    expect(place).toBe('Bengaluru, Karnataka, India');
    expect(place).not.toMatch(/,\s*,/);
    expect(place.trim()).not.toMatch(/,\s*$/);
  });

  it('shows the layman voice in "you" mode', () => {
    seed();
    renderReport('you');
    const interp = screen.getByTestId('report-interpretation');
    expect(within(interp).getByText('You push through hard things.')).toBeTruthy();
    expect(within(interp).queryByText('Exalted Mars in the 8th lends grit.')).toBeNull();
  });

  it('shows the technical voice in "astrologer" mode', () => {
    seed();
    renderReport('astrologer');
    const interp = screen.getByTestId('report-interpretation');
    expect(within(interp).getByText('Exalted Mars in the 8th lends grit.')).toBeTruthy();
    expect(within(interp).queryByText('You push through hard things.')).toBeNull();
  });

  it('marks the audience badge per the mode', () => {
    seed();
    renderReport('astrologer');
    expect(screen.getByTestId('report-audience-badge').textContent).toBe('For Astrologer');
  });

  it('carries the no-print class on the toolbar and its buttons', () => {
    seed();
    renderReport('you');
    expect(screen.getByTestId('report-toolbar').className).toContain('no-print');
    expect(screen.getByTestId('report-download-pdf').className).toContain('no-print');
    expect(screen.getByTestId('report-back').className).toContain('no-print');
  });

  it('exposes "Download PDF" as the only PDF action — the legacy print button is gone', () => {
    seed();
    renderReport('you');
    expect(screen.getByTestId('report-download-pdf')).toBeTruthy();
    expect(screen.queryByTestId('report-save-pdf')).toBeNull();
  });

  it('surfaces a visible, localized error when the PDF render fails (pdf().toBlob() rejection)', async () => {
    vi.mocked(downloadReportPdf).mockRejectedValueOnce(new Error('toBlob failed'));
    seed();
    renderReport('you');

    // No error notice before the click.
    expect(screen.queryByTestId('report-pdf-error')).toBeNull();

    fireEvent.click(screen.getByTestId('report-download-pdf'));

    // The failure must be user-visible — never a silent unhandled rejection.
    await waitFor(() => expect(screen.getByTestId('report-pdf-error')).toBeTruthy());
    expect(screen.getByTestId('report-pdf-error').textContent).toMatch(/PDF/i);
    // On-screen only: the notice must never end up in a printed document.
    expect(screen.getByTestId('report-pdf-error').className).toContain('no-print');
  });

  it('clears the PDF error when a retry starts', async () => {
    vi.mocked(downloadReportPdf)
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce(undefined);
    seed();
    renderReport('you');

    fireEvent.click(screen.getByTestId('report-download-pdf'));
    await waitFor(() => expect(screen.getByTestId('report-pdf-error')).toBeTruthy());

    fireEvent.click(screen.getByTestId('report-download-pdf'));
    await waitFor(() => expect(screen.queryByTestId('report-pdf-error')).toBeNull());
  });

  it('omits sections whose guidance is null for the audience', () => {
    seed();
    renderReport('you');
    // relationship_guidance is null in the fixture → no relationship block.
    expect(screen.queryByTestId('report-guidance-relationship')).toBeNull();
    // career + health + remedial are present.
    expect(screen.getByTestId('report-guidance-career')).toBeTruthy();
    expect(screen.getByTestId('report-guidance-health')).toBeTruthy();
    expect(screen.getByTestId('report-guidance-remedial')).toBeTruthy();
  });

  it('renders the natal report (no dead-end) when the interpretation is not complete', () => {
    seed(false);
    renderReport('you');
    // The deterministic natal halves render even without an interpretation...
    expect(screen.getByTestId('report-document')).toBeTruthy();
    expect(screen.getByTestId('report-cover')).toBeTruthy();
    expect(screen.getByTestId('report-charts')).toBeTruthy();
    expect(screen.getByTestId('report-planet-table')).toBeTruthy();
    expect(screen.getByTestId('report-dasha')).toBeTruthy();
    expect(screen.getByTestId('report-yogas')).toBeTruthy();
    // ...but the written Interpretation section is omitted.
    expect(screen.queryByTestId('report-interpretation')).toBeNull();
    // An on-screen hint nudges the user to generate the full reading.
    expect(screen.getByTestId('report-narrative-hint')).toBeTruthy();
    // The PDF download stays enabled (no dead-end).
    expect(screen.getByTestId('report-download-pdf')).toBeTruthy();
  });

  it('shows the graceful empty state when there is no chart', () => {
    renderReport('you');
    expect(screen.queryByTestId('report-document')).toBeNull();
    expect(screen.getByText(/No chart found/i)).toBeTruthy();
  });

  it('renders interpretation markdown as formatted HTML — no literal * or # leaks', () => {
    const MARKDOWN: VedicInterpretation = {
      ...FULL_INTERPRETATION,
      summary: {
        layman: 'A **balanced** chart with clear focus on:\n\n- discipline\n- growth',
        technical: 'A **balanced** chart with clear focus on:\n\n- discipline\n- growth',
      },
      strengths: [
        {
          title: 'Determination',
          layman: 'You show **deep** grit.\n\n## Inner drive\n\nIt carries you forward.',
          technical: 'Exalted Mars in the 8th lends grit.',
        },
      ],
    };
    useChartLibraryStore.setState({ charts: { 'chart-1': storedChart() }, hydrated: true });
    useInterpretationStore.setState({ byChart: {} });
    useInterpretationStore
      .getState()
      .setInterpretation(
        'chart-1',
        MARKDOWN,
        '2026-06-05T00:00:00Z',
        undefined,
        NATAL_ONLY_INPUT,
      );
    renderReport('you');

    const summary = screen.getByTestId('report-summary');
    // Bold markdown becomes a real <strong>, not literal asterisks.
    expect(within(summary).getByText('balanced').tagName).toBe('STRONG');
    expect(summary.textContent ?? '').not.toMatch(/\*/);
    // Bullet list becomes a real <ul><li>.
    expect(summary.querySelectorAll('ul li').length).toBe(2);

    const strengths = screen.getByTestId('report-strengths');
    expect(within(strengths).getByText('deep').tagName).toBe('STRONG');
    // Heading markdown becomes a real heading element, not literal hashes.
    expect(within(strengths).getByText('Inner drive').tagName).toMatch(/^H[1-6]$/);
    expect(strengths.textContent ?? '').not.toMatch(/[#*]/);
  });
});

describe('ReportView predictive sections', () => {
  beforeEach(() => {
    useProfilesStore.setState({ activeProfileId: 'chart-1' });
    useChartLibraryStore.setState({ charts: {}, hydrated: true });
    useInterpretationStore.setState({ byChart: {} });
    usePredictiveStore.getState().reset();
  });

  it('offers an on-screen (no-print) compute affordance when contexts are absent', () => {
    seed();
    renderReport('astrologer');
    const pending = screen.getByTestId('report-predictive-pending');
    expect(pending.className).toContain('no-print');
    // No predictive sections in the printable document yet.
    expect(screen.queryByTestId('report-transits')).toBeNull();
    expect(screen.queryByTestId('report-vargas')).toBeNull();
    expect(screen.queryByTestId('report-strength')).toBeNull();
    expect(screen.queryByTestId('report-domains')).toBeNull();
  });

  it('renders Transits, Vargas, Strength and Domains sections once computed', () => {
    seed();
    usePredictiveStore.setState({
      status: 'ready',
      transitCtx: TRANSIT_CTX,
      vargaCtxFull: VARGA_CTX_FULL,
      strengthCtx: STRENGTH_CTX,
      domainsCtx: DOMAINS_CTX,
      profileKey: 'chart-1',
      requestKey: predictiveRequestKey({
        profileKey: 'chart-1',
        datetimeUtc: '1990-03-30T06:30:00Z',
        latitude: 12.97,
        longitude: 77.59,
        referenceInstant: storedChartReferenceDay(
          storedChart(),
          predictiveReferenceInstant(new Date(), viewerTimeZone()),
        ),
        utcOffsetMinutes: 330,
      }),
    });
    renderReport('astrologer');

    // Affordance gone; printable sections present.
    expect(screen.queryByTestId('report-predictive-pending')).toBeNull();
    expect(screen.getByTestId('report-transits')).toBeTruthy();
    expect(screen.getByTestId('report-vargas')).toBeTruthy();
    expect(screen.getByTestId('report-strength')).toBeTruthy();
    expect(screen.getByTestId('report-domains')).toBeTruthy();

    // Engine values verbatim: the canonical SAV total and a timeline event.
    expect(within(screen.getByTestId('report-strength')).getByText(/Total 337/)).toBeTruthy();
    expect(
      within(screen.getByTestId('report-transit-timeline')).getByText('Jupiter enters Cancer'),
    ).toBeTruthy();
    // All seven domain blocks.
    expect(screen.getByTestId('report-domain-career')).toBeTruthy();
    expect(screen.getByTestId('report-domain-family')).toBeTruthy();
  });

  // REGRESSION (owner report: "we have ai interpretation ... it is weak without
  // narrative"). A natal-only reading stays valid prose forever — the dashboard
  // keeps rendering it because `isInterpretationInputSafeToDisplay` says so. But
  // once the predictive layer computes, `isInterpretationInputCurrent` goes false
  // and the hook downgrades `status` to 'idle'. The export used to additionally
  // require `status === 'complete'`, so the SAME reading the dashboard was
  // displaying silently vanished from the PDF. Display and export must read the
  // one stored value; there is no third state where they disagree.
  it('exports the narrative the screen is showing, even after predictive turns the status stale', async () => {
    seed();
    usePredictiveStore.setState({
      status: 'ready',
      transitCtx: TRANSIT_CTX,
      vargaCtxFull: VARGA_CTX_FULL,
      strengthCtx: STRENGTH_CTX,
      domainsCtx: DOMAINS_CTX,
      // The app ALWAYS persists these alongside a ready compute; without them
      // the staleness path this regression covers cannot trigger at all.
      rawContexts: {
        transit_context: {},
        varga_context_full: {},
        strength_context: {},
        domains_context: {},
      } as never,
      profileKey: 'chart-1',
      requestKey: predictiveRequestKey({
        profileKey: 'chart-1',
        datetimeUtc: '1990-03-30T06:30:00Z',
        latitude: 12.97,
        longitude: 77.59,
        referenceInstant: storedChartReferenceDay(
          storedChart(),
          predictiveReferenceInstant(new Date(), viewerTimeZone()),
        ),
        utcOffsetMinutes: 330,
      }),
    });
    renderReport('astrologer');

    // The screen is showing the reading...
    expect(screen.getByTestId('report-interpretation')).toBeTruthy();

    // ...so the PDF must carry that exact reading.
    fireEvent.click(screen.getByTestId('report-download-pdf'));
    await waitFor(() => expect(downloadReportPdf).toHaveBeenCalled());
    const [input] = vi.mocked(downloadReportPdf).mock.calls[0];
    expect(input.interpretation).toEqual(FULL_INTERPRETATION);
  });

  // WIRED, not merely built. The PDF layer grew localized narrative headings and
  // birth-time stability flags; a seam whose only caller is its own unit test is
  // not shipped. These assert the LIVE export call carries them.
  it('carries localized narrative titles and stability markers into the export', async () => {
    seed();
    renderReport('astrologer');

    fireEvent.click(screen.getByTestId('report-download-pdf'));
    await waitFor(() => expect(downloadReportPdf).toHaveBeenCalled());
    const [input] = vi.mocked(downloadReportPdf).mock.calls[0];

    // Localized (English catalog), not the PDF layer's hardcoded fallbacks.
    expect(input.narrativeTitles).toEqual({
      currentSky: "What's Active Now & Next",
      strengths: 'Strengths',
      challenges: 'Challenges',
      lifeThemes: 'Major Life Themes',
      roadAhead: 'The Road Ahead',
    });

    // One marker per engine yoga, and the formatter resolves the chip's wording.
    expect(input.stability?.size).toBe(CHART.yogas.length);
    const marker = [...(input.stability?.values() ?? [])][0];
    expect(marker).toBeDefined();
    expect(input.formatStability?.(marker!)).toMatch(/birth-time (stable|sensitive)/);
  });

  it('cites the dasha-year convention when the engine declares one', () => {
    const chart = storedChart();
    const withConvention: StoredChart = {
      ...chart,
      sidereal_chart: {
        ...CHART,
        dashas: { ...CHART.dashas, convention: 'gregorian_365_2425' },
      },
    } as StoredChart;
    useChartLibraryStore.setState({ charts: { 'chart-1': withConvention }, hydrated: true });
    useInterpretationStore
      .getState()
      .setInterpretation(
        'chart-1',
        FULL_INTERPRETATION,
        '2026-06-05T00:00:00Z',
        undefined,
        NATAL_ONLY_INPUT,
      );
    renderReport('astrologer');

    const convention = screen.getByTestId('report-dasha-convention');
    expect(convention.textContent).toContain('Gregorian year (365.2425 days)');
  });

  it('shows a generic near-cusp note on the cover for a boundary lagna', () => {
    const chart = storedChart();
    const nearCusp: StoredChart = {
      ...chart,
      sidereal_chart: {
        ...CHART,
        lagna: { ...CHART.lagna, sign: 'Aquarius', longitude: 328.84, sign_degrees: 28.84 },
      },
    } as StoredChart;
    useChartLibraryStore.setState({ charts: { 'chart-1': nearCusp }, hydrated: true });
    useInterpretationStore
      .getState()
      .setInterpretation(
        'chart-1',
        FULL_INTERPRETATION,
        '2026-06-05T00:00:00Z',
        undefined,
        NATAL_ONLY_INPUT,
      );
    renderReport('you');

    const note = screen.getByTestId('report-cusp-note');
    // Letterpress-strength honesty: the measured distance, the ALTERNATIVE
    // rising sign named, the house-dependency stated, rectification recommended.
    expect(note.textContent).toContain('Pisces');
    expect(note.textContent).toContain('1.2');
    expect(note.textContent).toMatch(/would make the rising sign Pisces/);
    expect(note.textContent).toMatch(/every house placement in this report/i);
    expect(note.textContent).toMatch(/refining the birth time/i);
  });

  it('prints NO cusp note when the lagna sits comfortably mid-sign', () => {
    const chart = storedChart();
    const midSign: StoredChart = {
      ...chart,
      sidereal_chart: {
        ...CHART,
        lagna: { ...CHART.lagna, sign: 'Aquarius', longitude: 315.0, sign_degrees: 15.0 },
      },
    } as StoredChart;
    useChartLibraryStore.setState({ charts: { 'chart-1': midSign }, hydrated: true });
    useInterpretationStore
      .getState()
      .setInterpretation(
        'chart-1',
        FULL_INTERPRETATION,
        '2026-06-05T00:00:00Z',
        undefined,
        NATAL_ONLY_INPUT,
      );
    renderReport('you');

    expect(screen.queryByTestId('report-cusp-note')).toBeNull();
  });

  it('renders the cusp caveat as a PROMINENT, titled callout that leads with the ascendant value', () => {
    const chart = storedChart();
    const nearCusp: StoredChart = {
      ...chart,
      sidereal_chart: {
        ...CHART,
        lagna: { ...CHART.lagna, sign: 'Aquarius', longitude: 328.84, sign_degrees: 28.84 },
      },
    } as StoredChart;
    useChartLibraryStore.setState({ charts: { 'chart-1': nearCusp }, hydrated: true });
    useInterpretationStore
      .getState()
      .setInterpretation(
        'chart-1',
        FULL_INTERPRETATION,
        '2026-06-05T00:00:00Z',
        undefined,
        NATAL_ONLY_INPUT,
      );
    renderReport('you');

    const callout = screen.getByTestId('report-cusp-note');
    // Promoted from the old muted inline footnote → a bordered, titled callout.
    expect(callout.className).toContain('cusp-callout');
    expect(screen.getByTestId('report-cusp-callout-title')).toBeTruthy();
    // Leads with the ascendant value itself, beside the warning.
    expect(callout.textContent).toContain('Aquarius');
    // Still engine-grounded honesty: the alternative sign + rectification advice.
    expect(callout.textContent).toContain('Pisces');
    expect(callout.textContent).toMatch(/refining the birth time/i);
  });
});

describe('ReportView cover — birth-time honesty', () => {
  beforeEach(() => {
    useChartLibraryStore.setState({ charts: {}, hydrated: true });
    useInterpretationStore.setState({ byChart: {} });
    usePredictiveStore.getState().reset();
  });

  it('badges the birth time "As recorded" with no rectified detail when none is in effect', () => {
    seed();
    renderReport('you');

    const badge = screen.getByTestId('report-time-badge');
    expect(badge.getAttribute('data-variant')).toBe('recorded');
    expect(badge.textContent).toMatch(/as recorded/i);
    // No entered→rectified line when the recorded time was used verbatim.
    expect(screen.queryByTestId('report-time-rectified-detail')).toBeNull();
  });

  it('shows BOTH the entered and rectified times + a "+N min" badge when rectified', () => {
    const chart = storedChart();
    // Entered 11:45 → chart computed for the effective 12:00 local (+15 min).
    const rectified: StoredChart = {
      ...chart,
      birth_data: { ...chart.birth_data, birth_time_original: '11:45' },
    } as StoredChart;
    useChartLibraryStore.setState({ charts: { 'chart-1': rectified }, hydrated: true });
    useInterpretationStore
      .getState()
      .setInterpretation(
        'chart-1',
        FULL_INTERPRETATION,
        '2026-06-05T00:00:00Z',
        undefined,
        NATAL_ONLY_INPUT,
      );
    renderReport('you');

    const badge = screen.getByTestId('report-time-badge');
    expect(badge.getAttribute('data-variant')).toBe('rectified');
    expect(badge.textContent).toMatch(/\+\s?15\s?min/);

    // Honest: BOTH wall clocks appear — the entered time AND the rectified one used.
    const detail = screen.getByTestId('report-time-rectified-detail');
    expect(detail.textContent).toContain('11:45');
    expect(detail.textContent).toContain('12:00');
  });
});
