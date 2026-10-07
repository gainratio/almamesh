/**
 * Old data stays readable after the chart-snapshot change.
 *
 * The rows come from a REAL v3 `.almamesh` export made before charts carried a
 * snapshot: `legacy-v3-canonical-rows.json` is its chart-library and profiles
 * rows verbatim, pinned byte-for-byte to the export by
 * `packages/store/src/legacyV3Rows.fixture.test.ts`. The chart-library row goes
 * through the store's persist `migrate`, as on app load. Its chart has no
 * `snapshot`, no `calculation_timestamp` and no `software_version`: the oldest
 * shape there is.
 */
import '../../i18n/config';

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import {
  CHART_LIBRARY_PERSIST_VERSION,
  migrateChartLibraryPersistedState,
  predictiveRequestKey,
  useChartLibraryStore,
  usePredictiveStore,
  useProfilesStore,
  type StoredChart,
} from '@almamesh/store';
import type { ProcessedBirthData } from '@almamesh/shared-types';

import { LifeAtlas } from '../../components/features/dashboard/LifeAtlas';
import { ProvenanceFooter } from '../../components/ProvenanceFooter';
import { DOMAINS_CTX } from '../../test/predictiveFixtures';
import { currentTimelineInputState } from '../../hooks/useStreamingInterpretation';
import { storedChartAnalysisInstant } from '../analysisInstant';
import { buildEnsurePredictiveInput, predictiveReferenceInstant } from '../predictive';

// Vitest runs from apps/web (the DOM environment's import.meta.url is not a file URL).
const EXTRACT = join(
  process.cwd(),
  '../../packages/store/src/__fixtures__/legacy-backups/legacy-v3-canonical-rows.json',
);

interface PersistedRow {
  readonly state: unknown;
  readonly version: number;
}

/** The export's stored rows, parsed the way the persist layer parses them. */
function readLegacyExportRows(): Record<string, PersistedRow> {
  const extract = JSON.parse(readFileSync(EXTRACT, 'utf8')) as { rows: Record<string, string> };
  return Object.fromEntries(
    Object.entries(extract.rows).map(([key, value]) => [key, JSON.parse(value) as PersistedRow]),
  );
}

const CHART_ID = 'portable-chart-ada';
const PROFILE_ID = 'portable-profile-ada';
let rows: Record<string, PersistedRow>;
let legacyChart: StoredChart;

beforeAll(() => {
  rows = readLegacyExportRows();
  const library = rows['almamesh-chart-library']!;
  const migrated = migrateChartLibraryPersistedState(library.state, library.version);
  legacyChart = migrated.charts[CHART_ID]!;
});

afterEach(() => {
  useChartLibraryStore.setState({ charts: {} });
  usePredictiveStore.getState().reset();
  vi.useRealTimers();
});

describe('a chart from a backup made before chart snapshots', () => {
  it('is the oldest shape: no snapshot, no calculation instant, no engine version', () => {
    expect(legacyChart.person_name).toBe('Portable Ada');
    expect(legacyChart.sidereal_chart).toBeDefined();
    expect(legacyChart.sidereal_chart?.snapshot).toBeUndefined();
    expect(legacyChart.astronomical_calculations.snapshot).toBeUndefined();
    expect(legacyChart.astronomical_calculations.calculation_timestamp).toBeUndefined();
  });

  it('still yields an analysis instant: an honest "today" basis, never a throw', () => {
    const today = new Date('2026-10-07T12:00:00.000Z');
    const instant = storedChartAnalysisInstant(legacyChart, () => today);
    expect(instant).toEqual({ basis: 'today', instant: today });
  });

  it('prefers the stored calculation instant when an older chart recorded one', () => {
    const recorded = {
      ...legacyChart,
      astronomical_calculations: {
        ...legacyChart.astronomical_calculations,
        calculation_timestamp: '2025-03-04T05:06:07.000Z',
      },
    };
    const instant = storedChartAnalysisInstant(recorded, () => new Date('2030-01-01T00:00:00Z'));
    expect(instant).toEqual({ basis: 'chart', instant: new Date('2025-03-04T05:06:07.000Z') });
  });

  it('renders a provenance line without an "Invalid Date"', () => {
    render(<ProvenanceFooter calculations={legacyChart.astronomical_calculations} />);
    const footer = screen.getByTestId('provenance-footer');
    expect(footer.textContent).toContain('engine version not recorded');
    expect(footer.textContent).not.toMatch(/invalid/i);
    expect(footer.textContent).not.toContain('As of');
  });

  it('takes a profile rename onto its person_name and changes nothing else', () => {
    const profiles = rows['almamesh-profiles']!.state as Parameters<typeof useProfilesStore.setState>[0];
    useProfilesStore.setState(profiles);
    useChartLibraryStore.setState({ charts: { [CHART_ID]: legacyChart } });

    useProfilesStore.getState().renameProfile(PROFILE_ID, 'Ada Lovelace');

    const renamed = useChartLibraryStore.getState().getChart(CHART_ID)!;
    expect(useProfilesStore.getState().profiles[PROFILE_ID]!.name).toBe('Ada Lovelace');
    expect(renamed).toEqual({ ...legacyChart, person_name: 'Ada Lovelace' });
  });

  it('survives an export → import round trip of the chart-library row unchanged', () => {
    const exported = JSON.stringify({ state: { charts: { [CHART_ID]: legacyChart } }, version: CHART_LIBRARY_PERSIST_VERSION });
    const reimported = JSON.parse(exported) as PersistedRow;
    const migrated = migrateChartLibraryPersistedState(reimported.state, reimported.version);
    expect(migrated.charts[CHART_ID]).toEqual(legacyChart);
  });
});

