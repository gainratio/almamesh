/**
 * Dashboard — explicit Generate / Regenerate reading requests.
 *
 * A completed reading carries a provenance fingerprint of the config that
 * produced it. The identity-strip actions row offers a Regenerate button
 * (disabled while generating / when no AI is configured). Mounts, reloads,
 * provider-config changes and predictive-day changes spend nothing. A stale
 * reading is NEVER destroyed: it stays on screen through a requested refresh.
 *
 * All chart/interpretation data below is SYNTHETIC.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  useChartLibraryStore,
  useInterpretationStore,
  useContentModeStore,
  predictiveRequestKey,
  usePredictiveStore,
  type StoredChart,
} from '@almamesh/store';
import type { BirthChartGenerationResponse, VedicInterpretation } from '@almamesh/shared-types';

import '../../i18n/config';

// Mock ONLY the structured generator — everything else in @almamesh/llm
// (settings, provenance fingerprint, status) stays real so the dashboard's
// config resolution matches production.
vi.mock('@almamesh/llm', async () => {
  const actual = await vi.importActual<typeof import('@almamesh/llm')>('@almamesh/llm');
  return {
    ...actual,
    streamNatalInterpretation: vi.fn(),
    streamCurrentTimeline: vi.fn(),
  };
});

// Startup gate: paid generation waits for the data lifecycle to settle. Tests
// can hold it closed to reproduce clicks that land while the app is starting.
const lifecycleGate = vi.hoisted(() => ({ wait: null as Promise<void> | null }));
vi.mock('../../lib/profileDataLifecycle', async () => {
  const actual = await vi.importActual<typeof import('../../lib/profileDataLifecycle')>(
    '../../lib/profileDataLifecycle',
  );
  return {
    ...actual,
    whenDataLifecycleReady: () => lifecycleGate.wait ?? actual.whenDataLifecycleReady(),
  };
});

/** Hold the startup gate closed; call the returned function to open it. */
function holdStartup(): () => void {
  let open!: () => void;
  lifecycleGate.wait = new Promise<void>((resolve) => {
    open = resolve;
  });
  return () => {
    lifecycleGate.wait = null;
    open();
  };
}

// The dashboard reads its primary chart through this helper (via react-query).
vi.mock('../../lib/localChartRead', () => ({
  readLocalPrimaryChart: vi.fn(),
}));

// The provenance footer reads the engine runtime context; stub it so the test
// does not need an AlmaMeshRuntimeProvider (unrelated to regeneration).
vi.mock('../../providers/chartEngineContext', () => ({
  useChartEngine: () => ({ meta: null }),
  useOptionalChartEngine: () => null,
  ChartEngineContext: { Provider: ({ children }: { children: unknown }) => children },
}));

// The chart visualization / Life Atlas need a full engine-shaped sidereal
// chart (kundli geometry, predictive compute) — unrelated to regeneration.
// Stub them so the minimal raw chart fixture below can stay minimal.
vi.mock('../../components/features/dashboard', () => ({
  ChartVisualization: () => null,
  // Render the `actions` prop: the Regenerate button now lives in the identity
  // strip's actions row (moved out of the reading-section header), so a null
  // mock would swallow it and every regenerate-reading assertion would fail.
  IdentityStrip: ({ actions }: { actions?: import('react').ReactNode }) => (
    <div data-testid="identity-strip">{actions}</div>
  ),
  LifeAtlas: () => null,
  DashboardInterpretation: () => null,
  DashboardCurrentTimeline: () => <div data-testid="current-timeline-section" />,
  ReadingGrounding: () => null,
}));

import {
  configProvenance,
  hydrateLlmSettings,
  LlmRequestError,
  openRouterPreset,
  streamCurrentTimeline,
  streamNatalInterpretation,
  writeLlmSettings,
  type CurrentTimelineEvent,
  type NatalInterpretationEvent,
  type ReadingProvenance,
} from '@almamesh/llm';
import { readLocalPrimaryChart } from '../../lib/localChartRead';
import { resolveInterpretationConfig } from '../../hooks/useStreamingInterpretation';
import DashboardPage from '../Dashboard';
import { predictiveReferenceInstant } from '../../lib/predictive';
import { viewerTimeZone } from '../../lib/analysisInstant';

const mockedStream = vi.mocked(streamNatalInterpretation);
const mockedTimelineStream = vi.mocked(streamCurrentTimeline);

