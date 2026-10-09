import type { ReactElement, ReactNode } from 'react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { act, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import {
  useChartLibraryStore,
  useLanguageStore,
  usePredictiveStore,
  useProfilesStore,
  predictiveRequestKey,
  type EnsurePredictiveInput,
  type PredictiveRuntime,
  type StoredChart,
} from '@almamesh/store';

import '../../../../i18n/config';
import {
  ChartEngineContext,
  type ChartEngineContextValue,
} from '../../../../providers/chartEngineContext';
import { LifeAtlas } from '../LifeAtlas';
import { LIFE_DOMAINS } from '../../../../lib/lifeAtlas';
import { DOMAINS_CTX } from '../../../../test/predictiveFixtures';
import { predictiveReferenceInstant } from '../../../../lib/predictive';
import { viewerTimeZone } from '../../../../lib/analysisInstant';

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

/** A booted-engine context value; the engine object itself is never invoked. */
function engineCtx(): ChartEngineContextValue {
  return {
    engine: {} as ChartEngineContextValue['engine'],
    stage: null,
    error: null,
    meta: null,
    reboot: () => Promise.reject(new Error('not used')),
    whenReady: () => Promise.reject(new Error('not used')),
    startBootstrap: () => {},
  };
}

function renderAtlas(ctx: ChartEngineContextValue | null = null): ReturnType<typeof render> {
  const Wrapper = ({ children }: { children: ReactNode }): ReactElement => (
    <ChartEngineContext.Provider value={ctx}>{children}</ChartEngineContext.Provider>
  );
  return render(
    <MemoryRouter>
      <Wrapper>
        <LifeAtlas />
      </Wrapper>
    </MemoryRouter>,
  );
}

