/**
 * ProfileSettings — a save made before the engine has booted (Settings reached
 * straight after a reload, e.g. from the "birthplace timezone is missing" link)
 * starts the bootstrap and waits for it instead of failing with a generic error.
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

// A COLD engine: the user reached Settings straight after a reload, so the
// bootstrap has not started. Saving must start it and wait, not fail.
const engineState = vi.hoisted(() => ({
  startBootstrap: vi.fn(),
  whenReady: vi.fn(),
}));

vi.mock('../../../providers/AlmaMeshRuntimeProvider', () => ({
  useChartEngine: () => ({
    engine: null,
    error: null,
    startBootstrap: engineState.startBootstrap,
    whenReady: engineState.whenReady,
    reboot: () => Promise.reject(new Error('unused')),
    lastProgressAt: () => Date.now(),
  }),
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
const PLACE = { latitude: 12.9716, longitude: 77.5946, timezone: 'Asia/Kolkata' };

/** Store a chart the way the app does: entered clock + optional rectified clock. */
function storeChart(entered: string, rectified?: string): void {
  const effective = rectified ?? entered;
  stored.birthData = {
    birth_datetime_local: `1988-08-08T${effective}:00`,
    ...(rectified ? { birth_time_original: entered } : {}),
    birth_location_details: { ...PLACE, city: 'Bengaluru', country: 'India' },
  };
  stored.chartId = chartId({
    name: 'Test User',
    date: '1988-08-08',
    time: entered,
    ...(rectified ? { rectifiedTime: rectified } : {}),
    ...PLACE,
    location_name: 'Bengaluru, India',
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

async function timeInputs(): Promise<{ birth: HTMLInputElement; rectified: HTMLInputElement }> {
  const rectified = (await screen.findByLabelText('Rectified time')) as HTMLInputElement;
  const birth = document.querySelector<HTMLInputElement>('form input[type="time"]');
  if (!birth) throw new Error('birth time input missing');
  return { birth, rectified };
}

describe('ProfileSettings — saving with a cold engine', () => {
  const emitted: BirthInfoChanged[] = [];
  let unregisterRunner: () => void = () => undefined;

  beforeEach(() => {
    emitted.length = 0;
    engineState.startBootstrap.mockReset();
    engineState.whenReady.mockReset().mockResolvedValue(ENGINE);
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

  it('starts the engine, waits for it, and saves instead of failing', async () => {
    storeChart('06:44');
    renderPage();
    const { birth } = await timeInputs();
    await waitFor(() => expect(birth.value).toBe('06:44'));

    fireEvent.change(birth, { target: { value: '06:14' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Confirm & Regenerate' }));

    await screen.findByText('Chart Updated!');
    expect(engineState.startBootstrap).toHaveBeenCalled();
    expect(emitted).toHaveLength(1);
  });
});