const LAYMAN_SUMMARY = 'You bring quiet persistence to whatever you commit to.';

// A VALID reading: at least one insight field must carry real content for the
// dashboard's hasValidInterpretation gate (summary alone is not enough).
const INTERPRETATION: VedicInterpretation = {
  summary: { layman: LAYMAN_SUMMARY, technical: 'Saturn anchors a disciplined identity.' },
  strengths: [],
  challenges: [],
  life_themes: [],
  career_guidance: {
    layman: 'Steady, methodical building of a public craft over many years.',
    technical: 'A dignified tenth lord favors gradual institutional growth.',
  },
};

function storedChart(): StoredChart {
  return {
    chart_id: 'chart-1',
    profile_id: 'profile-1',
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
    // Raw engine output — required for the hook to reach the generator at all.
    sidereal_chart: {
      ayanamsa_value: 23.86,
      lagna: {},
      planets: {},
      houses: {},
      yogas: [],
    },
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
      // No recorded instant: the chart reads as of today, the day these
      // spend/queue tests seed their predictive facts for.
      software_version: 'test',
    },
  } as unknown as StoredChart;
}

function primaryChartResponse(): BirthChartGenerationResponse {
  const chart = storedChart();
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

/** A generator that never finishes — pins the hook in the generating state. */
function pendingStream(): () => AsyncGenerator<NatalInterpretationEvent> {
  return async function* () {
    await new Promise<never>(() => {});
    yield* [] as NatalInterpretationEvent[];
  };
}

/** A generator that completes immediately with the given interpretation. */
function completingStream(
  interpretation: VedicInterpretation,
): () => AsyncGenerator<NatalInterpretationEvent> {
  return async function* () {
    yield { type: 'complete', interpretation } as NatalInterpretationEvent;
  };
}

/** A generator that fails outright before yielding any event. */
function failingStream(error: Error): () => AsyncGenerator<NatalInterpretationEvent> {
  return async function* () {
    for (const e of [] as NatalInterpretationEvent[]) yield e;
    throw error;
  };
}

function pendingTimelineStream(): () => AsyncGenerator<CurrentTimelineEvent> {
  return async function* () {
    await new Promise<never>(() => {});
    yield* [] as CurrentTimelineEvent[];
  };
}

/** Configure a synthetic cloud tier (configured, NOT on-device). */
function configureCloudAi(): void {
  writeLlmSettings(openRouterPreset('sk-or-v1-0000-synthetic-test-key', 'test-org/test-model'));
}

/** The identity of the config the interpretation path would use right now. */
function currentProvenance(): ReadingProvenance {
  return configProvenance(resolveInterpretationConfig());
}

/** A producer identity that matches NO current config (a replaced model). */
const STALE_PROVENANCE: ReadingProvenance = {
  engine: 'openai-http',
  model: 'legacy-org/retired-model',
  baseUrl: 'https://example.invalid/v1',
};
const NATAL_ONLY_INPUT = { predictiveRequestKey: null } as const;

function seedCompleteReading(provenance?: ReadingProvenance): void {
  useInterpretationStore.setState({ byChart: {} });
  useInterpretationStore
    .getState()
    .setInterpretation(
      'chart-1',
      INTERPRETATION,
      '2026-06-20T00:00:00Z',
      provenance,
      NATAL_ONLY_INPUT,
    );
}

function dashboardUi(queryClient: QueryClient, revision = 'initial') {
  return (
    <div data-testid="dashboard-render-revision" data-revision={revision}>
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={['/dashboard']}>
          <DashboardPage />
        </MemoryRouter>
      </QueryClientProvider>
    </div>
  );
}

function renderDashboard() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return { queryClient, view: render(dashboardUi(queryClient)) };
}

/** Let pending effects settle before asserting on stream calls. */
async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 50));
}