describe('LifeAtlas', () => {
  beforeEach(() => {
    useLanguageStore.setState({ language: 'en' });
    useChartLibraryStore.setState({ charts: { 'chart-1': storedChart() }, hydrated: true });
    useProfilesStore.setState({ activeProfileId: 'chart-1' });
    usePredictiveStore.getState().reset();
    vi.restoreAllMocks();
  });

  it('renders nothing on a chart-less device (onboarding owns that path)', () => {
    useChartLibraryStore.setState({ charts: {}, hydrated: true });
    const { container } = renderAtlas();
    expect(container.firstChild).toBeNull();
  });

  it('says the birthplace timezone is missing (with a Settings link) instead of vanishing', () => {
    const chart = storedChart();
    const zoneless = {
      ...chart,
      birth_data: {
        ...chart.birth_data!,
        birth_location_details: { ...chart.birth_data!.birth_location_details, timezone: '' },
      },
    } as StoredChart;
    useChartLibraryStore.setState({ charts: { 'chart-1': zoneless }, hydrated: true });
    renderAtlas();
    const card = screen.getByTestId('birth-zone-missing');
    expect(card.textContent).toMatch(/timezone is missing/i);
    expect(within(card).getByRole('link').getAttribute('href')).toBe('/settings/profile#birthplace');
  });

  it('renders all seven domain cards in a designed pending state before data arrives', () => {
    renderAtlas();
    for (const domain of LIFE_DOMAINS) {
      const card = screen.getByTestId(`life-atlas-card-${domain}`);
      expect(card.textContent).toContain('Loading forecast');
    }
    // Pending cards are NOT links — nothing pretends data exists.
    expect(screen.getByTestId('life-atlas-card-career').getAttribute('href')).toBeNull();
  });

  it('shows the honest engine-warming note (no manual compute button) without an engine', () => {
    renderAtlas();
    const gate = screen.getByTestId('life-atlas-gate');
    // The Life Atlas is foundational — there is NEVER a manual compute button.
    expect(screen.queryByTestId('life-atlas-compute')).toBeNull();
    expect(gate.textContent).toContain('engine is still starting');
  });

  it('auto-computes shortly after the engine + chart are ready (deferred, no click)', async () => {
    // The kickoff is DEFERRED (idle/short-timeout) so the dashboard mount does
    // not starve the serial engine; drive it with fake timers.
    vi.useFakeTimers();
    try {
      const ensure = vi.fn(
        (_runtime: PredictiveRuntime, input: EnsurePredictiveInput): Promise<void> => {
          usePredictiveStore.setState({
            status: 'loading',
            profileKey: input.profileKey,
            requestKey: predictiveRequestKey(input),
          });
          usePredictiveStore.setState({
            status: 'ready',
            domainsCtx: DOMAINS_CTX,
            profileKey: input.profileKey,
            requestKey: predictiveRequestKey(input),
          });
          return Promise.resolve();
        },
      );
      usePredictiveStore.setState({ ensurePredictive: ensure });

      renderAtlas(engineCtx());

      // Nothing fires synchronously on mount — the engine stays free.
      expect(ensure).not.toHaveBeenCalled();
      expect(screen.getByTestId('life-atlas-card-career').getAttribute('href')).toBeNull();

      // Once the deferred kickoff elapses, the linked cards populate with NO
      // user interaction.
      await act(async () => {
        vi.advanceTimersByTime(2_500);
      });
      expect(screen.getByTestId('life-atlas-card-career').getAttribute('href')).toBe('/life/career');
      // Idempotency: compute fired exactly once.
      expect(ensure).toHaveBeenCalledTimes(1);
      // No manual affordance was ever shown.
      expect(screen.queryByTestId('life-atlas-compute')).toBeNull();
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it('shows honest elapsed copy while computing', () => {
    usePredictiveStore.setState({
      status: 'loading',
      profileKey: 'chart-1',
      requestKey: currentRequestKey(),
    });
    renderAtlas();
    expect(screen.getByTestId('life-atlas-gate').textContent).toContain('elapsed');
  });

  it('renders seven linked domain cards with band, emphasis and next window when ready', () => {
    usePredictiveStore.setState({
      status: 'ready',
      domainsCtx: DOMAINS_CTX,
      profileKey: 'chart-1',
      requestKey: currentRequestKey(),
    });
    renderAtlas();
    for (const domain of LIFE_DOMAINS) {
      const card = screen.getByTestId(`life-atlas-card-${domain}`);
      expect(card.getAttribute('href')).toBe(`/life/${domain}`);
    }
    const career = screen.getByTestId('life-atlas-card-career');
    expect(within(career).getByTestId('band-strong').textContent).toBe('Strong');
    expect(career.textContent).toContain('running daśā');
    expect(career.textContent).toContain('Next window');
    // The gate disappears once the data is on screen.
    expect(screen.queryByTestId('life-atlas-gate')).toBeNull();
    // The grid is squared with the deterministic "about" cell linking deeper.
    const about = screen.getByTestId('life-atlas-about');
    expect(within(about).getByRole('link').getAttribute('href')).toBe('/predictive');
  });

  it('offers in-app recovery on error and does NOT auto-loop (retry calls compute)', () => {
    const ensure = vi.fn((): Promise<void> => Promise.resolve());
    usePredictiveStore.setState({
      status: 'error',
      error: 'boom',
      profileKey: 'chart-1',
      requestKey: currentRequestKey(),
      ensurePredictive: ensure,
    });
    renderAtlas(engineCtx());
    expect(screen.getByTestId('life-atlas-gate').textContent).toContain('boom');
    const retry = screen.getByTestId('life-atlas-retry');
    // Auto mode must NOT have fired against an error state.
    expect(ensure).not.toHaveBeenCalled();
    // The retry is a real human-driven recovery affordance.
    retry.click();
    expect(ensure).toHaveBeenCalledTimes(1);
    // Status stays error until the (stubbed) compute resolves it.
    expect(usePredictiveStore.getState().status).toBe('error');
  });
});
