/**
 * Dashboard Time travel: the button, sheet overlay and banner work with AI off.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  useChartLibraryStore,
  useInterpretationStore,
  usePredictiveStore,
  useProfilesStore,
  type StoredChart,
} from '@almamesh/store';
import type { BirthChartGenerationResponse } from '@almamesh/shared-types';

import '../../i18n/config';

vi.mock('../../lib/localChartRead', () => ({ readLocalPrimaryChart: vi.fn() }));

vi.mock('../../providers/chartEngineContext', () => ({
  useChartEngine: () => ({ meta: null }),
  useOptionalChartEngine: () => null,
  ChartEngineContext: { Provider: ({ children }: { children: unknown }) => children },
}));

vi.mock('../../components/features/dashboard', () => ({
  ChartVisualization: () => null,
  IdentityStrip: ({ actions }: { actions?: unknown }) => <div data-testid="identity-strip">{actions as never}</div>,
  LifeAtlas: () => null,
  DashboardInterpretation: () => null,
  ReadingGrounding: () => null,
}));

// Pin the viewer's zone so the viewer-today check holds on a runner in any TZ.
vi.mock('../../lib/analysisInstant', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/analysisInstant')>()),
  viewerTimeZone: () => 'America/Los_Angeles',
}));

vi.mock('../../lib/periodChart', async (orig) => ({
  ...(await orig<typeof import('../../lib/periodChart')>()),
  createPeriodChartLoader: () => () => new Promise(() => {}),
}));

import { hydrateLlmSettings, openRouterPreset, writeLlmSettings } from '@almamesh/llm';
import { useTimeTravelStore } from '../../lib/timeTravel';
import { readLocalPrimaryChart } from '../../lib/localChartRead';
import DashboardPage from '../Dashboard';

function chartWithZone(timezone: string): StoredChart {
  return {
    chart_id: 'chart-1',
    profile_id: 'profile-1',
    person_name: 'Asha Rao',
    is_primary: true,
    birth_data: {
      birth_datetime_utc: '1990-03-30T06:30:00Z',
      birth_datetime_local: '1990-03-30T12:00:00',
      birth_location_details: { city: 'Bengaluru', latitude: 12.97, longitude: 77.59, timezone },
    },
    sidereal_chart: { ayanamsa_value: 23.86, lagna: {}, planets: {}, houses: {}, yogas: [] },
    astronomical_calculations: {
      sidereal_ctx: {
        julian_day: 0,
        ayanamsa_value: 23.86,
        ayanamsa_type: 'lahiri',
        house_system: 'whole_sign',
        sidereal_time: 0,
        lagna: {},
        planets: {},
      },
      calculation_timestamp: '1990-03-30T06:30:00Z',
      software_version: 'test',
    },
  } as unknown as StoredChart;
}

function response(chart: StoredChart): BirthChartGenerationResponse {
  const { person_name, is_primary, chart_id, ...chartData } = chart as unknown as Record<string, unknown>;
  void is_primary;
  return {
    success: true,
    message: 'Chart loaded from device.',
    person_name: person_name as string,
    chart_id: chart_id as string,
    chart_data: chartData as never,
    chart_data_stored: true,
    generated_at: '1990-03-30T06:30:00Z',
  };
}

const PROFILE_ID = 'profile-1';

async function renderDashboard({ ai }: { ai: 'on' | 'off' }) {
  const chart = chartWithZone('Asia/Kolkata');
  useChartLibraryStore.setState({ charts: { 'chart-1': chart }, hydrated: true });
  vi.mocked(readLocalPrimaryChart).mockResolvedValue(response(chart));
  hydrateLlmSettings(null);
  if (ai === 'on') writeLlmSettings(openRouterPreset('sk-or-v1-0000-synthetic-test-key', 'test-org/test-model'));
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={['/dashboard']}>
        <DashboardPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  await screen.findByTestId('dashboard-time-travel-button');
}

describe('Dashboard Time travel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useTimeTravelStore.setState({ moments: {} });
    useProfilesStore.setState({ activeProfileId: PROFILE_ID });
    useInterpretationStore.setState({ byChart: {} });
    usePredictiveStore.getState().reset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('shows a labelled, enabled button with AI off', async () => {
    await renderDashboard({ ai: 'off' });
    const button = screen.getByTestId('dashboard-time-travel-button') as HTMLButtonElement;
    expect(button.textContent).toContain('Time travel');
    expect(button.disabled).toBe(false);
    expect(button.className).toContain('min-h-11');
    expect(button.querySelector('.hidden')).toBeNull();
  });

  it('sits immediately before the timeline button in the header', async () => {
    await renderDashboard({ ai: 'off' });
    const timeline = screen.getByTestId(/^(generate|regenerate)-timeline$/);
    expect(timeline.previousElementSibling).toBe(screen.getByTestId('dashboard-time-travel-button'));
  });

  it('opens the sheet in a fixed overlay, and Cancel returns focus to the button', async () => {
    await renderDashboard({ ai: 'off' });
    const button = screen.getByTestId('dashboard-time-travel-button');
    button.focus();
    fireEvent.click(button);
    const overlay = screen.getByTestId('dashboard-time-travel-sheet-overlay');
    expect(overlay.className).toContain('fixed');
    within(overlay).getByRole('dialog');
    fireEvent.click(screen.getByTestId('time-travel-cancel'));
    expect(screen.queryByTestId('time-travel-sheet')).toBeNull();
    expect(document.activeElement).toBe(button);
  });

  it('Escape closes the sheet and returns focus to the button', async () => {
    await renderDashboard({ ai: 'off' });
    const button = screen.getByTestId('dashboard-time-travel-button');
    button.focus();
    fireEvent.click(button);
    fireEvent.keyDown(screen.getByTestId('time-travel-sheet'), { key: 'Escape' });
    expect(screen.queryByTestId('time-travel-sheet')).toBeNull();
    expect(document.activeElement).toBe(button);
  });

  it('with AI off, Go shows the Dashboard banner for the moment', async () => {
    await renderDashboard({ ai: 'off' });
    fireEvent.click(screen.getByTestId('dashboard-time-travel-button'));
    fireEvent.click(screen.getByTestId('time-travel-tab-year'));
    fireEvent.change(screen.getByTestId('time-travel-year'), { target: { value: '2019' } });
    await act(async () => {
      fireEvent.click(screen.getByTestId('time-travel-go'));
    });
    // The label glues its parts with no-break spaces; compare as a reader sees it.
    const title = screen.getByTestId('dashboard-time-travel-title').textContent ?? '';
    expect(title.replace(/\s+/g, ' ')).toContain('Time travel · 2019');
    expect(screen.getByTestId('dashboard-time-travel-banner').textContent).toContain(
      'the cards below are about this moment',
    );
  });

  it('Change reopens the sheet on the current moment; Back to today removes the banner', async () => {
    await renderDashboard({ ai: 'off' });
    act(() =>
      useTimeTravelStore
        .getState()
        .setMoment(PROFILE_ID, { start: '2019-01-01', end: '2019-12-31', granularity: 'year' }),
    );
    fireEvent.click(screen.getByTestId('dashboard-time-travel-change'));
    expect((screen.getByTestId('time-travel-year') as HTMLSelectElement).value).toBe('2019');
    fireEvent.click(screen.getByTestId('time-travel-cancel'));
    await act(async () => {
      fireEvent.click(screen.getByTestId('dashboard-time-travel-back'));
    });
    expect(screen.queryByTestId('dashboard-time-travel-banner')).toBeNull();
  });
});
