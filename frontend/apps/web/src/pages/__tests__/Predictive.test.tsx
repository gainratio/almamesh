import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import {
  useChartLibraryStore,
  useLanguageStore,
  usePredictiveStore,
  useProfilesStore,
  predictiveRequestKey,
  type StoredChart,
} from '@almamesh/store';
import type { SiderealChart } from '@almamesh/browser/types';

import '../../i18n/config';
import PredictivePage from '../Predictive';
import {
  DOMAINS_CTX,
  STRENGTH_CTX,
  TRANSIT_CTX,
  VARGA_CTX_FULL,
} from '../../test/predictiveFixtures';
import { FOUNDER_DASHAS } from '../../test/dashaFixtures';
import { predictiveReferenceInstant } from '../../lib/predictive';
import { viewerTimeZone } from '../../lib/analysisInstant';

function storedChart(): StoredChart {
  return {
    chart_id: 'chart-1',
    profile_id: 'chart-1',
    person_name: 'Asha Rao',
    is_primary: true,
    birth_data: {
      birth_datetime_utc: '1990-03-30T06:30:00Z',
      birth_datetime_local: '1990-03-30T12:00:00',
      birth_location_details: {
        city: 'Bengaluru',
        latitude: 12.97,
        longitude: 77.59,
        timezone: 'Asia/Kolkata',
      },
    },
    // The natal payload the Periods tab reads — present without any compute.
    sidereal_chart: { dashas: FOUNDER_DASHAS } as SiderealChart,
  } as StoredChart;
}

function currentRequestKey(): string {
  return predictiveRequestKey({
    profileKey: 'chart-1',
    datetimeUtc: '1990-03-30T06:30:00Z',
    latitude: 12.97,
    longitude: 77.59,
    referenceInstant: predictiveReferenceInstant(new Date(), viewerTimeZone()),
    utcOffsetMinutes: 330,
  });
}

function renderPage(initialEntry = '/predictive'): ReturnType<typeof render> {
  return render(
    <MemoryRouter initialEntries={[initialEntry]}>
      <PredictivePage />
    </MemoryRouter>,
  );
}

function seedReady(): void {
  usePredictiveStore.setState({
    status: 'ready',
    transitCtx: TRANSIT_CTX,
    vargaCtxFull: VARGA_CTX_FULL,
    strengthCtx: STRENGTH_CTX,
    domainsCtx: DOMAINS_CTX,
    profileKey: 'chart-1',
    requestKey: currentRequestKey(),
  });
}

describe('PredictivePage (/predictive)', () => {
  beforeEach(() => {
    useLanguageStore.setState({ language: 'en' });
    useProfilesStore.setState({ activeProfileId: 'chart-1' });
    useChartLibraryStore.setState({ charts: { 'chart-1': storedChart() }, hydrated: true });
    usePredictiveStore.getState().reset();
  });

  it('shows the gate with an honest engine-warming note when the engine is not booted', () => {
    // Rendered OUTSIDE AlmaMeshRuntimeProvider → no engine; idle store.
    renderPage();
    expect(screen.getByTestId('predictive-page')).toBeTruthy();
    expect(screen.getByTestId('predictive-gate')).toBeTruthy();
    expect(screen.getByTestId('predictive-engine-warming')).toBeTruthy();
  });

  it('shows an honest progress message (what + where + elapsed) while computing', () => {
    usePredictiveStore.setState({
      status: 'loading',
      profileKey: 'chart-1',
      requestKey: currentRequestKey(),
    });
    renderPage();
    const loading = screen.getByTestId('predictive-loading');
    expect(loading.textContent).toContain('on your device');
    expect(loading.textContent).toContain('elapsed');
  });

  it('shows the error state with a retry affordance', () => {
    usePredictiveStore.setState({
      status: 'error',
      error: 'engine exploded',
      profileKey: 'chart-1',
      requestKey: currentRequestKey(),
    });
    renderPage();
    expect(screen.getByTestId('predictive-error').textContent).toContain('engine exploded');
    expect(screen.getByTestId('predictive-retry')).toBeTruthy();
  });

  it('renders the five tabs once contexts are ready, defaulting to Transits & Timing', () => {
    seedReady();
    renderPage();
    expect(screen.queryByTestId('predictive-gate')).toBeNull();
    expect(screen.getByRole('tab', { name: 'Transits & Timing' }).getAttribute('aria-selected')).toBe('true');
    expect(screen.getByTestId('periods-tab')).toBeTruthy();
    expect(screen.getByTestId('transits-panel')).toBeTruthy();
    expect(screen.getByTestId('predictive-as-of')).toBeTruthy();
  });

  it('switches between Periods, Divisional Charts, Strength and Life Domains tabs', () => {
    seedReady();
    renderPage();
    fireEvent.click(screen.getByTestId('periods-tab'));
    expect(screen.getByTestId('periods-panel')).toBeTruthy();
    fireEvent.click(screen.getByRole('tab', { name: 'Divisional Charts' }));
    expect(screen.getByTestId('shodasavarga-panel')).toBeTruthy();
    fireEvent.click(screen.getByRole('tab', { name: 'Strength' }));
    expect(screen.getByTestId('strength-panel')).toBeTruthy();
    fireEvent.click(screen.getByRole('tab', { name: 'Life Domains' }));
    expect(screen.getByTestId('domains-panel')).toBeTruthy();
  });

  it('renders the Periods tree INSTANTLY from the natal chart while compute still gates the other tabs', () => {
    // Idle store, no engine: the timing tab shows the honest gate…
    renderPage();
    expect(screen.getByTestId('predictive-gate')).toBeTruthy();
    // …but Periods needs no compute: the full tree renders from the stored chart.
    fireEvent.click(screen.getByTestId('periods-tab'));
    expect(screen.getByTestId('periods-panel')).toBeTruthy();
    expect(screen.getByTestId('dasha-tree')).toBeTruthy();
    expect(screen.getByTestId('dasha-tree-maha-saturn').textContent).toContain('Saturn');
    expect(screen.queryByTestId('predictive-gate')).toBeNull(); // no gate inside Periods
    // Switching back to the timing tab restores the gate (still not computed).
    fireEvent.click(screen.getByRole('tab', { name: 'Transits & Timing' }));
    expect(screen.getByTestId('predictive-gate')).toBeTruthy();
  });

  it('deep-links to the Periods tab via ?tab=periods (the dashboard link target)', () => {
    renderPage('/predictive?tab=periods');
    expect(screen.getByTestId('periods-tab').getAttribute('aria-selected')).toBe('true');
    expect(screen.getByTestId('periods-panel')).toBeTruthy();
    expect(screen.getByTestId('dasha-tree-path').textContent).toContain('Venus');
  });

  it('shows an honest absent state on the Periods tab for charts stored without a daśā payload', () => {
    useChartLibraryStore.setState({
      charts: { 'chart-1': { ...storedChart(), sidereal_chart: undefined } as StoredChart },
      hydrated: true,
    });
    renderPage('/predictive?tab=periods');
    expect(screen.getByTestId('periods-unavailable')).toBeTruthy();
    expect(screen.queryByTestId('dasha-tree')).toBeNull();
  });

  it('links back to the dashboard (reachability both ways)', () => {
    seedReady();
    renderPage();
    const back = screen.getByTestId('predictive-back-dashboard');
    expect(back.getAttribute('href')).toBe('/dashboard');
  });
});
