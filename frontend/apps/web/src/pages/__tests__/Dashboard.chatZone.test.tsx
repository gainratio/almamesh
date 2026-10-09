/**
 * Dashboard chat — a stored chart without a birthplace timezone is refused
 * visibly, never answered "in the chart's zone" with a silent UTC. Mirrors the
 * MeshEdge guard; both go through requireBirthTimeZone.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
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
import { __resetMemoryForTest, __setMemoryForTest } from '../../lib/chatMemory';

const llmMocks = vi.hoisted(() => ({ streamAgentChat: vi.fn(), streamChartChat: vi.fn() }));

vi.mock('@almamesh/llm', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@almamesh/llm')>();
  return {
    ...actual,
    streamAgentChat: llmMocks.streamAgentChat,
    streamChartChat: llmMocks.streamChartChat,
  };
});

vi.mock('../../lib/localChartRead', () => ({ readLocalPrimaryChart: vi.fn() }));

vi.mock('../../providers/chartEngineContext', () => ({
  useChartEngine: () => ({ meta: null }),
  useOptionalChartEngine: () => null,
  ChartEngineContext: { Provider: ({ children }: { children: unknown }) => children },
}));

vi.mock('../../components/features/dashboard', () => ({
  ChartVisualization: () => null,
  IdentityStrip: () => <div data-testid="identity-strip" />,
  LifeAtlas: () => null,
  DashboardInterpretation: () => null,
  ReadingGrounding: () => null,
}));

vi.mock('../../lib/chatToolset', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/chatToolset')>();
  return { ...actual, buildChatToolset: vi.fn(actual.buildChatToolset) };
});

import { hydrateLlmSettings, openRouterPreset, writeLlmSettings } from '@almamesh/llm';
import { buildChatToolset, type ChatToolset } from '../../lib/chatToolset';
import { expectToolsetReadsViewerToday } from '../../test/viewerToday';
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

function renderDashboardWithChatOpen() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={['/dashboard?chat=open']}>
        <DashboardPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

async function ask(question: string): Promise<void> {
  fireEvent.change(await screen.findByTestId('chat-input'), { target: { value: question } });
  fireEvent.click(screen.getByTestId('chat-send-button'));
}

describe('Dashboard chat — no silent UTC for the chart zone', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    hydrateLlmSettings(null);
    writeLlmSettings(openRouterPreset('sk-or-v1-0000-synthetic-test-key', 'test-org/test-model'));
    __setMemoryForTest({
      indexMessage: vi.fn().mockResolvedValue(undefined),
      retrieve: vi.fn().mockResolvedValue([]),
      deleteForProfile: vi.fn().mockResolvedValue(undefined),
      deleteForThread: vi.fn().mockResolvedValue(undefined),
      clear: vi.fn().mockResolvedValue(undefined),
    });
    useProfilesStore.setState({ activeProfileId: 'profile-1' });
    useInterpretationStore.setState({ byChart: {} });
    usePredictiveStore.getState().reset();
    llmMocks.streamAgentChat.mockImplementation(async function* () {
      yield 'An answer grounded in the chart.';
    });
  });

  afterEach(() => {
    __resetMemoryForTest();
    vi.restoreAllMocks();
  });

  it('refuses the question when the stored chart has no birthplace timezone', async () => {
    const chart = chartWithZone('');
    useChartLibraryStore.setState({ charts: { 'chart-1': chart }, hydrated: true });
    vi.mocked(readLocalPrimaryChart).mockResolvedValue(response(chart));
    renderDashboardWithChatOpen();

    await ask('What does my chart say about career?');

    await waitFor(() =>
      expect(screen.getByTestId('chat-panel').textContent).toMatch(/couldn't process your request/),
    );
    expect(llmMocks.streamAgentChat).not.toHaveBeenCalled();
  });

  it('answers normally when the zone is present (control)', async () => {
    const chart = chartWithZone('Asia/Kolkata');
    useChartLibraryStore.setState({ charts: { 'chart-1': chart }, hydrated: true });
    vi.mocked(readLocalPrimaryChart).mockResolvedValue(response(chart));
    renderDashboardWithChatOpen();

    await ask('What does my chart say about career?');

    await waitFor(() => expect(llmMocks.streamAgentChat).toHaveBeenCalledTimes(1));
  });
  it('reads chat "today" in the viewer zone, like MeshEdge', async () => {
    const chart = chartWithZone('Asia/Kolkata');
    useChartLibraryStore.setState({ charts: { 'chart-1': chart }, hydrated: true });
    vi.mocked(readLocalPrimaryChart).mockResolvedValue(response(chart));
    renderDashboardWithChatOpen();
    await ask('What does my chart say about career?');
    await waitFor(() => expect(vi.mocked(buildChatToolset)).toHaveBeenCalled());
    const toolset = vi.mocked(buildChatToolset).mock.results[0].value as ChatToolset;
    await expectToolsetReadsViewerToday(toolset, 'Asia/Kolkata');
  });
});
