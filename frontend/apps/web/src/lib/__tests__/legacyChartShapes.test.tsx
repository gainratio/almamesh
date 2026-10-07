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
import { afterEach, beforeAll, describe, expect, it } from 'vitest';

import {
  CHART_LIBRARY_PERSIST_VERSION,
  migrateChartLibraryPersistedState,
  useChartLibraryStore,
  useProfilesStore,
  type StoredChart,
} from '@almamesh/store';

import { ProvenanceFooter } from '../../components/ProvenanceFooter';
import { storedChartAnalysisInstant } from '../analysisInstant';

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
