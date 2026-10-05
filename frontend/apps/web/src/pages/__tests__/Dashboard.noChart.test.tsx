/**
 * Dashboard — the screen a person sees when they have no chart YET.
 *
 * AlmaMesh computes charts on-device; there is no chart API. `!chartData`
 * therefore means `getPrimaryChart()` missed for the ACTIVE profile scope —
 * that person simply has no chart. Nothing failed, nothing was lost, and a
 * page reload can only ever reproduce the same screen.
 *
 * The one genuine failure is a REJECTED read (react-query surfaces it as
 * `queryError`). That path keeps honest error copy and a real retry.
 *
 * All data below is SYNTHETIC.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useChartLibraryStore, useLanguageStore, useProfilesStore } from '@almamesh/store';
import type { BirthChartGenerationResponse } from '@almamesh/shared-types';

import '../../i18n/config';

// The dashboard reads its primary chart through this helper (via react-query).
vi.mock('../../lib/localChartRead', () => ({
  readLocalPrimaryChart: vi.fn(),
}));

// The provenance footer reads the engine runtime context; stub it so the test
// does not need an AlmaMeshRuntimeProvider (unrelated to the chart-less state).
vi.mock('../../providers/chartEngineContext', () => ({
  useChartEngine: () => ({ meta: null }),
  useOptionalChartEngine: () => null,
  ChartEngineContext: { Provider: ({ children }: { children: unknown }) => children },
}));

// The chart surfaces need a full engine-shaped sidereal chart — and by
// definition never render on the chart-less screen.
vi.mock('../../components/features/dashboard', () => ({
  ChartVisualization: () => null,
  IdentityStrip: () => null,
  LifeAtlas: () => null,
  DashboardInterpretation: () => null,
  ReadingGrounding: () => null,
}));

import { readLocalPrimaryChart } from '../../lib/localChartRead';
import DashboardPage from '../Dashboard';

/** Exactly what `localChartRead.emptyPrimaryChart()` returns on a scope miss. */
const NO_CHART_IN_SCOPE: BirthChartGenerationResponse = {
  success: false,
  message: 'No chart found on this device.',
  person_name: '',
  chart_data_stored: false,
  generated_at: new Date(0).toISOString(),
};

/** Stands in for onboarding and shows which person it was opened for. */
function OnboardingProbe() {
  const { search } = useLocation();
  return <div data-testid="onboarding-probe">{new URLSearchParams(search).get('person') ?? ''}</div>;
}

function renderDashboard(): ReturnType<typeof render> {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={['/dashboard']}>
        <Routes>
          <Route path="/dashboard" element={<DashboardPage />} />
          <Route path="/onboarding" element={<OnboardingProbe />} />
          <Route path="/settings/people" element={<div data-testid="people-probe" />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

/** Wait for the chart read to resolve, then hand back the rendered copy. */
async function settledCopy(): Promise<string> {
  await waitFor(() => {
    expect(screen.queryByText('Loading Your Chart')).toBeNull();
  });
  return document.body.textContent ?? '';
}

function seedActivePerson(name: string): string {
  const id = useProfilesStore.getState().createProfile(name);
  useProfilesStore.getState().setActiveProfile(id);
  return id;
}

describe('Dashboard — the active person has no chart yet', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    useLanguageStore.setState({ language: 'en' });
    useChartLibraryStore.setState({ charts: {}, hydrated: true });
    useProfilesStore.setState({ profiles: {}, activeProfileId: null, hydrated: true });
    vi.mocked(readLocalPrimaryChart).mockResolvedValue(NO_CHART_IN_SCOPE);
  });

  it('never blames the network — this app makes no chart request to blame', async () => {
    seedActivePerson('Amma');
    renderDashboard();

    const copy = await settledCopy();
    expect(copy).not.toMatch(/connection|network|internet|offline/i);
    expect(copy).not.toMatch(/unable to load|couldn't load|failed to load/i);
  });

  it('names the person whose chart is missing', async () => {
    seedActivePerson('Amma');
    renderDashboard();

    await settledCopy();
    expect(screen.getByTestId('no-chart-state').textContent ?? '').toContain('Amma');
  });

  it('offers the action that actually fixes it: create this person’s chart', async () => {
    seedActivePerson('Amma');
    renderDashboard();
    await settledCopy();

    fireEvent.click(screen.getByTestId('no-chart-create'));

    expect(screen.getByTestId('onboarding-probe')).toBeTruthy();
  });

  // CONTRACT REVERSED (2026-10-05, P0 reload-loss): this screen used to say
  // "Nothing broke and nothing was lost". A reload during the first compute
  // DID lose people's charts, and no birth data survives to rebuild from, so
  // the copy must say what may have happened and how to rebuild.
  it('is honest that no saved chart was found, never "nothing was lost"', async () => {
    seedActivePerson('Amma');
    renderDashboard();

    const copy = await settledCopy();
    expect(copy).not.toMatch(/nothing was lost|nothing broke/i);
    expect(copy).toContain("We couldn't find a saved chart for Amma.");
    expect(copy).toContain('This can happen if the page was reloaded while the chart was being computed.');
    expect(copy).toContain('Enter the birth details again to rebuild it.');
  });

  it('rebuilds the chart for THIS person: the button opens onboarding with their id', async () => {
    const id = seedActivePerson('Amma');
    renderDashboard();
    await settledCopy();

    fireEvent.click(screen.getByTestId('no-chart-create'));

    expect(screen.getByTestId('onboarding-probe').textContent).toBe(id);
  });

  it('the secondary escape goes somewhere real — Settings → People', async () => {
    seedActivePerson('Amma');
    renderDashboard();
    await settledCopy();

    fireEvent.click(screen.getByTestId('no-chart-switch'));

    expect(screen.getByTestId('people-probe')).toBeTruthy();
  });
});

describe('Dashboard — the chart read genuinely failed', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    useLanguageStore.setState({ language: 'en' });
    useChartLibraryStore.setState({ charts: {}, hydrated: true });
    useProfilesStore.setState({ profiles: {}, activeProfileId: null, hydrated: true });
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.mocked(readLocalPrimaryChart).mockRejectedValue(new Error('IndexedDB read failed'));
  });

  it('keeps an honest failure screen — distinct from "no chart yet"', async () => {
    seedActivePerson('Amma');
    renderDashboard();

    await settledCopy();
    expect(screen.getByTestId('chart-read-failed')).toBeTruthy();
    expect(screen.queryByTestId('no-chart-state')).toBeNull();
  });
});
