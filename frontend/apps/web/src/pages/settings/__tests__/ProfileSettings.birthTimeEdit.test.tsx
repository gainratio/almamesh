/**
 * ProfileSettings — editing ONLY the birth time.
 *
 * Production bug (2026-10-05): the Rectified-time field was prefilled with the
 * entered time, so a birth-time-only edit was saved with the OLD time as a
 * "rectification". The chart id never changed, regeneration no-oped, and the
 * page still said "Chart Updated!". These tests pin the honest outcomes.
 *
 * Engine/chart deps are stubbed; the real stores and event bus drive behavior.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { appEvents, chartId, useProfilesStore, type BirthInfoChanged } from '@almamesh/store';

import '../../../i18n/config';
import { useSettingsStore } from '../../../stores/settings';

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

describe('ProfileSettings — birth-time-only edit', () => {
  const emitted: BirthInfoChanged[] = [];
  const onEmit = (event: BirthInfoChanged) => emitted.push(event);

  beforeEach(() => {
    emitted.length = 0;
    appEvents.on('birth-info-changed', onEmit);
    useSettingsStore.getState().clearPendingChanges();
    useProfilesStore.setState({ activeProfileId: PROFILE_ID });
  });

  afterEach(() => {
    appEvents.off('birth-info-changed', onEmit);
  });

  it('with no rectification, the new birth time is what gets regenerated', async () => {
    storeChart('06:44');
    renderPage();
    const { birth, rectified } = await timeInputs();
    await waitFor(() => expect(birth.value).toBe('06:44'));
    expect(rectified.value).toBe('');

    fireEvent.change(birth, { target: { value: '06:14' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Confirm & Regenerate' }));

    await screen.findByText('Chart Updated!');
    expect(emitted).toHaveLength(1);
    expect(emitted[0].birth.time).toBe('06:14');
    expect(emitted[0].birth.rectifiedTime).toBeUndefined();
  });

  it('with a rectification in effect, says the rectified time governs instead of "Chart Updated!"', async () => {
    storeChart('06:44', '06:59');
    renderPage();
    const { birth, rectified } = await timeInputs();
    await waitFor(() => expect(rectified.value).toBe('06:59'));

    fireEvent.change(birth, { target: { value: '07:30' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }));

    const notice = await screen.findByTestId('rectification-governs-notice');
    expect(notice.textContent).toContain('06:59');
    expect(screen.queryByRole('button', { name: 'Confirm & Regenerate' })).toBeNull();
    expect(screen.queryByText('Chart Updated!')).toBeNull();
    expect(emitted).toHaveLength(0);

    // Clearing the rectified time lets the new birth time govern.
    fireEvent.click(screen.getByTestId('rectification-governs-clear'));
    expect(rectified.value).toBe('');
    fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Confirm & Regenerate' }));

    await screen.findByText('Chart Updated!');
    expect(emitted).toHaveLength(1);
    expect(emitted[0].birth.time).toBe('07:30');
    expect(emitted[0].birth.rectifiedTime).toBeUndefined();
  });

  it('never claims an update when nothing that defines the chart changed', async () => {
    storeChart('06:44');
    renderPage();
    await timeInputs();
    fireEvent.change(screen.getAllByRole('combobox')[0], { target: { value: 'approximate' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }));

    await screen.findByTestId('save-unchanged-notice');
    expect(screen.queryByRole('button', { name: 'Confirm & Regenerate' })).toBeNull();
    expect(emitted).toHaveLength(0);
  });
});
