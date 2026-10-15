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

  it('renders all eight domain cards in a designed pending state before data arrives', () => {
    renderAtlas();
    for (const domain of LIFE_DOMAINS) {
      const card = screen.getByTestId(`life-atlas-card-${domain}`);
      expect(card.textContent).toContain('Loading themes');
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

  it('never says "still starting up" after the engine boot failed: it shows the failure and a Retry that reboots', async () => {
    // Regression (CI 38295121396, iPhone WebKit): Pyodide failed fatally during
    // boot, the provider recorded the error, and the Life Atlas kept saying the
    // engine was "still starting up" for 240 s with no way out.
    const reboot = vi.fn(() => new Promise<never>(() => {}));
    renderAtlas({
      ...engineCtx(),
      engine: null,
      error: new Error('Fatal Python error: Failed to import encodings module'),
      reboot,
    });
    const gate = screen.getByTestId('life-atlas-gate');
    expect(gate.textContent).not.toContain('engine is still starting');
    expect(gate.textContent).toContain('Failed to import encodings module');
    const retry = screen.getByTestId('life-atlas-retry');
    expect(retry.hasAttribute('disabled')).toBe(false);
    await act(async () => {
      retry.click();
      await Promise.resolve();
    });
    expect(reboot).toHaveBeenCalledTimes(1);
  });

  it('keeps a computed reading on screen when the engine later fails', () => {
    usePredictiveStore.setState({
      status: 'ready',
      domainsCtx: DOMAINS_CTX,
      profileKey: 'chart-1',
      requestKey: currentRequestKey(),
    });
    renderAtlas({ ...engineCtx(), engine: null, error: new Error('chart worker terminated') });
    expect(screen.queryByTestId('life-atlas-gate')).toBeNull();
    expect(screen.getByTestId('life-atlas-card-career').getAttribute('href')).toBe('/life/career');
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

  it('renders eight linked domain cards with band, emphasis and next window when ready', () => {
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
    expect(screen.getByTestId('life-atlas').textContent).toContain('Eight domains of your life');
    // The grid is squared with the deterministic "about" cell linking deeper.
    const about = screen.getByTestId('life-atlas-about');
    expect(within(about).getByRole('link').getAttribute('href')).toBe('/predictive');
  });

  // The engine's 2026-10 obstacles domain (6th/8th/12th). Plain words, framed as a
  // theme to watch: never a prediction, never fear language. 2026-10-14 review: the
  // card carries one short subtitle like the others' density; the full sentence is its
  // tooltip (and the /life/obstacles page header).
  const OBSTACLES_COPY = {
    en: { name: 'Obstacles & setbacks', subtitle: 'Rules, legal matters, setbacks, losses', note: 'A theme to reflect on: friction with rules or authorities, legal or administrative matters, unexpected setbacks, losses and expenses (the 6th, 8th and 12th houses).' },
    es: { name: 'Obstáculos y contratiempos', subtitle: 'Normas, asuntos legales, contratiempos, pérdidas', note: 'Un tema para reflexionar: roces con normas o autoridades, asuntos legales o administrativos, contratiempos inesperados, pérdidas y gastos (casas 6, 8 y 12).' },
    pt: { name: 'Obstáculos e contratempos', subtitle: 'Regras, questões legais, contratempos, perdas', note: 'Um tema para refletir: atritos com regras ou autoridades, questões legais ou administrativas, contratempos inesperados, perdas e despesas (casas 6, 8 e 12).' },
  } as const;

  it.each(['en', 'es', 'pt'] as const)('shows the obstacles area as one short subtitle, the full note as its tooltip (%s)', async (language) => {
    const { default: i18n } = await import('../../../../i18n/config');
    await i18n.changeLanguage(language);
    usePredictiveStore.setState({
      status: 'ready',
      domainsCtx: DOMAINS_CTX,
      profileKey: 'chart-1',
      requestKey: currentRequestKey(),
    });
    renderAtlas();
    const card = screen.getByTestId('life-atlas-card-obstacles');
    expect(card.getAttribute('href')).toBe('/life/obstacles');
    expect(within(card).getByRole('heading').textContent).toBe(OBSTACLES_COPY[language].name);
    const subtitle = within(card).getByTestId('life-atlas-note-obstacles');
    expect(subtitle.textContent).toBe(OBSTACLES_COPY[language].subtitle);
    expect(subtitle.getAttribute('title')).toBe(OBSTACLES_COPY[language].note);
    expect(card.textContent).not.toContain(OBSTACLES_COPY[language].note);
    // Only the obstacles card carries a subtitle.
    expect(screen.getAllByTestId(/^life-atlas-note-/)).toHaveLength(1);
    await i18n.changeLanguage('en');
  });

  // 2026-10-14 review: a green "Strong" beside "Obstacles & setbacks" read as strong obstacles in a
  // reassuring colour. That band is natal Saturn's Shadbala, which the engine keeps as context only
  // for this domain (activation_only), so the card shows no strength badge. Every other card keeps one.
  it('shows no strength badge on the obstacles card, and one on every other card', () => {
    usePredictiveStore.setState({
      status: 'ready',
      domainsCtx: DOMAINS_CTX,
      profileKey: 'chart-1',
      requestKey: currentRequestKey(),
    });
    renderAtlas();
    expect(within(screen.getByTestId('life-atlas-card-obstacles')).queryByTestId(/^band-/)).toBeNull();
    for (const domain of ['career', 'finances', 'health', 'relationships', 'spiritual', 'education', 'family']) {
      expect(within(screen.getByTestId(`life-atlas-card-${domain}`)).getByTestId(/^band-/)).toBeTruthy();
    }
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
