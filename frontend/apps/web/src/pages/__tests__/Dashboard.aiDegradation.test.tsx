/**
 * Dashboard — the AI narration degrades GRACEFULLY, it does not "fail".
 *
 * The chart is fully computed on-device: ascendant, moon, dasha periods and the
 * Life Atlas are deterministic and complete with no AI at all. The written
 * interpretation is an OPTIONAL enhancement layered on top. So when the AI
 * provider is out of credits / not connected / not responding, the dashboard
 * must say "your chart is complete, only the written interpretation is missing"
 * in a calm, secondary treatment — never a red error block that reads as
 * "the product is broken".
 *
 * These tests pin three things:
 *   1. the calm treatment (no `text-status-error` / red surface) for an
 *      optional-enhancement outage,
 *   2. the chart-is-still-valid reassurance,
 *   3. THREE distinct modes — out of credits / no provider connected / provider
 *      unavailable — with different copy and different next steps.
 *
 * All chart/interpretation data below is SYNTHETIC.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  useChartLibraryStore,
  useContentModeStore,
  useInterpretationStore,
  usePredictiveStore,
  type StoredChart,
} from '@almamesh/store';
import type { BirthChartGenerationResponse } from '@almamesh/shared-types';

import '../../i18n/config';

vi.mock('@almamesh/llm', async () => {
  const actual = await vi.importActual<typeof import('@almamesh/llm')>('@almamesh/llm');
  return {
    ...actual,
    streamNatalInterpretation: vi.fn(),
    streamCurrentTimeline: vi.fn(),
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
  IdentityStrip: ({ actions }: { actions?: import('react').ReactNode }) => (
    <div data-testid="identity-strip">{actions}</div>
  ),
  LifeAtlas: () => null,
  DashboardInterpretation: () => null,
  ReadingGrounding: () => null,
}));

import {
  hydrateLlmSettings,
  LlmRequestError,
  openRouterPreset,
  streamNatalInterpretation,
  writeLlmSettings,
  type NatalInterpretationEvent,
} from '@almamesh/llm';
import { readLocalPrimaryChart } from '../../lib/localChartRead';
import DashboardPage from '../Dashboard';

const mockedStream = vi.mocked(streamNatalInterpretation);

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

function primaryChartResponse(): BirthChartGenerationResponse {
  const chart = storedChart();
  const { person_name, is_primary, chart_id, ...chartData } = chart as unknown as Record<
    string,
    unknown
  >;
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

function failingStream(error: Error): () => AsyncGenerator<NatalInterpretationEvent> {
  return async function* () {
    for (const e of [] as NatalInterpretationEvent[]) yield e;
    throw error;
  };
}

function configureCloudAi(): void {
  writeLlmSettings(openRouterPreset('sk-or-v1-0000-synthetic-test-key', 'test-org/test-model'));
}

function renderDashboard() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={['/dashboard']}>
        <DashboardPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

async function requestReading(): Promise<void> {
  fireEvent.click(await screen.findByTestId('generate-reading'));
}

/** The exhausted-balance failure a real OpenRouter account returns on every section. */
const OUT_OF_CREDITS = new LlmRequestError(
  'LLM endpoint returned 402 Payment Required: Insufficient credits',
  { status: 402 },
);

/** An upstream outage: every section call comes back 500. */
const PROVIDER_DOWN = new LlmRequestError(
  'Interpretation failed: all 6 sections failed. LLM endpoint returned 500 Internal Server Error',
  { status: 500 },
);

