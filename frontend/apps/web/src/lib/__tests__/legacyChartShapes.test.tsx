/**
 * Old data stays readable after the chart-snapshot change.
 *
 * The fixture is a REAL v3 `.almamesh` export made before charts carried a
 * snapshot (`packages/store/src/__fixtures__/legacy-backups/legacy-v3.almamesh`).
 * It is opened exactly as Settings → Import opens it, its SQLite rows are read
 * as the OPFS repository stores them, and the chart-library row goes through
 * the store's persist `migrate`. Its chart has no `snapshot`, no
 * `calculation_timestamp` and no `software_version`: the oldest shape there is.
 */
import '../../i18n/config';

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { render, screen } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';

import {
  CHART_LIBRARY_PERSIST_VERSION,
  defaultSealRunner,
  migrateChartLibraryPersistedState,
  openBackup,
  useChartLibraryStore,
  useProfilesStore,
  type StoredChart,
} from '@almamesh/store';

import { ProvenanceFooter } from '../../components/ProvenanceFooter';
import { storedChartAnalysisInstant } from '../analysisInstant';

// Vitest runs from apps/web (jsdom's import.meta.url is not a file URL).
const FIXTURES = join(process.cwd(), '../../packages/store/src/__fixtures__/legacy-backups');
const manifest = JSON.parse(readFileSync(join(FIXTURES, 'manifest.json'), 'utf8')) as Record<
  string,
  { passphrase: string }
>;

interface PersistedRow {
  readonly state: unknown;
  readonly version: number;
}

/** Open the real export and read its canonical rows the way the repository stores them. */
async function readLegacyExportRows(): Promise<Record<string, PersistedRow>> {
  const bytes = new Uint8Array(readFileSync(join(FIXTURES, 'legacy-v3.almamesh')));
  const opened = await openBackup(bytes, manifest['legacy-v3.almamesh']!.passphrase, defaultSealRunner());
  if (opened.kind !== 'database') throw new Error('expected a SQLite export');
  const dir = mkdtempSync(join(tmpdir(), 'almamesh-legacy-'));
  try {
    const file = join(dir, 'legacy.sqlite');
    writeFileSync(file, opened.database);
    const db = new DatabaseSync(file, { readOnly: true });
    const rows = db
      .prepare("SELECT key, CAST(value AS TEXT) AS value FROM edgeproc_state_rows WHERE namespace = 'canonical' AND key LIKE 'almamesh-%'")
      .all() as Array<{ key: string; value: string }>;
    db.close();
    return Object.fromEntries(rows.map((row) => [row.key, JSON.parse(row.value) as PersistedRow]));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const CHART_ID = 'portable-chart-ada';
const PROFILE_ID = 'portable-profile-ada';
let rows: Record<string, PersistedRow>;
let legacyChart: StoredChart;

beforeAll(async () => {
  rows = await readLegacyExportRows();
  const library = rows['almamesh-chart-library']!;
  const migrated = migrateChartLibraryPersistedState(library.state, library.version);
  legacyChart = migrated.charts[CHART_ID]!;
}, 60_000);

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