describe('Dashboard — regenerate reading', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    lifecycleGate.wait = null;
    hydrateLlmSettings(null);
    vi.mocked(readLocalPrimaryChart).mockResolvedValue(primaryChartResponse());
    useChartLibraryStore.setState({ charts: { 'chart-1': storedChart() }, hydrated: true });
    useContentModeStore.setState({ contentMode: 'layman' });
    usePredictiveStore.getState().reset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('shows an enabled "Regenerate natal reading" button in the top actions row when AI is configured', async () => {
    configureCloudAi();
    seedCompleteReading(currentProvenance());
    renderDashboard();

    const button = await screen.findByTestId<HTMLButtonElement>('regenerate-reading');
    expect(button.disabled).toBe(false);
    // Scoped label: the READING regenerates — the chart is deterministic and
    // never needs to.
    expect(button.textContent ?? '').toContain('Regenerate natal reading');
  });

  it('keeps a touch-sized Regenerate button visible before the first reading exists', async () => {
    renderDashboard();

    const button = await screen.findByRole<HTMLButtonElement>('button', {
      name: 'Regenerate natal reading',
    });
    expect(button.disabled).toBe(true);
    expect(button.className).toContain('min-h-11');
    expect(button.className).toContain('min-w-11');
    expect(button.className).toContain('whitespace-nowrap');
  });

  it('REGRESSION: keeps the Regenerate button reachable when a completed reading has an EMPTY summary (recovery affordance, no dead-end)', async () => {
    configureCloudAi();
    // A completed, KEPT reading whose summary came back empty (placeholder) yet
    // still carries a valid insight field — hasValidInterpretation stays true.
    // The prose reading section (gated on a ready summary) does NOT render, but
    // the Regenerate button must remain reachable so the user can recover
    // instead of hitting a dead-end (auto-memory 17372).
    const emptySummaryReading: VedicInterpretation = {
      ...INTERPRETATION,
      summary: { layman: '', technical: '' },
    };
    useInterpretationStore.setState({ byChart: {} });
    useInterpretationStore
      .getState()
      .setInterpretation(
        'chart-1',
        emptySummaryReading,
        '2026-06-20T00:00:00Z',
        currentProvenance(),
        NATAL_ONLY_INPUT,
      );
    // Nothing should auto-fire (provenance matches); pin the stream just in case.
    mockedStream.mockImplementation(pendingStream());
    renderDashboard();

    const button = await screen.findByTestId<HTMLButtonElement>('regenerate-reading');
    // Empty summary → the prose section is hidden, yet the recovery affordance survives.
    expect(screen.queryByTestId('reading-section')).toBeNull();
    expect(button.disabled).toBe(false);
    await settle();
    // Matching provenance + a kept reading → no spurious regeneration.
    expect(mockedStream).not.toHaveBeenCalled();
  });

  it('disables the Regenerate button when no AI is configured (reading still shown)', async () => {
    // No settings written: tier is none. The stale reading must keep rendering.
    seedCompleteReading(STALE_PROVENANCE);
    renderDashboard();

    const reading = await screen.findByTestId('reading-section');
    expect(reading.textContent ?? '').toContain(LAYMAN_SUMMARY);
    expect(screen.getByTestId<HTMLButtonElement>('regenerate-reading').disabled).toBe(true);
    await settle();
    expect(mockedStream).not.toHaveBeenCalled();
  });

  it('captions the reading with the model that generated it and the date', async () => {
    configureCloudAi();
    seedCompleteReading(currentProvenance());
    renderDashboard();

    const caption = await screen.findByTestId('reading-provenance');
    expect(caption.textContent ?? '').toContain(currentProvenance().model);
    expect(caption.textContent ?? '').toContain('2026');
  });

  it('falls back to a date-only caption for a legacy reading with no provenance', async () => {
    // No AI configured (nothing regenerates) + a legacy pre-provenance entry:
    // the caption degrades gracefully to the date, never a blank "by".
    seedCompleteReading(undefined);
    renderDashboard();

    const caption = await screen.findByTestId('reading-provenance');
    expect(caption.textContent ?? '').toContain('2026');
    expect(caption.textContent ?? '').not.toContain('by ');
  });

  it('clicking Regenerate starts a new generation, keeps the old reading visible, and disables the button', async () => {
    configureCloudAi();
    seedCompleteReading(currentProvenance());
    mockedStream.mockImplementation(pendingStream());
    renderDashboard();

    const button = await screen.findByTestId('regenerate-reading');
    fireEvent.click(button);

    await waitFor(() => expect(mockedStream).toHaveBeenCalledTimes(1));
    // Keep-old-until-success: the prior reading stays on screen while the new
    // run is in flight, and the button cannot double-fire.
    const reading = screen.getByTestId('reading-section');
    expect(reading.textContent ?? '').toContain(LAYMAN_SUMMARY);
    // REGRESSION: keep-old-until-success must not hide the generation feedback.
    // The previous reading remains useful, while a distinct live progress panel
    // makes the paid request and its state unmistakable.
    expect(await screen.findByTestId('interpretation-progress')).toBeTruthy();
    expect(screen.getByTestId('interpretation-elapsed').textContent ?? '').toMatch(/elapsed/i);
    await waitFor(() =>
      expect(screen.getByTestId<HTMLButtonElement>('regenerate-reading').disabled).toBe(true),
    );
  });

  it('regenerates only the natal reading and never sends current predictive contexts', async () => {
    configureCloudAi();
    seedCompleteReading(currentProvenance());
    usePredictiveStore.setState({
      status: 'ready',
      profileKey: 'profile-1',
      requestKey: predictiveRequestKey({
        profileKey: 'profile-1',
        datetimeUtc: '1990-03-30T06:30:00Z',
        latitude: 12.97,
        longitude: 77.59,
        referenceInstant: '2026-07-12T00:00:00Z',
      }),
      rawContexts: {
        transit_context: { instant: '2026-07-12T00:00:00Z' },
        varga_context_full: { charts: {} },
        strength_context: {},
        domains_context: { forecasts: {} },
      } as never,
    });
    mockedStream.mockImplementation(pendingStream());
    renderDashboard();

    fireEvent.click(await screen.findByTestId('regenerate-reading'));

    await waitFor(() => expect(mockedStream).toHaveBeenCalledTimes(1));
    expect(mockedStream.mock.calls[0]?.[0].chart).not.toHaveProperty('transit_context');
    expect(mockedStream.mock.calls[0]?.[0].chart).not.toHaveProperty('domains_context');
    expect(mockedTimelineStream).not.toHaveBeenCalled();
  });

  it('REGRESSION: a second Generate click while the app is still starting spends exactly one paid run', async () => {
    configureCloudAi();
    useInterpretationStore.setState({ byChart: {} });
    mockedStream.mockImplementation(pendingStream());
    const openStartup = holdStartup();
    renderDashboard();

    const generate = await screen.findByTestId<HTMLButtonElement>('generate-reading');
    // Double activation while startup is still pending (double-click, impatient
    // second press): the second must attach to the first run, never buy another.
    fireEvent.click(generate);
    fireEvent.click(generate);
    await settle();
    // The in-flight run is visible before startup finishes: the button is
    // disabled and shows progress instead of inviting a third press.
    expect(generate.disabled).toBe(true);
    openStartup();

    await waitFor(() => expect(mockedStream).toHaveBeenCalledTimes(1));
    await settle();
    expect(mockedStream).toHaveBeenCalledTimes(1);
  });

  it('REGRESSION: a second timeline click while the app is still starting spends exactly one paid run', async () => {
    configureCloudAi();
    seedCompleteReading(currentProvenance());
    seedReadyPredictiveFacts();
    mockedTimelineStream.mockImplementation(pendingTimelineStream());
    const openStartup = holdStartup();
    renderDashboard();

    const generate = await screen.findByTestId<HTMLButtonElement>('generate-timeline');
    fireEvent.click(generate);
    fireEvent.click(generate);
    await settle();
    expect(generate.disabled).toBe(true);
    openStartup();

    await waitFor(() => expect(mockedTimelineStream).toHaveBeenCalledTimes(1));
    await settle();
    expect(mockedTimelineStream).toHaveBeenCalledTimes(1);
  });

  it('shows independent timeline progress and never replaces the retained natal reading', async () => {
    configureCloudAi();
    seedCompleteReading(currentProvenance());
    seedReadyPredictiveFacts();
    mockedTimelineStream.mockImplementation(pendingTimelineStream());
    renderDashboard();

    fireEvent.click(await screen.findByTestId('generate-timeline'));

    await waitFor(() => expect(mockedTimelineStream).toHaveBeenCalledTimes(1));
    expect(await screen.findByTestId('timeline-progress')).toBeTruthy();
    expect(screen.getByTestId('reading-section').textContent ?? '').toContain(LAYMAN_SUMMARY);
    expect(mockedStream).not.toHaveBeenCalled();
  });

  function seedReadyPredictiveFacts(): void {
    const today = predictiveReferenceInstant(new Date(), viewerTimeZone()).slice(0, 10);
    usePredictiveStore.setState({
      status: 'ready',
      profileKey: 'profile-1',
      requestKey: predictiveRequestKey({
        profileKey: 'profile-1',
        datetimeUtc: '1990-03-30T06:30:00Z',
        latitude: 12.97,
        longitude: 77.59,
        referenceInstant: `${today}T00:00:00Z`,
      }),
      rawContexts: {
        transit_context: { instant: `${today}T00:00:00Z` },
        varga_context_full: { charts: {} },
        strength_context: {},
        domains_context: { forecasts: {} },
      } as never,
    });
  }

  it('shows the road ahead as it is written, with a live word count', async () => {
    configureCloudAi();
    seedCompleteReading(currentProvenance());
    const today = predictiveReferenceInstant(new Date(), viewerTimeZone()).slice(0, 10);
    usePredictiveStore.setState({
      status: 'ready',
      profileKey: 'profile-1',
      requestKey: predictiveRequestKey({
        profileKey: 'profile-1',
        datetimeUtc: '1990-03-30T06:30:00Z',
        latitude: 12.97,
        longitude: 77.59,
        referenceInstant: `${today}T00:00:00Z`,
      }),
      rawContexts: {
        transit_context: { instant: `${today}T00:00:00Z` },
        varga_context_full: { charts: {} },
        strength_context: {},
        domains_context: { forecasts: {} },
      } as never,
    });
    mockedTimelineStream.mockImplementation(async function* (params) {
      params.onSectionProgress?.('upcoming_periods', { words: 42, preview: 'Jupiter period\nA season of growth', thinkingWords: 300 });
      await new Promise<never>(() => {});
      yield* [] as CurrentTimelineEvent[];
    });
    renderDashboard();

    fireEvent.click(await screen.findByTestId('generate-timeline'));

    const live = await screen.findByTestId('timeline-live-upcoming_periods');
    expect(live.textContent).toContain('A season of growth');
    expect(live.textContent).toContain('42 words');
    expect(screen.queryByTestId('timeline-live-current_sky')).toBeNull();
  });

  it('shows a reasoning model is thinking before the first prose arrives', async () => {
    configureCloudAi();
    seedCompleteReading(currentProvenance());
    const today = predictiveReferenceInstant(new Date(), viewerTimeZone()).slice(0, 10);
    usePredictiveStore.setState({
      status: 'ready',
      profileKey: 'profile-1',
      requestKey: predictiveRequestKey({
        profileKey: 'profile-1',
        datetimeUtc: '1990-03-30T06:30:00Z',
        latitude: 12.97,
        longitude: 77.59,
        referenceInstant: `${today}T00:00:00Z`,
      }),
      rawContexts: {
        transit_context: { instant: `${today}T00:00:00Z` },
        varga_context_full: { charts: {} },
        strength_context: {},
        domains_context: { forecasts: {} },
      } as never,
    });
    mockedTimelineStream.mockImplementation(async function* (params) {
      params.onSectionProgress?.('upcoming_periods', { words: 0, preview: '', thinkingWords: 215 });
      await new Promise<never>(() => {});
      yield* [] as CurrentTimelineEvent[];
    });
    renderDashboard();

    fireEvent.click(await screen.findByTestId('generate-timeline'));

    const live = await screen.findByTestId('timeline-live-upcoming_periods');
    expect(live.textContent).toContain('Thinking');
    expect(live.textContent).toContain('215 words');
  });

  it('names the error code of a failed timeline section in the partial-failure notice', async () => {
    configureCloudAi();
    seedCompleteReading(currentProvenance());
    const store = useInterpretationStore.getState();
    const run = store.startCurrentTimeline('chart-1');
    store.markCurrentTimelineSectionFailed('chart-1', 'upcoming_periods', run, 'ai.provider.server_error');
    await store.setCurrentTimeline(
      'chart-1',
      { upcoming_periods: [], current_sky: [{ title: 'Now', layman: 'Active', technical: 'Saturn' }] },
      '2026-06-21T00:00:00Z',
      currentProvenance(),
      NATAL_ONLY_INPUT,
      run,
    );
    renderDashboard();

    const notice = await screen.findByTestId('timeline-partial-failure');
    expect(notice.textContent).toContain('The road ahead (ai.provider.server_error)');
  });

  it('tells the user to retry or pick a faster model when a section hit the reasoning cap', async () => {
    configureCloudAi();
    seedCompleteReading(currentProvenance());
    const store = useInterpretationStore.getState();
    const run = store.startCurrentTimeline('chart-1');
    store.markCurrentTimelineSectionFailed('chart-1', 'upcoming_periods', run, 'ai.reasoning_timeout');
    await store.setCurrentTimeline(
      'chart-1',
      { upcoming_periods: [], current_sky: [{ title: 'Now', layman: 'Active', technical: 'Saturn' }] },
      '2026-06-21T00:00:00Z',
      currentProvenance(),
      NATAL_ONLY_INPUT,
      run,
    );
    renderDashboard();

    const notice = await screen.findByTestId('timeline-partial-failure');
    expect(notice.textContent).toContain('The road ahead (ai.reasoning_timeout)');
    expect(notice.textContent).toContain(
      'The model thought for over 3 minutes without starting its answer. Try again, or pick a faster model in Settings → AI.',
    );
  });

  it('queues an explicit timeline click without spending until current facts are ready', async () => {
    configureCloudAi();
    seedCompleteReading(currentProvenance());
    mockedTimelineStream.mockImplementation(pendingTimelineStream());
    renderDashboard();

    fireEvent.click(await screen.findByTestId('generate-timeline'));
    await settle();

    expect(mockedTimelineStream).not.toHaveBeenCalled();
    expect(screen.getByTestId<HTMLButtonElement>('generate-timeline').disabled).toBe(true);
  });

  it('does not regenerate on mount when provenance matches', async () => {
    configureCloudAi();
    seedCompleteReading(currentProvenance());
    renderDashboard();

    await screen.findByTestId('reading-section');
    await settle();
    expect(mockedStream).not.toHaveBeenCalled();
    expect(mockedTimelineStream).not.toHaveBeenCalled();
  });

  it('does not spend a provider request when a saved reading reopens after a deploy changes config', async () => {
    configureCloudAi();
    seedCompleteReading(STALE_PROVENANCE);
    renderDashboard();

    const reading = await screen.findByTestId('reading-section');
    expect(reading.textContent ?? '').toContain(LAYMAN_SUMMARY);
    await settle();

    expect(mockedStream).not.toHaveBeenCalled();
  });

  it('requires an explicit click before the first paid reading request', async () => {
    configureCloudAi();
    useInterpretationStore.setState({ byChart: {} });
    mockedStream.mockImplementation(completingStream(INTERPRETATION));
    renderDashboard();

    const generate = await screen.findByTestId('generate-reading');
    await settle();
    expect(mockedStream).not.toHaveBeenCalled();

    fireEvent.click(generate);
    await waitFor(() => expect(mockedStream).toHaveBeenCalledTimes(1));
  });

  it('keeps a legacy reading with no provider provenance without buying a replacement', async () => {
    configureCloudAi();
    seedCompleteReading(undefined);
    renderDashboard();

    expect((await screen.findByTestId('reading-section')).textContent ?? '').toContain(
      LAYMAN_SUMMARY,
    );
    await settle();
    expect(mockedStream).not.toHaveBeenCalled();
  });

  it('does not spend on rerender or a new predictive day', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date('2026-07-12T12:00:00Z'));
    configureCloudAi();
    seedCompleteReading(currentProvenance());
    const requestKey = (day: string) =>
      predictiveRequestKey({
        profileKey: 'profile-1',
        datetimeUtc: '1990-03-30T06:30:00Z',
        latitude: 12.97,
        longitude: 77.59,
        referenceInstant: `${day}T00:00:00Z`,
      });
    const rawContexts = {
      transit_context: { instant: '2026-07-12T00:00:00Z' },
      varga_context_full: { charts: {} },
      strength_context: {},
      domains_context: { forecasts: {} },
    } as never;
    usePredictiveStore.setState({
      status: 'ready',
      profileKey: 'profile-1',
      requestKey: requestKey('2026-07-12'),
      rawContexts,
    });
    void useInterpretationStore.getState().setCurrentTimeline(
      'chart-1',
      {
        upcoming_periods: [],
        current_sky: [
          { title: 'Yesterday', layman: 'Saved timing.', technical: 'Saved timing.' },
        ],
      },
      '2026-07-12T12:00:00Z',
      currentProvenance(),
      { predictiveRequestKey: requestKey('2026-07-12') },
    );
    const { queryClient, view } = renderDashboard();
    await screen.findByTestId('reading-section');
    await settle();

    act(() => {
      vi.setSystemTime(new Date('2026-07-13T00:00:01Z'));
      usePredictiveStore.setState({
        status: 'ready',
        profileKey: 'profile-1',
        requestKey: requestKey('2026-07-13'),
        rawContexts,
      });
    });
    act(() => useContentModeStore.setState({ contentMode: 'technical' }));
    view.rerender(dashboardUi(queryClient, 'after-deploy-rerender'));
    await settle();
    expect(mockedStream).not.toHaveBeenCalled();
    expect(mockedTimelineStream).not.toHaveBeenCalled();
    expect(screen.getByTestId('current-timeline-section')).toBeTruthy();
  });

  it('queues only the explicit timeline refresh while current predictive facts are loading', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date('2026-07-13T12:00:00Z'));
    configureCloudAi();
    seedCompleteReading(currentProvenance());
    const requestKey = (day: string) =>
      predictiveRequestKey({
        profileKey: 'profile-1',
        datetimeUtc: '1990-03-30T06:30:00Z',
        latitude: 12.97,
        longitude: 77.59,
        referenceInstant: `${day}T00:00:00Z`,
      });
    const currentRawContexts = {
      transit_context: { instant: '2026-07-13T00:00:00Z' },
      varga_context_full: { charts: {} },
      strength_context: {},
      domains_context: { forecasts: {} },
    } as never;
    usePredictiveStore.setState({
      status: 'ready',
      profileKey: 'profile-1',
      requestKey: requestKey('2026-07-12'),
      rawContexts: currentRawContexts,
    });
    mockedTimelineStream.mockImplementation(pendingTimelineStream());
    renderDashboard();

    await screen.findByTestId('generate-timeline');
    act(() => {
      usePredictiveStore.setState({
        status: 'loading',
        profileKey: 'profile-1',
        requestKey: requestKey('2026-07-13'),
        rawContexts: undefined,
      });
    });
    await settle();
    fireEvent.click(screen.getByTestId('generate-timeline'));

    await settle();
    expect(mockedTimelineStream).not.toHaveBeenCalled();
    expect(mockedStream).not.toHaveBeenCalled();

    act(() => {
      usePredictiveStore.setState({
        status: 'ready',
        profileKey: 'profile-1',
        requestKey: requestKey('2026-07-13'),
        rawContexts: currentRawContexts,
      });
    });

    await waitFor(() => expect(mockedTimelineStream).toHaveBeenCalledTimes(1));
    expect(mockedTimelineStream.mock.calls[0]?.[0].chart).toMatchObject({
      transit_context: { instant: '2026-07-13T00:00:00Z' },
    });
    // The independent natal artifact remains untouched while timing refreshes.
    expect(screen.getByTestId('reading-section').textContent ?? '').toContain(LAYMAN_SUMMARY);
    expect(mockedStream).not.toHaveBeenCalled();
  });


  it('a failed explicit regeneration does not retrigger and keeps the old reading on screen', async () => {
    configureCloudAi();
    seedCompleteReading(STALE_PROVENANCE);
    mockedStream.mockImplementation(failingStream(new Error('HTTP 500 from endpoint')));
    renderDashboard();

    fireEvent.click(await screen.findByTestId('regenerate-reading'));
    await waitFor(() => expect(mockedStream).toHaveBeenCalledTimes(1));
    await settle();
    // A provider/config mismatch never turns the failed click into a retry loop.
    expect(mockedStream).toHaveBeenCalledTimes(1);
    // The stale reading survives the failed run.
    const reading = screen.getByTestId('reading-section');
    expect(reading.textContent ?? '').toContain(LAYMAN_SUMMARY);
  });

  it('a FAILED manual regeneration surfaces an inline, dismissible error strip in the reading section', async () => {
    configureCloudAi();
    // Provenance matches: only the manual click runs.
    seedCompleteReading(currentProvenance());
    mockedStream.mockImplementation(failingStream(new Error('HTTP 500 from endpoint')));
    renderDashboard();

    fireEvent.click(await screen.findByTestId('regenerate-reading'));
    await waitFor(() => expect(mockedStream).toHaveBeenCalledTimes(1));

    // The failure is VISIBLE inside the reading section — not swallowed by
    // keep-old-until-success — while the old reading stays on screen.
    const strip = await screen.findByTestId('reading-regen-error');
    expect(within(screen.getByTestId('reading-section')).getByTestId('reading-regen-error')).toBe(strip);
    expect(screen.getByTestId('reading-section').textContent ?? '').toContain(LAYMAN_SUMMARY);

    // Actionable: Retry + the AI-settings door.
    expect(within(strip).getByTestId('reading-regen-retry')).toBeTruthy();
    const settingsLink = within(strip).getByTestId('reading-regen-ai-settings');
    expect(settingsLink.getAttribute('href')).toBe('/settings/ai');

    // Dismissible: the strip goes away, the reading stays.
    fireEvent.click(within(strip).getByTestId('reading-regen-dismiss'));
    expect(screen.queryByTestId('reading-regen-error')).toBeNull();
    expect(screen.getByTestId('reading-section').textContent ?? '').toContain(LAYMAN_SUMMARY);
  });

  it('REGRESSION: a failure embedding the endpoint URL renders friendly copy on the strip, never the URL', async () => {
    configureCloudAi();
    seedCompleteReading(currentProvenance());
    // The all-sections-failed aggregate is a plain Error whose message can
    // carry the configured endpoint (a build-time VITE_LLM_API_BASE value).
    mockedStream.mockImplementation(
      failingStream(
        new Error(
          'Interpretation failed: all 5 sections failed. ' +
            'LLM request to https://openrouter.example/api/v1/chat/completions failed (HTTP 401)',
        ),
      ),
    );
    renderDashboard();

    fireEvent.click(await screen.findByTestId('regenerate-reading'));
    const strip = await screen.findByTestId('reading-regen-error');
    const text = strip.textContent ?? '';
    expect(text).not.toContain('https://');
    expect(text).not.toContain('openrouter.example');
    // Friendly + actionable: points at retry / AI settings.
    expect(text).toMatch(/settings/i);
  });

  it('a dead/retired-model failure surfaces the switch-model prompt on the regen strip', async () => {
    configureCloudAi();
    seedCompleteReading(currentProvenance());
    mockedStream.mockImplementation(
      failingStream(
        new LlmRequestError('HTTP 404: No endpoints found for test-org/retired-model', {
          status: 404,
        }),
      ),
    );
    renderDashboard();

    fireEvent.click(await screen.findByTestId('regenerate-reading'));
    const strip = await screen.findByTestId('reading-regen-error');
    // The existing switch-model recovery: copy + the one-click preset button.
    expect(strip.textContent ?? '').toContain('Switch to the recommended model');
    expect(within(strip).getByTestId('reading-regen-switch-recommended')).toBeTruthy();
    // Neither the raw body nor the internal sentinel ever renders.
    expect(strip.textContent ?? '').not.toContain('No endpoints found');
    expect(strip.textContent ?? '').not.toContain('reading_model_unavailable');
  });

  it('Retry on the error strip starts a fresh generation (and clears the strip while running)', async () => {
    configureCloudAi();
    seedCompleteReading(currentProvenance());
    mockedStream.mockImplementation(failingStream(new Error('HTTP 500 from endpoint')));
    renderDashboard();

    fireEvent.click(await screen.findByTestId('regenerate-reading'));
    const strip = await screen.findByTestId('reading-regen-error');
    // Let the (pre-existing) single follow-up auto-attempt settle so the call
    // count below is stable before Retry is exercised.
    await settle();
    const callsBefore = mockedStream.mock.calls.length;

    mockedStream.mockImplementation(pendingStream());
    fireEvent.click(within(strip).getByTestId('reading-regen-retry'));

    await waitFor(() => expect(mockedStream.mock.calls.length).toBe(callsBefore + 1));
    // While the retry is in flight the error strip yields (status: generating).
    await waitFor(() => expect(screen.queryByTestId('reading-regen-error')).toBeNull());
  });

  it('with NO AI configured the disabled Regenerate also carries the connect-AI caption', async () => {
    // No settings written: tier is none — same rule, different guidance copy.
    seedCompleteReading(STALE_PROVENANCE);
    renderDashboard();

    await screen.findByTestId('reading-section');
    expect(screen.getByTestId<HTMLButtonElement>('regenerate-reading').disabled).toBe(true);
    const note = screen.getByTestId('regenerate-unavailable');
    expect(note.textContent ?? '').toContain('Connect an AI model');
    expect(note.querySelector('a')?.getAttribute('href')).toBe('/settings/ai');
  });
});