describe('Dashboard — AI narration degrades gracefully', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    hydrateLlmSettings(null);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.mocked(readLocalPrimaryChart).mockResolvedValue(primaryChartResponse());
    useChartLibraryStore.setState({ charts: { 'chart-1': storedChart() }, hydrated: true });
    useInterpretationStore.setState({ byChart: {} });
    useContentModeStore.setState({ contentMode: 'layman' });
    usePredictiveStore.getState().reset();
  });

  it('renders an out-of-credits outage CALMLY — no red error block competing with the chart', async () => {
    configureCloudAi();
    mockedStream.mockImplementation(failingStream(OUT_OF_CREDITS));
    const { container } = renderDashboard();
    await requestReading();

    const panel = await screen.findByTestId('interpretation-unavailable', undefined, {
      timeout: 5000,
    });

    // The old loud framing is gone: no "could not be generated" headline, no
    // red error text, no red-tinted surface.
    expect(screen.queryByText(/could not be generated/i)).toBeNull();
    expect(container.querySelector('.text-status-error')).toBeNull();
    expect(container.querySelector('[class*="border-status-error"]')).toBeNull();
    expect(container.querySelector('[class*="bg-status-error"]')).toBeNull();
    // Informational, not an alarm.
    expect(panel.getAttribute('role')).toBe('status');
  });

  it('says the CHART is complete and correct — only the written interpretation is missing', async () => {
    configureCloudAi();
    mockedStream.mockImplementation(failingStream(OUT_OF_CREDITS));
    renderDashboard();
    await requestReading();

    const panel = await screen.findByTestId('interpretation-unavailable', undefined, {
      timeout: 5000,
    });
    const text = panel.textContent ?? '';
    expect(text).toContain('Your chart is complete');
    expect(text).toMatch(/ascendant/i);
    expect(text).toMatch(/dasha/i);
    expect(text).toMatch(/only the written interpretation/i);
  });

  it('keeps recovery affordances discoverable but SECONDARY (below the reassurance)', async () => {
    configureCloudAi();
    mockedStream.mockImplementation(failingStream(OUT_OF_CREDITS));
    renderDashboard();
    await requestReading();

    const panel = await screen.findByTestId('interpretation-unavailable', undefined, {
      timeout: 5000,
    });
    // Retry + the AI-settings door still exist…
    expect(within(panel).getByTestId('interpretation-unavailable-retry')).toBeTruthy();
    expect(
      within(panel).getByTestId('interpretation-unavailable-ai-settings').getAttribute('href'),
    ).toBe('/settings/ai');
    // …but the reassurance comes FIRST in the reading order.
    const reassurance = within(panel).getByTestId('interpretation-unavailable-reassurance');
    const retry = within(panel).getByTestId('interpretation-unavailable-retry');
    expect(reassurance.compareDocumentPosition(retry) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('distinguishes OUT OF CREDITS from a provider outage and from no provider connected', async () => {
    // --- mode 1: out of credits -> add credits / switch to a cheaper model.
    configureCloudAi();
    mockedStream.mockImplementation(failingStream(OUT_OF_CREDITS));
    const credits = renderDashboard();
    await requestReading();
    const creditsText =
      (await screen.findByTestId('interpretation-unavailable', undefined, { timeout: 5000 }))
        .textContent ?? '';
    expect(creditsText).toMatch(/out of credits/i);
    expect(creditsText).toMatch(/cheaper model/i);
    expect(creditsText).not.toMatch(/isn't responding/i);
    expect(creditsText).not.toMatch(/no ai provider is connected/i);
    credits.unmount();

    // --- mode 2: the provider isn't responding -> try again shortly.
    useInterpretationStore.setState({ byChart: {} });
    mockedStream.mockImplementation(failingStream(PROVIDER_DOWN));
    const down = renderDashboard();
    await requestReading();
    const downText =
      (await screen.findByTestId('interpretation-unavailable', undefined, { timeout: 5000 }))
        .textContent ?? '';
    expect(downText).toMatch(/isn't responding right now/i);
    expect(downText).toMatch(/try again shortly/i);
    expect(downText).not.toMatch(/out of credits/i);
    down.unmount();

    // --- mode 3: nothing connected yet -> setup, not failure.
    hydrateLlmSettings(null);
    useInterpretationStore.setState({ byChart: {} });
    renderDashboard();
    const setup = await screen.findByTestId('interpretation-cta', undefined, { timeout: 5000 });
    const setupText = setup.textContent ?? '';
    expect(setupText).toMatch(/no ai provider is connected/i);
    expect(setupText).toContain('Your chart is complete');
    expect(setupText).not.toMatch(/out of credits/i);
    expect(setupText).not.toMatch(/isn't responding/i);
    // Its next step is the connect door, not Retry.
    expect(within(setup).getByTestId('connect-ai-link').getAttribute('href')).toBe('/settings/ai');
    expect(within(setup).queryByTestId('interpretation-unavailable-retry')).toBeNull();
  });

  it('keeps a GENUINE fault loud — a defect must not hide behind the calm treatment', async () => {
    configureCloudAi();
    // An unclassifiable failure (not a known provider condition) is a real
    // problem: it keeps the alert treatment rather than reading as "optional
    // extra unavailable".
    mockedStream.mockImplementation(failingStream(new Error('kaboom in the reading pipeline')));
    renderDashboard();
    await requestReading();

    await waitFor(
      () => expect(screen.getByTestId('interpretation-error')).toBeTruthy(),
      { timeout: 5000 },
    );
    expect(screen.queryByTestId('interpretation-unavailable')).toBeNull();
  });
});
