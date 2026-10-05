/**
 * P0 (prod 6a89c0e, 2026-10-05): onboarding navigated to /dashboard in the same
 * millisecond it asked for the chart. A reload before the worker replied killed
 * the compute, nothing wrote the chart, the draft was already cleared, and the
 * chart was lost for good.
 *
 * The contract pinned here: Onboarding leaves the generating screen, and clears
 * the draft, ONLY after the chart is computed AND its write has reached storage.
 * A failed compute keeps the user on the generating/retry card with the draft.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import type { ChartEngine } from '@almamesh/browser';
import type { SiderealChart } from '@almamesh/browser/types';
import {
  useChartLibraryStore,
  useLifeEventsStore,
  useOnboardingStore,
  useProfilesStore,
} from '@almamesh/store';
import golden from '../../../../../../backend/tests/fixtures/chart_golden_de421.json';
import '../../i18n/config';

const navigateSpy = vi.fn();
vi.mock('react-router-dom', async (orig) => {
  const actual = await orig<typeof import('react-router-dom')>();
  return { ...actual, useNavigate: () => navigateSpy };
});

vi.mock('../../lib/resetAppData', () => ({
  resetAppData: () => Promise.resolve(),
}));

/** The storage-settled barrier, held open by the test to model a slow write. */
const persisted = vi.hoisted(() => ({
  release: (): void => undefined,
  calls: 0,
}));
vi.mock('@almamesh/store', async (orig) => {
  const actual = await orig<typeof import('@almamesh/store')>();
  return {
    ...actual,
    whenChartLibraryPersisted: () => {
      persisted.calls += 1;
      return new Promise<void>((resolve) => {
        persisted.release = resolve;
      });
    },
  };
});

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
}
function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const fakeSiderealChart = (golden as Record<string, SiderealChart>)['1990-01-15T12:00:00+00:00'];
let compute: Deferred<SiderealChart>;
const generateChart = vi.fn(() => compute.promise);
const fakeEngine = { generateChart } as unknown as ChartEngine;

vi.mock('../../providers/AlmaMeshRuntimeProvider', () => ({
  useChartEngine: () => ({
    engine: fakeEngine,
    error: null,
    stage: null,
    meta: null,
    reboot: () => Promise.resolve(fakeEngine),
    whenReady: () => Promise.resolve(fakeEngine),
    startBootstrap: () => undefined,
  }),
}));

import OnboardingPage from '../Onboarding';
import { useRegenerationSubscription } from '../../hooks/useRegenerationSubscription';

/** The page plus the app's ONE regeneration subscriber, as App.tsx mounts them. */
function Harness() {
  useRegenerationSubscription();
  return <OnboardingPage />;
}

function renderPage() {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter initialEntries={['/onboarding']}>
        <Harness />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

function seedReadyToGenerate(): void {
  useOnboardingStore.setState({
    currentStep: 5,
    data: {
      name: 'Asha',
      birthDate: new Date('1990-01-15T00:00:00'),
      birthTime: '12:00',
      timeConfidence: 'exact',
      city: 'Pune',
      state: '',
      country: 'India',
      latitude: 18.52,
      longitude: 73.85,
      timezone: 'Asia/Kolkata',
      interests: [],
      needsRectification: false,
    },
    isLoading: false,
    error: null,
    isSaving: false,
    lastSavedStep: 0,
  });
}

async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

beforeEach(() => {
  navigateSpy.mockClear();
  generateChart.mockClear();
  compute = deferred<SiderealChart>();
  persisted.calls = 0;
  useOnboardingStore.getState().reset();
  useProfilesStore.setState({ profiles: {}, activeProfileId: null });
  useLifeEventsStore.setState({ eventsByProfile: {} });
  useChartLibraryStore.setState({ charts: {} });
});

afterEach(async () => {
  // Settle any compute a failing test left open: regeneration runs are
  // serialized module-wide, so an open one would block the next test's run.
  compute.reject(new Error('test teardown'));
  persisted.release();
  await flush();
  useOnboardingStore.getState().reset();
});

describe('Onboarding — the chart is durable before the user leaves', () => {
  it('stays put and keeps the draft until the compute resolves and the write settles', async () => {
    seedReadyToGenerate();
    renderPage();

    fireEvent.click(screen.getByTestId('skip-life-events-button'));
    await waitFor(() => expect(generateChart).toHaveBeenCalledOnce());
    await flush();

    // Compute in flight: a reload now must land back on /onboarding, not a
    // chart-less dashboard, so nothing may navigate or clear the draft yet.
    expect(navigateSpy).not.toHaveBeenCalled();
    expect(useOnboardingStore.getState().data.name).toBe('Asha');
    expect(screen.getByText(/computing your chart/i)).toBeTruthy();

    compute.resolve(fakeSiderealChart);
    await waitFor(() => expect(persisted.calls).toBeGreaterThan(0));
    await flush();

    // Chart computed and in memory, but not yet on disk: still not safe.
    expect(Object.keys(useChartLibraryStore.getState().charts)).toHaveLength(1);
    expect(navigateSpy).not.toHaveBeenCalled();
    expect(useOnboardingStore.getState().data.name).toBe('Asha');

    persisted.release();
    await waitFor(() => expect(navigateSpy).toHaveBeenCalledWith('/dashboard'));
    expect(useOnboardingStore.getState().data.name).toBe('');
  });

  it('keeps the user on the generating retry card with the draft when the compute fails', async () => {
    seedReadyToGenerate();
    renderPage();

    fireEvent.click(screen.getByTestId('skip-life-events-button'));
    await waitFor(() => expect(generateChart).toHaveBeenCalledOnce());
    compute.reject(new Error('worker died'));

    await waitFor(() => expect(screen.getByTestId('retry-generation-button')).toBeTruthy());
    expect(navigateSpy).not.toHaveBeenCalled();
    expect(useOnboardingStore.getState().data.name).toBe('Asha');
    expect(Object.keys(useChartLibraryStore.getState().charts)).toHaveLength(0);
  });
});