/**
 * The live bug (almamesh.com, 50a9c00): a pre-snapshot chart calculated on
 * Jun 26, whose current timeline was refreshed in October. The Life Atlas
 * printed the October wall-clock day while the provenance footer printed the
 * chart's own Jun 26 instant: two "As of" dates on one screen.
 */
describe('one analysis instant on screen for a pre-snapshot chart', () => {
  const CALCULATED = '2026-06-26T17:00:00.000Z';
  const TODAY = new Date('2026-10-07T18:00:00.000Z');

  function calculatedLegacyChart(): StoredChart {
    return {
      ...legacyChart,
      astronomical_calculations: {
        ...legacyChart.astronomical_calculations,
        calculation_timestamp: CALCULATED,
      },
    };
  }

  /** The predictive result computed for `day` — what the atlas renders when keys match. */
  function predictiveReadyFor(chart: StoredChart, day: string): void {
    const input = buildEnsurePredictiveInput(
      PROFILE_ID,
      chart.birth_data as ProcessedBirthData,
      day,
    )!;
    usePredictiveStore.setState({
      status: 'ready',
      domainsCtx: { ...DOMAINS_CTX, instant: day },
      profileKey: PROFILE_ID,
      requestKey: predictiveRequestKey(input),
    });
  }

  function renderScreen(chart: StoredChart): void {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(TODAY);
    useChartLibraryStore.setState({ charts: { [CHART_ID]: chart }, hydrated: true });
    useProfilesStore.setState({ activeProfileId: PROFILE_ID });
  }

  function asOfDates(): string[] {
    const texts = [
      screen.getByTestId('life-atlas').textContent ?? '',
      screen.getByTestId('provenance-footer').textContent ?? '',
    ];
    return texts.flatMap((text) => [...text.matchAll(/As of ([A-Z][a-z]+ \d{1,2}, \d{4})/g)].map((m) => m[1]!));
  }

  function mount(chart: StoredChart): void {
    render(
      <MemoryRouter>
        <LifeAtlas />
        <ProvenanceFooter calculations={chart.astronomical_calculations} />
      </MemoryRouter>,
    );
  }

  it('never prints a wall-clock day beside the chart\'s own day after a timeline refresh', () => {
    const chart = calculatedLegacyChart();
    renderScreen(chart);
    // The facts a refreshed timeline was narrated from: computed for TODAY.
    predictiveReadyFor(chart, predictiveReferenceInstant(TODAY, 'Asia/Kolkata'));
    mount(chart);
    expect(new Set(asOfDates()).size).toBe(1);
  });

  it('shows the atlas as of exactly the date the footer prints', () => {
    const chart = calculatedLegacyChart();
    renderScreen(chart);
    predictiveReadyFor(chart, predictiveReferenceInstant(new Date(CALCULATED), 'Asia/Kolkata'));
    mount(chart);
    const dates = asOfDates();
    expect(dates).toHaveLength(2);
    expect(dates[0]).toBe(dates[1]);
    expect(dates[0]).toBe('Jun 26, 2026');
  });

  it('refreshes the current timeline from the facts computed for the chart\'s own day', () => {
    const chart = calculatedLegacyChart();
    renderScreen(chart);
    predictiveReadyFor(chart, predictiveReferenceInstant(new Date(CALCULATED), 'Asia/Kolkata'));
    usePredictiveStore.setState({ rawContexts: {} as never });
    expect(currentTimelineInputState(CHART_ID)).toBe('ready');
  });
});
