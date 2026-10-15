/**
 * Dashboard chat: the send handler loads the chat turn (lib/chatTurn.ts) on send
 * and hands it the stored chart, the reader's voice and the thread's callbacks.
 *
 * Contract reversed (chat tool layer redesign, Task 6, 2026-10-14): a stored chart
 * without a birthplace timezone used to be refused, because get_current_datetime
 * could answer "in the chart's zone". That tool is gone; today is the viewer's day
 * (lib/chatTurn.ts), so no part of a chat turn reads the birth zone and the chart
 * answers like any other.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  useChartLibraryStore,
  useChatStore,
  useInterpretationStore,
  usePredictiveStore,
  useProfilesStore,
  type StoredChart,
} from '@almamesh/store';
import type { BirthChartGenerationResponse } from '@almamesh/shared-types';

import '../../i18n/config';
import { __resetMemoryForTest, __setMemoryForTest } from '../../lib/chatMemory';

const turnMocks = vi.hoisted(() => ({ runChatTurn: vi.fn() }));
vi.mock('../../lib/chatTurn', () => ({ runChatTurn: turnMocks.runChatTurn }));

vi.mock('../../lib/localChartRead', () => ({ readLocalPrimaryChart: vi.fn() }));

// Whether today's predictive facts are computed: 'ready' unless a test says otherwise.
const predictive = vi.hoisted(() => ({ state: 'ready' as 'pending' | 'ready' | 'error' }));
vi.mock('../../hooks/useStreamingInterpretation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../hooks/useStreamingInterpretation')>()),
  currentTimelineInputState: () => predictive.state,
}));

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

import { hydrateLlmSettings, openRouterPreset, writeLlmSettings } from '@almamesh/llm';
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

describe('Dashboard chat runs one lazy chat turn', () => {
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
    predictive.state = 'ready';
    turnMocks.runChatTurn.mockImplementation(async function* () {
      yield 'An answer';
      yield 'An answer grounded in the chart.';
    });
  });

  afterEach(() => {
    __resetMemoryForTest();
    vi.restoreAllMocks();
  });

  it('a stored chart without a birthplace timezone still answers (contract reversed: no tool reads the birth zone)', async () => {
    const chart = chartWithZone('');
    useChartLibraryStore.setState({ charts: { 'chart-1': chart }, hydrated: true });
    vi.mocked(readLocalPrimaryChart).mockResolvedValue(response(chart));
    renderDashboardWithChatOpen();

    await ask('What does my chart say about career?');

    await waitFor(() => expect(screen.getByTestId('chat-panel').textContent).toContain('An answer grounded in the chart.'));
    expect(turnMocks.runChatTurn).toHaveBeenCalledTimes(1);
  });

  // Northstar on PR #366: "take me to May 2019" -> asked where -> "Delhi" must reach the turn as a pending move.
  it('hands the next turn the pending move when the last one asked to travel and was asked a question instead', async () => {
    const chart = chartWithZone('Asia/Kolkata');
    useChartLibraryStore.setState({ charts: { 'chart-1': chart }, hydrated: true });
    vi.mocked(readLocalPrimaryChart).mockResolvedValue(response(chart));
    renderDashboardWithChatOpen();

    await ask('take me to May 2019');
    await waitFor(() => expect(screen.getByTestId('chat-panel').textContent).toContain('An answer grounded in the chart.'));
    expect(turnMocks.runChatTurn.mock.calls[0][0].pendingTravel).toBeUndefined();
    await ask('Delhi');
    await waitFor(() => expect(turnMocks.runChatTurn).toHaveBeenCalledTimes(2));
    expect(turnMocks.runChatTurn.mock.calls[1][0].pendingTravel).toEqual({ kind: 'pending_travel', request: 'take me to May 2019' });
  });

  it('hands the turn the stored chart, the question, the voice and the thread callbacks; pages pass no test seams', async () => {
    const chart = chartWithZone('Asia/Kolkata');
    useChartLibraryStore.setState({ charts: { 'chart-1': chart }, hydrated: true });
    vi.mocked(readLocalPrimaryChart).mockResolvedValue(response(chart));
    renderDashboardWithChatOpen();

    await ask('What does my chart say about career?');

    await waitFor(() => expect(turnMocks.runChatTurn).toHaveBeenCalledTimes(1));
    const input = turnMocks.runChatTurn.mock.calls[0][0];
    expect(input).toMatchObject({
      chart: chart.sidereal_chart, profileKey: 'profile-1', question: 'What does my chart say about career?', mode: 'layman', language: 'en',
      labels: { deciding: expect.any(String), answering: expect.any(String), complete: expect.any(String) },
    });
    expect(typeof input.onTravel).toBe('function');
    expect(typeof input.onToolCall).toBe('function');
    expect(input.seams).toBeUndefined();
    // Snapshots replace each other: the bubble shows the last one, not a concatenation.
    await waitFor(() => expect(screen.getByTestId('chat-panel').textContent).toContain('An answer grounded in the chart.'));
    expect(screen.getByTestId('chat-panel').textContent).not.toContain('An answerAn answer');
  });
  // Task 11 (2026-10-14): Settings' "Where do you live now?" is the today thread's place.
  it('hands the turn where the active person lives now; nothing when they never said (never the birthplace)', async () => {
    const NOVATO = { label: 'Novato, California, United States', timezone: 'America/Los_Angeles', latitude: 38.1074, longitude: -122.5697 };
    const person = { id: 'profile-1', name: 'Asha Rao', createdAt: '2026-01-01T00:00:00Z', avatarTint: 'teal' };
    const chart = chartWithZone('Asia/Kolkata');
    useChartLibraryStore.setState({ charts: { 'chart-1': chart }, hydrated: true });
    vi.mocked(readLocalPrimaryChart).mockResolvedValue(response(chart));

    useProfilesStore.setState({ profiles: { 'profile-1': { ...person, currentPlace: NOVATO } }, activeProfileId: 'profile-1' });
    const first = renderDashboardWithChatOpen();
    await ask('How is this month?');
    await waitFor(() => expect(turnMocks.runChatTurn).toHaveBeenCalledTimes(1));
    expect(turnMocks.runChatTurn.mock.calls[0][0].currentPlace).toEqual(NOVATO);
    first.unmount();

    useProfilesStore.setState({ profiles: { 'profile-1': person }, activeProfileId: 'profile-1' });
    renderDashboardWithChatOpen();
    await ask('How is next month?');
    await waitFor(() => expect(turnMocks.runChatTurn).toHaveBeenCalledTimes(2));
    expect(turnMocks.runChatTurn.mock.calls[1][0].currentPlace).toBeUndefined();
  });
});

describe('Dashboard chat waits for today\'s predictive facts (2026-10-14)', () => {
  const NOTE = 'Today’s sky wasn’t ready, so this answer reads your birth chart only.';
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
    useChatStore.setState({ threads: {}, messages: {}, summaries: {} });
    const chart = chartWithZone('Asia/Kolkata');
    useChartLibraryStore.setState({ charts: { 'chart-1': chart }, hydrated: true });
    vi.mocked(readLocalPrimaryChart).mockResolvedValue(response(chart));
    turnMocks.runChatTurn.mockImplementation(async function* () { yield 'Saturn steadies today.'; });
  });
  afterEach(() => {
    __resetMemoryForTest();
    vi.restoreAllMocks();
  });

  /** A predictive store change: what the wait listens to. */
  function predictiveSettles(state: 'ready' | 'error'): void {
    predictive.state = state;
    act(() => { usePredictiveStore.setState({ status: state }); });
  }

  it('a today question sent before the facts are ready shows "Preparing your chart…" and goes out once they are', async () => {
    predictive.state = 'pending';
    renderDashboardWithChatOpen();
    await ask('How is today?');
    expect((await screen.findByTestId('chat-agent-status')).textContent).toBe('Preparing your chart…');
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(turnMocks.runChatTurn).not.toHaveBeenCalled();
    predictiveSettles('ready');
    await waitFor(() => expect(turnMocks.runChatTurn).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByTestId('chat-panel').textContent).toContain('Saturn steadies today.'));
    expect(screen.getByTestId('chat-panel').textContent).not.toContain(NOTE);
  });

  it('when the facts fail, answers from the natal chart and says so in one short line', async () => {
    predictive.state = 'pending';
    renderDashboardWithChatOpen();
    await ask('How is today?');
    await screen.findByTestId('chat-agent-status');
    predictiveSettles('error');
    await waitFor(() => expect(screen.getByTestId('chat-panel').textContent).toContain('Saturn steadies today.'));
    expect(turnMocks.runChatTurn).toHaveBeenCalledTimes(1);
    const answer = screen.getAllByTestId('chat-message-assistant').at(-1)!;
    expect(answer.textContent).toContain(NOTE);
    expect(answer.textContent!.indexOf(NOTE)).toBeLessThan(answer.textContent!.indexOf('Saturn steadies today.'));
  });

  it('a trip thread never waits: its facts are the period\'s own, not today\'s', async () => {
    predictive.state = 'pending';
    const place = { label: 'Delhi, India', timezone: 'Asia/Kolkata', latitude: 28.61, longitude: 77.21 };
    act(() => { useChatStore.getState().startThread('profile-1', 'chart-1', { start: '2017-09-01', end: '2017-09-30', granularity: 'month', place }); });
    renderDashboardWithChatOpen();
    await ask('How was this month?');
    await waitFor(() => expect(turnMocks.runChatTurn).toHaveBeenCalledTimes(1));
  });
});
