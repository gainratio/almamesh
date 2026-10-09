/**
 * ProfileSettings — a chart saved through the old Settings `|| 'UTC'` fallback
 * carries an explicit 'UTC' zone. When the birthplace's own zone (offline
 * tz-lookup) was not at UTC+0 at the birth instant, Settings flags it and offers
 * a one-click repair. Nothing is rewritten until the user clicks; a birthplace
 * genuinely at UTC is not flagged.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import {
  chartId,
  registerRegenerationRunner,
  useProfilesStore,
  type BirthInfoChanged,
} from '@almamesh/store';

import '../../../i18n/config';
import { useSettingsStore } from '../../../stores/settings';

/** The strict chart-library write barrier; a test may make it fail. */
const chartWrite = vi.hoisted(() => ({ next: (): Promise<void> => Promise.resolve() }));
vi.mock('@almamesh/store', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@almamesh/store')>();
  return { ...actual, whenChartLibraryCommitted: () => chartWrite.next() };
});

const ENGINE = vi.hoisted(() => ({ generateChart: () => Promise.reject(new Error('unused')) }));

vi.mock('../../../providers/AlmaMeshRuntimeProvider', () => ({
  useChartEngine: () => ({ engine: ENGINE, error: null }),
}));

vi.mock('../../../hooks/useLagnaPreview', () => ({
  useLagnaPreview: () => ({
    status: 'ready',
    lagna: { sign: 'Leo', signDegrees: 2, nakshatra: 'Magha' },
  }),
}));

const stored = vi.hoisted(() => ({ birthData: {} as Record<string, unknown>, chartId: '' }));

vi.mock('../../../lib/localChartRead', () => ({
  readLocalPrimaryChart: () =>
    Promise.resolve({
      success: true,
      person_name: 'Test User',
      chart_id: stored.chartId,
      chart_data: { birth_data: stored.birthData },
    }),
}));

vi.mock('../../../components/shared/LocationSearch', () => ({
  LocationSearch: () => <div data-testid="location-search-stub" />,
}));

vi.mock('../../../components/features/settings/BirthTimeComparison', () => ({
  BirthTimeComparison: () => null,
}));

import ProfileSettings from '../ProfileSettings';

const PROFILE_ID = 'profile-edit';


/** Store a chart the way the app does: entered clock + optional rectified clock. */
interface Place {
  readonly latitude: number;
  readonly longitude: number;
  readonly city: string;
}

const BENGALURU: Place = { latitude: 12.9716, longitude: 77.5946, city: 'Bengaluru' };
const REYKJAVIK: Place = { latitude: 64.1466, longitude: -21.9426, city: 'Reykjavik' };

/** A chart saved by the old `|| 'UTC'` fallback: explicit zone 'UTC'. */
function storeUtcChart(place: Place, timezone = 'UTC'): void {
  stored.birthData = {
    birth_datetime_utc: '1988-08-08T06:44:00.000Z',
    birth_datetime_local: '1988-08-08T06:44:00',
    birth_location_details: {
      latitude: place.latitude,
      longitude: place.longitude,
      timezone,
      city: place.city,
    },
  };
  stored.chartId = chartId({
    name: 'Test User',
    date: '1988-08-08',
    time: '06:44',
    latitude: place.latitude,
    longitude: place.longitude,
    timezone: 'UTC',
    location_name: place.city,
  });
}

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/settings/profile']}>
      <Routes>
        <Route path="/settings/profile" element={<ProfileSettings />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('ProfileSettings — repair a chart saved with the old UTC fallback', () => {
  const emitted: BirthInfoChanged[] = [];
  let unregisterRunner: () => void = () => undefined;

  beforeEach(() => {
    emitted.length = 0;
    unregisterRunner = registerRegenerationRunner((event) => {
      emitted.push(event);
      return Promise.resolve();
    });
    useSettingsStore.getState().clearPendingChanges();
    useProfilesStore.setState({ activeProfileId: PROFILE_ID });
  });

  afterEach(() => {
    chartWrite.next = () => Promise.resolve();
    vi.restoreAllMocks();
    unregisterRunner();
  });

  it('flags the suspect UTC zone and offers the birthplace zone, without changing anything', async () => {
    storeUtcChart(BENGALURU);
    renderPage();
    const notice = await screen.findByTestId('utc-zone-repair');
    expect(notice.textContent).toMatch(/Asia\/Kolkata/);
    expect(useSettingsStore.getState().pendingChanges.birth_location).toBeUndefined();
    expect(emitted).toHaveLength(0);
  });

  it('applies the birthplace zone only when the user clicks, then regenerates with it', async () => {
    storeUtcChart(BENGALURU);
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: /Use Asia\/Kolkata/ }));
    await waitFor(() => expect(screen.queryByTestId('utc-zone-repair')).toBeNull());
    fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Confirm & Regenerate' }));
    await waitFor(() => expect(emitted).toHaveLength(1));
    expect(emitted[0]?.birth.timezone).toBe('Asia/Kolkata');
  });

  it('does not flag a birthplace that really is at UTC (Reykjavik)', async () => {
    storeUtcChart(REYKJAVIK);
    renderPage();
    await screen.findByRole('button', { name: 'Save Changes' });
    expect(screen.queryByTestId('utc-zone-repair')).toBeNull();
  });

  it('asks the user to re-select the birthplace when the stored zone is missing', async () => {
    storeUtcChart(BENGALURU, '');
    renderPage();
    const prompt = await screen.findByTestId('birth-zone-missing-settings');
    expect(prompt.textContent).toMatch(/timezone is missing/i);
    expect(screen.queryByTestId('utc-zone-repair')).toBeNull();
  });
});

