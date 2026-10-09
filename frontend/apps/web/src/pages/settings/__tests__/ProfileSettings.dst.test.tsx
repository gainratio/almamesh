/**
 * ProfileSettings — a birth-time edit that lands on a DST edge is never
 * silently resolved: a gap time is refused, a repeated hour needs a choice,
 * and the chosen occurrence reaches the regeneration.
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
const PLACE = { latitude: 34.0522, longitude: -118.2437, timezone: 'America/Los_Angeles' };

/** Store a chart the way the app does: entered clock + optional rectified clock. */
function storeChart(date: string, entered: string): void {
  stored.birthData = {
    birth_datetime_local: `${date}T${entered}:00`,
    birth_location_details: { ...PLACE, city: 'Los Angeles', country: 'USA' },
  };
  stored.chartId = chartId({
    name: 'Test User',
    date,
    time: entered,
    ...PLACE,
    location_name: 'Los Angeles, USA',
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

describe('ProfileSettings — daylight-saving edges in a birth-time edit', () => {
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

  async function editTimeTo(date: string, from: string, to: string): Promise<void> {
    storeChart(date, from);
    renderPage();
    const { birth } = await timeInputs();
    await waitFor(() => expect(birth.value).toBe(from));
    fireEvent.change(birth, { target: { value: to } });
  }

  it('refuses to save a repeated fall-back hour until the user picks one', async () => {
    await editTimeTo('2024-11-03', '00:30', '01:30');
    expect(await screen.findByTestId('dst-fold-choice')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }));

    expect((await screen.findByRole('alert')).textContent).toMatch(/happened twice/);
    expect(screen.queryByRole('button', { name: 'Confirm & Regenerate' })).toBeNull();
    expect(emitted).toHaveLength(0);
  });

  it('regenerates with the occurrence the user picked', async () => {
    await editTimeTo('2024-11-03', '00:30', '01:30');
    fireEvent.click(await screen.findByTestId('dst-fold-later'));
    fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Confirm & Regenerate' }));

    await waitFor(() => expect(emitted).toHaveLength(1));
    expect(emitted[0]?.birth.dstFold).toBe('later');
  });

  it('refuses to save a spring-forward time that never existed', async () => {
    await editTimeTo('2024-03-10', '00:30', '02:30');
    expect(await screen.findByTestId('dst-gap-notice')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }));

    await waitFor(() =>
      expect(screen.getAllByRole('alert').some((el) => /did not exist/.test(el.textContent ?? ''))).toBe(true),
    );
    expect(screen.queryByRole('button', { name: 'Confirm & Regenerate' })).toBeNull();
    expect(emitted).toHaveLength(0);
  });
});
