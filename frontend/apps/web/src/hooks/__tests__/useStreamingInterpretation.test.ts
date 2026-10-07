/**
 * Tests for useStreamingInterpretation hook — local-first, structured in-browser.
 *
 * The hook now drives @almamesh/llm's structured generator
 * (`streamNatalInterpretation` / `streamCurrentTimeline`) and mirrors their event streams into the
 * persisted `useInterpretationStore`. These tests assert the store-backed state
 * machine (idle -> generating -> complete/error), per-section progress, the
 * finished interpretation, the friendly fallback when no model is reachable, and
 * the fail-closed privacy surface.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';

import {
  READING_MODEL_UNAVAILABLE,
  resolveInterpretationConfig,
  useStreamingInterpretation,
} from '../useStreamingInterpretation';

// Mock the local LLM package: we drive the structured event stream + errors.
vi.mock('@almamesh/llm', async () => {
  const actual = await vi.importActual<typeof import('@almamesh/llm')>('@almamesh/llm');
  return {
    ...actual,
    streamNatalInterpretation: vi.fn(),
    streamCurrentTimeline: vi.fn(),
    requestEvidenceAnnotations: vi.fn(),
  };
});

// Mock the chart-library store so the hook can resolve a chart by id; the
// interpretation store is the REAL store (in-memory under vitest, no localStorage).
const getChart = vi.fn();
vi.mock('@almamesh/store', async () => {
  const actual = await vi.importActual<typeof import('@almamesh/store')>('@almamesh/store');
  return {
    ...actual,
    useChartLibraryStore: { getState: () => ({ getChart }) },
    whenInterpretationHydrated: vi.fn(async () => {}),
    interpretationWriteRefusal: vi.fn(() => undefined),
  };
});

vi.mock('../../lib/profileDataLifecycle', () => ({
  whenDataLifecycleReady: vi.fn(async () => {}),
}));

import {
  configProvenance,
  hydrateLlmSettings,
  streamCurrentTimeline,
  streamNatalInterpretation,
  requestEvidenceAnnotations,
  openRouterPreset,
  PrivacyViolationError,
  LlmRequestError,
  type CurrentTimelineEvent,
  type NatalInterpretationEvent,
} from '@almamesh/llm';
import {
  predictiveRequestKey,
  useInterpretationStore,
  useLanguageStore,
  usePredictiveStore,
  useProfilesStore,
  interpretationWriteRefusal,
  whenInterpretationHydrated,
} from '@almamesh/store';
import type { VedicInterpretation } from '@almamesh/shared-types';
import { whenDataLifecycleReady } from '../../lib/profileDataLifecycle';
import i18n from '../../i18n/config';

const mockedStream = vi.mocked(streamNatalInterpretation);
const mockedTimelineStream = vi.mocked(streamCurrentTimeline);
const mockedAnnotate = vi.mocked(requestEvidenceAnnotations);
const mockedInterpretationHydration = vi.mocked(whenInterpretationHydrated);
const mockedWriteRefusal = vi.mocked(interpretationWriteRefusal);
const mockedDataLifecycleReady = vi.mocked(whenDataLifecycleReady);

// A chart that carries the raw engine output the sanitizer needs.
const CHART_WITH_RAW = {
  chart_id: 'chart-123',
  profile_id: 'profile-123',
  // Anchored to the day its predictive facts were computed for (one analysis instant).
  astronomical_calculations: { calculation_timestamp: '2026-07-12T12:00:00.000Z' },
  birth_data: {
    birth_datetime_utc: '1990-03-30T06:45:00Z',
    birth_location_details: { latitude: 12.97, longitude: 77.59 },
  },
  sidereal_chart: { ayanamsa_value: 23.4, lagna: {}, planets: {}, houses: {}, yogas: [] },
};

// A chart carrying enough engine output for the deterministic evidence layer to
// build real observations: an ascendant, a debilitated Venus, a running dasha.
const CHART_WITH_FACTORS = {
  chart_id: 'chart-777',
  profile_id: 'profile-123',
  // Anchored to the day its predictive facts were computed for (one analysis instant).
  astronomical_calculations: { calculation_timestamp: '2026-07-12T12:00:00.000Z' },
  birth_data: {
    birth_datetime_utc: '1990-03-30T06:45:00Z',
    birth_location_details: { latitude: 12.97, longitude: 77.59 },
  },
  sidereal_chart: {
    ayanamsa_value: 23.4,
    lagna: { sign: 'Aries', sign_degrees: 14.2 },
    planets: {
      venus: {
        sign: 'Virgo',
        sign_degrees: 8.5,
        nakshatra: 'Hasta',
        nakshatra_pada: 2,
        dignity: 'debilitated',
        house: 6,
        houses_ruled: [2, 7],
        is_yogakaraka: false,
        is_combust: false,
        combustion_separation_deg: 12.4,
        is_retrograde: false,
        speed: 1.1,
      },
    },
    houses: {},
    yogas: [],
    dashas: {
      convention: 'vimshottari',
      current_maha: {
        lord: 'saturn',
        start_date: '2020-01-01',
        end_date: '2039-01-01',
        duration_years: 19,
      },
      maha_dasha_sequence: [
        {
          lord: 'saturn',
          start_date: '2020-01-01',
          end_date: '2039-01-01',
          duration_years: 19,
        },
      ],
    },
  },
};

const CURRENT_PREDICTIVE_KEY = predictiveRequestKey({
  profileKey: 'profile-123',
  datetimeUtc: '1990-03-30T06:45:00Z',
  latitude: 12.97,
  longitude: 77.59,
  referenceInstant: '2026-07-12T00:00:00Z',
});

const SAMPLE_INTERPRETATION: VedicInterpretation = {
  summary: { layman: 'A grounded soul.', technical: 'A grounded soul.' },
  strengths: [],
  challenges: [],
  life_themes: [],
  integrated_yoga_narrative: { layman: '', technical: '' },
  health_guidance: null,
  education_guidance: null,
  career_guidance: { layman: 'You build steadily.', technical: '' },
  relationship_guidance: null,
  finances_guidance: null,
  spiritual_guidance: null,
  life_evolution_guidance: null,
  remedial_measures: null,
};

function eventStream(events: NatalInterpretationEvent[]): () => AsyncGenerator<NatalInterpretationEvent> {
  return async function* () {
    for (const e of events) yield e;
  };
}

// A stream that throws a fatal error before any event. The empty-array loop
// keeps a real `yield` in the generator body (the streaming contract) while
// guaranteeing the error is thrown before any event reaches the hook.
function failingStream(error: Error): () => AsyncGenerator<NatalInterpretationEvent> {
  return async function* () {
    for (const e of [] as NatalInterpretationEvent[]) yield e;
    throw error;
  };
}

function timelineEventStream(
  events: CurrentTimelineEvent[],
): () => AsyncGenerator<CurrentTimelineEvent> {
  return async function* () {
    for (const event of events) yield event;
  };
}

describe('useStreamingInterpretation (structured, store-backed)', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date('2026-07-12T12:00:00Z'));
    vi.clearAllMocks();
    mockedDataLifecycleReady.mockResolvedValue(undefined);
    mockedInterpretationHydration.mockResolvedValue({ status: 'hydrated' });
    mockedWriteRefusal.mockReturnValue(undefined);
    getChart.mockReturnValue(CHART_WITH_RAW);
    // Deterministic LLM settings: no browser-local overrides between tests.
    hydrateLlmSettings(null);
    // Reset any persisted interpretation between tests.
    useInterpretationStore.setState({ byChart: {} });
    // Reset the language preference to the English default for each test.
    useLanguageStore.setState({ language: 'en' });
    useProfilesStore.setState({ activeProfileId: 'profile-123' });
    usePredictiveStore.getState().reset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('starts idle with no interpretation or error', () => {
    const { result } = renderHook(() => useStreamingInterpretation('chart-123'));
    expect(result.current.status).toBe('idle');
    expect(result.current.interpretation).toBeUndefined();
    expect(result.current.error).toBeNull();
    expect(result.current.isStreaming).toBe(false);
    expect(result.current.sections).toHaveLength(5);
    expect(result.current.timelineSections).toHaveLength(2);
  });

  it('refuses a provider stream when explicit user intent is absent at runtime', async () => {
    mockedStream.mockImplementation(eventStream([{ type: 'complete', interpretation: SAMPLE_INTERPRETATION }]));
    const { result } = renderHook(() => useStreamingInterpretation('chart-123'));

    await act(async () => {
      await result.current.streamInterpretation('chart-123', {} as never);
    });

    expect(mockedStream).not.toHaveBeenCalled();
    expect(result.current.status).toBe('idle');
  });

  it('waits for canonical SQLite hydration before an immediate provider failure', async () => {
    let releaseHydration: (() => void) | undefined;
    mockedInterpretationHydration.mockImplementationOnce(
      () => new Promise((resolve) => {
        releaseHydration = () => resolve({ status: 'hydrated' });
      }),
    );
    mockedStream.mockImplementation(failingStream(new LlmRequestError('HTTP 500')));
    const { result } = renderHook(() => useStreamingInterpretation('chart-123'));

    let generation: Promise<void> | undefined;
    act(() => {
      generation = result.current.streamInterpretation('chart-123', {
        intent: 'user-request',
      });
    });
    await act(async () => Promise.resolve());

    expect(mockedStream).not.toHaveBeenCalled();
    // INVERTED (was 'idle'): a requested paid run is in flight from the click,
    // not only once startup finishes — 'idle' here is what let a second click
    // buy a second provider run.
    expect(result.current.status).toBe('generating');

    releaseHydration?.();
    await act(async () => generation);
    expect(result.current.status).toBe('error');
  });

  it('refuses a paid natal run while an unreadable saved row is not held', async () => {
    const blocked = new Error('saving is paused');
    mockedInterpretationHydration.mockResolvedValueOnce({ status: 'failed', error: blocked });
    mockedWriteRefusal.mockReturnValue(blocked as never);
    mockedStream.mockImplementation(eventStream([{ type: 'complete', interpretation: SAMPLE_INTERPRETATION }]));
    const { result } = renderHook(() => useStreamingInterpretation('chart-123'));

    await act(async () => {
      await result.current.streamInterpretation('chart-123', { intent: 'user-request' });
    });

    expect(mockedStream).not.toHaveBeenCalled();
    expect(result.current.status).toBe('error');
    expect(result.current.error).toMatch(/could not be read/);
  });

  it('refuses a paid timeline run while an unreadable saved row is not held', async () => {
    const blocked = new Error('saving is paused');
    mockedInterpretationHydration.mockResolvedValueOnce({ status: 'failed', error: blocked });
    mockedWriteRefusal.mockReturnValue(blocked as never);
    const { result } = renderHook(() => useStreamingInterpretation('chart-123'));

    await act(async () => {
      await result.current.streamCurrentTimeline('chart-123', { intent: 'user-request' });
    });

    expect(mockedTimelineStream).not.toHaveBeenCalled();
    expect(useInterpretationStore.getState().byChart['chart-123']?.timeline?.error).toMatch(
      /could not be read/,
    );
  });

  it('waits for startup dataset reconciliation before hydrating or calling the provider', async () => {
    let releaseLifecycle: (() => void) | undefined;
    mockedDataLifecycleReady.mockImplementationOnce(
      () => new Promise<void>((resolve) => {
        releaseLifecycle = resolve;
      }),
    );
    mockedStream.mockImplementation(failingStream(new LlmRequestError('HTTP 500')));
    const { result } = renderHook(() => useStreamingInterpretation('chart-123'));

    let generation: Promise<void> | undefined;
    act(() => {
      generation = result.current.streamInterpretation('chart-123', {
        intent: 'user-request',
      });
    });
    await act(async () => Promise.resolve());

    expect(mockedInterpretationHydration).not.toHaveBeenCalled();
    expect(mockedStream).not.toHaveBeenCalled();
    // INVERTED (was 'idle'): a requested paid run is in flight from the click,
    // not only once startup finishes — 'idle' here is what let a second click
    // buy a second provider run.
    expect(result.current.status).toBe('generating');

    releaseLifecycle?.();
    await act(async () => generation);
    expect(mockedInterpretationHydration).toHaveBeenCalledOnce();
    expect(result.current.status).toBe('error');
  });

  it('marks sections complete and stores the finished interpretation', async () => {
    mockedStream.mockImplementation(
      eventStream([
        { type: 'section_complete', section: 'core' },
        { type: 'section_complete', section: 'guidance1' },
        { type: 'complete', interpretation: SAMPLE_INTERPRETATION },
      ]),
    );

    const { result } = renderHook(() => useStreamingInterpretation('chart-123'));
    await act(async () => {
      await result.current.streamInterpretation('chart-123', { intent: 'user-request', view_mode: 'layman' });
    });

    await waitFor(() => expect(result.current.status).toBe('complete'));
    expect(result.current.interpretation).toEqual(SAMPLE_INTERPRETATION);
    const byKey = Object.fromEntries(result.current.sections.map((s) => [s.key, s.complete]));
    expect(byKey.core).toBe(true);
    expect(byKey.guidance1).toBe(true);
    expect(byKey.remedial).toBe(false);
  });

  it('keeps a new reading hidden until its IndexedDB snapshot is durable', async () => {
    mockedStream.mockImplementation(
      eventStream([{ type: 'complete', interpretation: SAMPLE_INTERPRETATION }]),
    );
    const originalStorage = useInterpretationStore.persist.getOptions().storage;
    let releaseWrite: (() => void) | undefined;
    const writeBarrier = new Promise<void>((resolve) => {
      releaseWrite = resolve;
    });
    useInterpretationStore.persist.setOptions({
      storage: {
        getItem: async () => null,
        setItem: async () => writeBarrier,
        removeItem: async () => undefined,
      },
    });

    try {
      const { result } = renderHook(() => useStreamingInterpretation('chart-123'));
      let generation: Promise<void> | undefined;
      act(() => {
        generation = result.current.streamInterpretation('chart-123', {
          intent: 'user-request',
        });
      });

      await waitFor(() => {
        expect(useInterpretationStore.getState().getEntry('chart-123')?.interpretation)
          .toEqual(SAMPLE_INTERPRETATION);
      });
      expect(result.current.interpretation).toBeUndefined();
      expect(result.current.status).toBe('generating');

      releaseWrite?.();
      await act(async () => generation);
      expect(result.current.interpretation).toEqual(SAMPLE_INTERPRETATION);
      expect(result.current.status).toBe('complete');
    } finally {
      releaseWrite?.();
      useInterpretationStore.persist.setOptions({ storage: originalStorage });
    }
  });

  it('records per-section error events as failed sections (partial success stays complete)', async () => {
    // The generator degrades a failed section to empty and still completes —
    // the hook must record the failure instead of discarding the event.
    mockedStream.mockImplementation(
      eventStream([
        { type: 'section_complete', section: 'core' },
        { type: 'error', section: 'yoga', message: 'HTTP 500 from endpoint' },
        { type: 'section_complete', section: 'guidance1' },
        { type: 'section_complete', section: 'guidance2' },
        { type: 'section_complete', section: 'remedial' },
        { type: 'complete', interpretation: SAMPLE_INTERPRETATION },
      ]),
    );

    const { result } = renderHook(() => useStreamingInterpretation('chart-123'));
    await act(async () => {
      await result.current.streamInterpretation('chart-123', { intent: 'user-request' });
    });

    await waitFor(() => expect(result.current.status).toBe('complete'));
    expect(result.current.interpretation).toEqual(SAMPLE_INTERPRETATION);
    const byKey = Object.fromEntries(result.current.sections.map((s) => [s.key, s]));
    expect(byKey.yoga?.failed).toBe(true);
    expect(byKey.yoga?.complete).toBe(false);
    expect(byKey.core?.failed).toBe(false);
    expect(result.current.failedSections).toEqual(['yoga']);
  });

  it('clears failed sections when a new generation starts', async () => {
    mockedStream.mockImplementation(
      eventStream([
        { type: 'error', section: 'yoga', message: 'boom' },
        { type: 'section_complete', section: 'core' },
        { type: 'complete', interpretation: SAMPLE_INTERPRETATION },
      ]),
    );
    const { result } = renderHook(() => useStreamingInterpretation('chart-123'));
    await act(async () => {
      await result.current.streamInterpretation('chart-123', { intent: 'user-request' });
    });
    await waitFor(() => expect(result.current.failedSections).toEqual(['yoga']));

    // Regenerate with a fully-successful stream: the failure must not linger.
    mockedStream.mockImplementation(
      eventStream([
        { type: 'section_complete', section: 'yoga' },
        { type: 'complete', interpretation: SAMPLE_INTERPRETATION },
      ]),
    );
    await act(async () => {
      await result.current.streamInterpretation('chart-123', { intent: 'user-request' });
    });
    await waitFor(() => expect(result.current.failedSections).toEqual([]));
  });

  it('passes the raw chart and resolved mode to the generator', async () => {
    mockedStream.mockImplementation(
      eventStream([{ type: 'complete', interpretation: SAMPLE_INTERPRETATION }]),
    );

    const { result } = renderHook(() => useStreamingInterpretation('chart-123'));
    await act(async () => {
      await result.current.streamInterpretation('chart-123', { intent: 'user-request', view_mode: 'expert' });
    });

    expect(mockedStream).toHaveBeenCalledTimes(1);
    const arg = mockedStream.mock.calls[0][0];
    expect(arg.chart).toBe(CHART_WITH_RAW.sidereal_chart);
    expect(arg.mode).toBe('expert');
  });

  it('defaults to English when no language is chosen', async () => {
    mockedStream.mockImplementation(
      eventStream([{ type: 'complete', interpretation: SAMPLE_INTERPRETATION }]),
    );

    const { result } = renderHook(() => useStreamingInterpretation('chart-123'));
    await act(async () => {
      await result.current.streamInterpretation('chart-123', { intent: 'user-request', view_mode: 'layman' });
    });

    expect(mockedStream).toHaveBeenCalledTimes(1);
    expect(mockedStream.mock.calls[0][0].language).toBe('en');
  });

  it('passes the persisted UI language into the generator', async () => {
    useLanguageStore.setState({ language: 'es' });
    mockedStream.mockImplementation(
      eventStream([{ type: 'complete', interpretation: SAMPLE_INTERPRETATION }]),
    );

    const { result } = renderHook(() => useStreamingInterpretation('chart-123'));
    await act(async () => {
      await result.current.streamInterpretation('chart-123', { intent: 'user-request', view_mode: 'layman' });
    });

    expect(mockedStream).toHaveBeenCalledTimes(1);
    expect(mockedStream.mock.calls[0][0].language).toBe('es');
  });

  it('maps a request failure to friendly retry copy — never env-var names or endpoints', async () => {
    mockedStream.mockImplementation(failingStream(new LlmRequestError('LLM endpoint returned 0')));

    const { result } = renderHook(() => useStreamingInterpretation('chart-123'));
    await act(async () => {
      await result.current.streamInterpretation('chart-123', { intent: 'user-request' });
    });

    await waitFor(() => expect(result.current.status).toBe('error'));
    // The same actionable classification the chat path uses — never the old
    // developer-facing "set VITE_LLM_API_BASE / localhost:11434" notice.
    expect(result.current.error).toMatch(/try again in a moment/i);
    expect(result.current.error).not.toMatch(/VITE_/);
    expect(result.current.error).not.toMatch(/localhost/);
  });

  it('maps an unreachable endpoint (fetch TypeError) to "check AI settings" copy', async () => {
    mockedStream.mockImplementation(failingStream(new TypeError('Failed to fetch')));

    const { result } = renderHook(() => useStreamingInterpretation('chart-123'));
    await act(async () => {
      await result.current.streamInterpretation('chart-123', { intent: 'user-request' });
    });

    await waitFor(() => expect(result.current.status).toBe('error'));
    expect(result.current.error).toMatch(/couldn.t reach your ai endpoint/i);
  });

  it('REGRESSION: a bare non-network TypeError (a code bug) is NOT mislabeled "endpoint unreachable"', async () => {
    // A TypeError that is NOT a fetch failure — e.g. a genuine bug in the
    // reading pipeline — used to short-circuit to the unreachable-endpoint copy
    // (`err instanceof TypeError` alone), sending the user to check an endpoint
    // that was never the problem. It must now fall through to the generic
    // "try again / check settings" message. Diagnostics expose only an
    // allowlisted code; the private exception text must never reach the console.
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const bug = new TypeError("Cannot read properties of undefined (reading 'sections')");
    mockedStream.mockImplementation(failingStream(bug));

    const { result } = renderHook(() => useStreamingInterpretation('chart-123'));
    await act(async () => {
      await result.current.streamInterpretation('chart-123', { intent: 'user-request' });
    });

    await waitFor(() => expect(result.current.status).toBe('error'));
    expect(result.current.error).not.toMatch(/couldn.t reach your ai endpoint/i);
    expect(result.current.error).toMatch(/try again in a moment/i);
    expect(errSpy).toHaveBeenCalledWith('[almamesh:error:interpretation.stream_failed]');
    expect(JSON.stringify(errSpy.mock.calls)).not.toContain(bug.message);
    errSpy.mockRestore();
  });

  it('REGRESSION: a failure whose message embeds the endpoint URL surfaces friendly copy, never the URL', async () => {
    // The all-sections-failed aggregate is a plain Error whose message can
    // carry the configured VITE_LLM_API_BASE endpoint — it must never render.
    mockedStream.mockImplementation(
      failingStream(
        new Error(
          'Interpretation failed: all 5 sections failed. ' +
            'LLM request to https://openrouter.example/api/v1/chat/completions failed (HTTP 401)',
        ),
      ),
    );

    const { result } = renderHook(() => useStreamingInterpretation('chart-123'));
    await act(async () => {
      await result.current.streamInterpretation('chart-123', { intent: 'user-request' });
    });

    await waitFor(() => expect(result.current.status).toBe('error'));
    expect(result.current.error).not.toContain('https://');
    expect(result.current.error).not.toContain('openrouter.example');
    expect(result.current.error).toMatch(/settings/i);
  });

  it('maps an aggregate of per-section network failures to the unreachable-endpoint copy', async () => {
    mockedStream.mockImplementation(
      failingStream(
        new Error('Interpretation failed: all 5 sections failed. Failed to fetch; Failed to fetch'),
      ),
    );

    const { result } = renderHook(() => useStreamingInterpretation('chart-123'));
    await act(async () => {
      await result.current.streamInterpretation('chart-123', { intent: 'user-request' });
    });

    await waitFor(() => expect(result.current.status).toBe('error'));
    expect(result.current.error).toMatch(/couldn.t reach your ai endpoint/i);
  });

  it('maps a dead/retired model to the stable model-unavailable sentinel (switch-model prompt)', async () => {
    mockedStream.mockImplementation(
      failingStream(
        new LlmRequestError('HTTP 404: No endpoints found for test-org/retired-model', {
          status: 404,
        }),
      ),
    );

    const { result } = renderHook(() => useStreamingInterpretation('chart-123'));
    await act(async () => {
      await result.current.streamInterpretation('chart-123', { intent: 'user-request' });
    });

    await waitFor(() => expect(result.current.status).toBe('error'));
    // The sentinel — the dashboard maps it to the switch-model prompt, and the
    // raw "No endpoints found" body never reaches the screen.
    expect(result.current.error).toBe(READING_MODEL_UNAVAILABLE);
  });

  it('maps an exhausted-credits 402 to billing copy, never "check your model" advice', async () => {
    // REGRESSION (live repro 2026-07-03): a real OpenRouter key on an account
    // with usage ≥ credits gets HTTP 402 on every section. The old generic
    // copy ("check your model and endpoint… try again") sent the user in
    // circles — retrying can never fix a billing problem.
    mockedStream.mockImplementation(
      failingStream(
        new LlmRequestError(
          'LLM endpoint returned 402 Payment Required: {"error":{"message":"Insufficient credits. Add more using https://openrouter.ai/settings/credits","code":402}}',
          { status: 402 },
        ),
      ),
    );

    const { result } = renderHook(() => useStreamingInterpretation('chart-123'));
    await act(async () => {
      await result.current.streamInterpretation('chart-123', { intent: 'user-request' });
    });

    await waitFor(() => expect(result.current.status).toBe('error'));
    expect(result.current.error).toMatch(/credit/i);
    expect(result.current.error).not.toMatch(/check your model/i);
    expect(result.current.error).not.toContain('https://');
  });

  it('maps an insufficient-credits aggregate (no typed status) to the same billing copy', async () => {
    mockedStream.mockImplementation(
      failingStream(
        new Error(
          'Interpretation failed: all 6 sections failed. LLM endpoint returned 402 Payment Required: Insufficient credits',
        ),
      ),
    );

    const { result } = renderHook(() => useStreamingInterpretation('chart-123'));
    await act(async () => {
      await result.current.streamInterpretation('chart-123', { intent: 'user-request' });
    });

    await waitFor(() => expect(result.current.status).toBe('error'));
    expect(result.current.error).toMatch(/credit/i);
  });

  it('maps an all-sections-failed 401 aggregate to the auth-failed copy (rejected key)', async () => {
    // After the aggregation carries the representative HTTP status (fix 5), a
    // 401 on every section surfaces as a typed LlmRequestError; the reading must
    // say "your key was rejected", not the generic "try again in a moment".
    mockedStream.mockImplementation(
      failingStream(
        new LlmRequestError(
          'Interpretation failed: all 6 sections failed. LLM endpoint returned 401 Unauthorized',
          { status: 401 },
        ),
      ),
    );

    const { result } = renderHook(() => useStreamingInterpretation('chart-123'));
    await act(async () => {
      await result.current.streamInterpretation('chart-123', { intent: 'user-request' });
    });

    await waitFor(() => expect(result.current.status).toBe('error'));
    expect(result.current.error).toBe(i18n.t('chat:errors.auth_failed'));
    expect(result.current.error).not.toMatch(/try again in a moment/i);
  });

  it('maps an all-sections-failed 429 aggregate to the rate-limited copy', async () => {
    mockedStream.mockImplementation(
      failingStream(
        new LlmRequestError(
          'Interpretation failed: all 6 sections failed. LLM endpoint returned 429 Too Many Requests',
          { status: 429 },
        ),
      ),
    );

    const { result } = renderHook(() => useStreamingInterpretation('chart-123'));
    await act(async () => {
      await result.current.streamInterpretation('chart-123', { intent: 'user-request' });
    });

    await waitFor(() => expect(result.current.status).toBe('error'));
    expect(result.current.error).toBe(i18n.t('chat:errors.rate_limited'));
  });

  it('surfaces the privacy violation message verbatim (fail-closed)', async () => {
    mockedStream.mockImplementation(
      failingStream(new PrivacyViolationError('refusing to send chart data to non-local endpoint')),
    );

    const { result } = renderHook(() => useStreamingInterpretation('chart-123'));
    await act(async () => {
      await result.current.streamInterpretation('chart-123', { intent: 'user-request' });
    });

    await waitFor(() => expect(result.current.status).toBe('error'));
    expect(result.current.error).toMatch(/refusing to send/);
  });

  it('errors gracefully when the chart has no raw engine output', async () => {
    getChart.mockReturnValue({ chart_id: 'chart-123' }); // no sidereal_chart

    const { result } = renderHook(() => useStreamingInterpretation('chart-123'));
    await act(async () => {
      await result.current.streamInterpretation('chart-123', { intent: 'user-request' });
    });

    await waitFor(() => expect(result.current.status).toBe('error'));
    expect(result.current.error).toMatch(/regenerated/);
    expect(mockedStream).not.toHaveBeenCalled();
  });

  it('records the resolved config identity as the reading provenance on completion', async () => {
    mockedStream.mockImplementation(
      eventStream([{ type: 'complete', interpretation: SAMPLE_INTERPRETATION }]),
    );

    const { result } = renderHook(() => useStreamingInterpretation('chart-123'));
    await act(async () => {
      await result.current.streamInterpretation('chart-123', { intent: 'user-request' });
    });

    await waitFor(() => expect(result.current.status).toBe('complete'));
    const entry = useInterpretationStore.getState().getEntry('chart-123');
    // The provenance is the display identity of the SAME resolved config the
    // hook streamed with — so the UI can caption the reading with its model
    // and a later config change is detectable as a mismatch. It also carries
    // predictiveAware (false here: the predictive store is not ready in this
    // test), derived from the identity-keyed input provenance (null request key).
    expect(entry?.provenance).toEqual({
      ...configProvenance(resolveInterpretationConfig()),
      predictiveAware: false,
    });
    expect(entry?.provenance?.model).toBeTruthy();
    // Never a secret: the persisted object has exactly the identity + predictiveAware fields.
    expect(Object.keys(entry?.provenance ?? {}).sort()).toEqual(
      [...Object.keys(configProvenance(resolveInterpretationConfig())), 'predictiveAware'].sort(),
    );
  });

  it('keeps natal generation date-stable even when current predictive facts are ready', async () => {
    usePredictiveStore.setState({
      status: 'ready',
      profileKey: 'profile-123',
      requestKey: CURRENT_PREDICTIVE_KEY,
      rawContexts: {
        transit_context: { instant: '2026-07-12T00:00:00Z' },
        varga_context_full: { charts: {} },
        strength_context: {},
        domains_context: { forecasts: {} },
      },
    } as never);
    mockedStream.mockImplementation(
      eventStream([{ type: 'complete', interpretation: SAMPLE_INTERPRETATION }]),
    );

    const { result } = renderHook(() => useStreamingInterpretation('chart-123'));
    await act(async () => {
      await result.current.streamInterpretation('chart-123', { intent: 'user-request' });
    });

    const entry = useInterpretationStore.getState().getEntry('chart-123');
    expect(entry?.inputProvenance).toEqual({ predictiveRequestKey: null });
    expect(entry?.provenance?.predictiveAware).toBe(false);
    expect(mockedStream.mock.calls[0]?.[0].chart).not.toHaveProperty('transit_context');
  });

  it('records explicit natal-only provenance when no matching predictive facts were narrated', async () => {
    mockedStream.mockImplementation(
      eventStream([{ type: 'complete', interpretation: SAMPLE_INTERPRETATION }]),
    );

    const { result } = renderHook(() => useStreamingInterpretation('chart-123'));
    await act(async () => {
      await result.current.streamInterpretation('chart-123', { intent: 'user-request' });
    });

    expect(useInterpretationStore.getState().getEntry('chart-123')?.inputProvenance).toEqual({
      predictiveRequestKey: null,
    });
  });

  it('keeps a legacy combined reading visible after its old predictive key changes', () => {
    useInterpretationStore.getState().setInterpretation(
      'chart-123',
      SAMPLE_INTERPRETATION,
      '2026-07-11T00:00:00Z',
      configProvenance(resolveInterpretationConfig()),
      { predictiveRequestKey: '["profile-123","stale-birth","2026-07-11"]' },
    );

    const { result } = renderHook(() => useStreamingInterpretation('chart-123'));

    expect(result.current.status).toBe('complete');
    expect(result.current.interpretation).toEqual(SAMPLE_INTERPRETATION);
  });

  it('keeps a legacy reading visible when its old predictive input is unknown', () => {
    useInterpretationStore
      .getState()
      .setInterpretation(
        'chart-123',
        SAMPLE_INTERPRETATION,
        '2026-07-11T00:00:00Z',
        configProvenance(resolveInterpretationConfig()),
      );

    const { result } = renderHook(() => useStreamingInterpretation('chart-123'));

    expect(result.current.status).toBe('complete');
    expect(result.current.interpretation).toEqual(SAMPLE_INTERPRETATION);
  });

  it('keeps an explicitly natal-only reading reusable across predictive day changes', () => {
    useInterpretationStore.getState().setInterpretation(
      'chart-123',
      SAMPLE_INTERPRETATION,
      '2026-07-11T00:00:00Z',
      configProvenance(resolveInterpretationConfig()),
      { predictiveRequestKey: null },
    );

    const { result } = renderHook(() => useStreamingInterpretation('chart-123'));

    expect(result.current.status).toBe('complete');
    expect(result.current.interpretation).toEqual(SAMPLE_INTERPRETATION);
  });

  it('streams the current timeline independently without replacing the natal reading', async () => {
    usePredictiveStore.setState({
      status: 'ready',
      profileKey: 'profile-123',
      requestKey: CURRENT_PREDICTIVE_KEY,
      rawContexts: {
        transit_context: { instant: '2026-07-12T00:00:00Z' },
        varga_context_full: { charts: {} },
        strength_context: {},
        domains_context: { forecasts: {} },
      },
    } as never);
    await useInterpretationStore.getState().setInterpretation(
      'chart-123',
      SAMPLE_INTERPRETATION,
      '2026-07-11T00:00:00Z',
      undefined,
      { predictiveRequestKey: null },
    );
    mockedTimelineStream.mockImplementation(
      timelineEventStream([
        { type: 'section_complete', section: 'upcoming_periods' },
        { type: 'section_complete', section: 'current_sky' },
        {
          type: 'complete',
          timeline: {
            upcoming_periods: [],
            current_sky: [
              { title: 'Active now', layman: 'Build steadily.', technical: 'Saturn is active.' },
            ],
          },
        },
      ]),
    );

    const { result } = renderHook(() => useStreamingInterpretation('chart-123'));
    await act(async () => {
      await result.current.streamCurrentTimeline('chart-123', {
        intent: 'user-request',
        view_mode: 'layman',
      });
    });

    expect(mockedStream).not.toHaveBeenCalled();
    expect(result.current.interpretation).toEqual(SAMPLE_INTERPRETATION);
    expect(result.current.currentTimeline?.current_sky?.[0]?.title).toBe('Active now');
    expect(result.current.timelineStatus).toBe('complete');
    expect(result.current.timelineSections.every((section) => section.complete)).toBe(true);
  });

  it('records a canonical error code for a failed timeline section', async () => {
    usePredictiveStore.setState({
      status: 'ready',
      profileKey: 'profile-123',
      requestKey: CURRENT_PREDICTIVE_KEY,
      rawContexts: {
        transit_context: { instant: '2026-07-12T00:00:00Z' },
        varga_context_full: { charts: {} },
        strength_context: {},
        domains_context: { forecasts: {} },
      },
    } as never);
    await useInterpretationStore.getState().setInterpretation(
      'chart-123',
      SAMPLE_INTERPRETATION,
      '2026-07-11T00:00:00Z',
      undefined,
      { predictiveRequestKey: null },
    );
    mockedTimelineStream.mockImplementation(
      timelineEventStream([
        {
          type: 'error',
          section: 'upcoming_periods',
          message: 'LLM provider failed mid-generation',
          status: 502,
        },
        { type: 'section_complete', section: 'current_sky' },
        { type: 'complete', timeline: { upcoming_periods: [], current_sky: [] } },
      ]),
    );

    const { result } = renderHook(() => useStreamingInterpretation('chart-123'));
    await act(async () => {
      await result.current.streamCurrentTimeline('chart-123', {
        intent: 'user-request',
        view_mode: 'layman',
      });
    });

    expect(result.current.failedTimelineSections).toEqual(['upcoming_periods']);
    expect(result.current.failedTimelineSectionCodes).toEqual({
      upcoming_periods: 'ai.provider.server_error',
    });
  });

  async function seedTimelineReady(): Promise<void> {
    usePredictiveStore.setState({
      status: 'ready',
      profileKey: 'profile-123',
      requestKey: CURRENT_PREDICTIVE_KEY,
      rawContexts: {
        transit_context: { instant: '2026-07-12T00:00:00Z' },
        varga_context_full: { charts: {} },
        strength_context: {},
        domains_context: { forecasts: {} },
      },
    } as never);
    await useInterpretationStore.getState().setInterpretation(
      'chart-123',
      SAMPLE_INTERPRETATION,
      '2026-07-11T00:00:00Z',
      undefined,
      { predictiveRequestKey: null },
    );
  }

  it('exposes live timeline prose while a section streams, then clears it on completion', async () => {
    await seedTimelineReady();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    mockedTimelineStream.mockImplementation(async function* (params) {
      params.onSectionProgress?.('upcoming_periods', { words: 3, preview: 'A season of', thinkingWords: 12 });
      params.onSectionProgress?.('upcoming_periods', { words: 4, preview: 'A season of growth', thinkingWords: 12 });
      await gate;
      yield { type: 'section_complete', section: 'upcoming_periods' };
      yield { type: 'complete', timeline: { upcoming_periods: [], current_sky: [] } };
    });

    const { result } = renderHook(() => useStreamingInterpretation('chart-123'));
    let run!: Promise<void>;
    act(() => {
      run = result.current.streamCurrentTimeline('chart-123', { intent: 'user-request', view_mode: 'layman' });
    });
    await waitFor(() =>
      expect(result.current.timelineProgress).toEqual({
        upcoming_periods: { words: 4, preview: 'A season of growth', thinkingWords: 12 },
      }),
    );
    await act(async () => {
      release();
      await run;
    });
    expect(result.current.timelineProgress).toEqual({});
  });

  it('aborts the timeline stream on unmount and does not leave it generating', async () => {
    await seedTimelineReady();
    let seenSignal: AbortSignal | undefined;
    mockedTimelineStream.mockImplementation(async function* (params) {
      seenSignal = params.signal;
      await new Promise<void>((resolve) => params.signal?.addEventListener('abort', () => resolve()));
      if (params.signal?.aborted) {
        const err = new Error('aborted');
        err.name = 'AbortError';
        throw err;
      }
      yield { type: 'complete', timeline: { upcoming_periods: [], current_sky: [] } };
    });

    const { result, unmount } = renderHook(() => useStreamingInterpretation('chart-123'));
    act(() => {
      void result.current.streamCurrentTimeline('chart-123', { intent: 'user-request', view_mode: 'layman' });
    });
    await waitFor(() => expect(seenSignal).toBeDefined());
    expect(useInterpretationStore.getState().getEntry('chart-123')?.timeline?.status).toBe('generating');

    unmount();

    expect(seenSignal?.aborted).toBe(true);
    expect(useInterpretationStore.getState().getEntry('chart-123')?.timeline).toBeUndefined();
  });

  it('does not spend timeline calls before exact-day predictive facts are ready', async () => {
    const { result } = renderHook(() => useStreamingInterpretation('chart-123'));

    await act(async () => {
      await result.current.streamCurrentTimeline('chart-123', {
        intent: 'user-request',
        view_mode: 'layman',
      });
    });

    expect(mockedTimelineStream).not.toHaveBeenCalled();
    expect(result.current.timelineStatus).toBe('error');
    expect(result.current.timelineError).toMatch(/timing facts/i);
  });

  it('keeps the previously completed reading when a regeneration fails', async () => {
    mockedStream.mockImplementation(
      eventStream([{ type: 'complete', interpretation: SAMPLE_INTERPRETATION }]),
    );
    const { result } = renderHook(() => useStreamingInterpretation('chart-123'));
    await act(async () => {
      await result.current.streamInterpretation('chart-123', { intent: 'user-request' });
    });
    await waitFor(() => expect(result.current.status).toBe('complete'));

    // The regeneration fails outright — the old reading must survive.
    mockedStream.mockImplementation(failingStream(new LlmRequestError('HTTP 500')));
    await act(async () => {
      await result.current.streamInterpretation('chart-123', { intent: 'user-request' });
    });

    await waitFor(() => expect(result.current.status).toBe('error'));
    expect(result.current.interpretation).toEqual(SAMPLE_INTERPRETATION);
  });

  it('reset clears the entry back to idle', async () => {
    mockedStream.mockImplementation(
      eventStream([{ type: 'complete', interpretation: SAMPLE_INTERPRETATION }]),
    );
    const { result } = renderHook(() => useStreamingInterpretation('chart-123'));
    await act(async () => {
      await result.current.streamInterpretation('chart-123', { intent: 'user-request' });
    });
    await waitFor(() => expect(result.current.status).toBe('complete'));
    act(() => result.current.reset());
    await waitFor(() => expect(result.current.status).toBe('idle'));
    expect(result.current.interpretation).toBeUndefined();
  });

  // =========================================================================
  // The MACHINE-READABLE failure kind.
  //
  // `error` is a pre-localized sentence — useful to render, useless to switch
  // on. The reading panel has to tell "out of credits" from "the provider is
  // down" from "a genuine defect" to degrade gracefully instead of shouting,
  // so the hook exposes the typed kind ALONGSIDE the sentence (never instead
  // of it).
  // =========================================================================
  describe('errorKind (typed companion to the localized error sentence)', () => {
    it('is null while nothing has failed', () => {
      const { result } = renderHook(() => useStreamingInterpretation('chart-123'));
      expect(result.current.errorKind).toBeNull();
    });

    it('reports an exhausted balance as `credits`, keeping the billing sentence', async () => {
      mockedStream.mockImplementation(
        failingStream(
          new LlmRequestError('LLM endpoint returned 402 Payment Required: Insufficient credits', {
            status: 402,
          }),
        ),
      );

      const { result } = renderHook(() => useStreamingInterpretation('chart-123'));
      await act(async () => {
        await result.current.streamInterpretation('chart-123', { intent: 'user-request' });
      });

      await waitFor(() => expect(result.current.status).toBe('error'));
      expect(result.current.errorKind).toBe('credits');
      expect(result.current.error).toMatch(/credit/i);
    });

    it('reports a provider outage as `server` and an unreachable endpoint as `network`', async () => {
      mockedStream.mockImplementation(
        failingStream(
          new LlmRequestError('LLM endpoint returned 500 Internal Server Error', { status: 500 }),
        ),
      );
      const outage = renderHook(() => useStreamingInterpretation('chart-123'));
      await act(async () => {
        await outage.result.current.streamInterpretation('chart-123', { intent: 'user-request' });
      });
      await waitFor(() => expect(outage.result.current.errorKind).toBe('server'));

      mockedStream.mockImplementation(failingStream(new TypeError('Failed to fetch')));
      const unreachable = renderHook(() => useStreamingInterpretation('chart-456'));
      await act(async () => {
        await unreachable.result.current.streamInterpretation('chart-456', { intent: 'user-request' });
      });
      await waitFor(() => expect(unreachable.result.current.errorKind).toBe('network'));
    });

    it('reports a dead model as `model` and a privacy refusal as `privacy`', async () => {
      mockedStream.mockImplementation(
        failingStream(
          new LlmRequestError('HTTP 404: No endpoints found for test-org/retired-model', {
            status: 404,
          }),
        ),
      );
      const dead = renderHook(() => useStreamingInterpretation('chart-123'));
      await act(async () => {
        await dead.result.current.streamInterpretation('chart-123', { intent: 'user-request' });
      });
      await waitFor(() => expect(dead.result.current.errorKind).toBe('model'));
      // The sentinel sentence is unchanged — the dashboard still maps it.
      expect(dead.result.current.error).toBe(READING_MODEL_UNAVAILABLE);

      mockedStream.mockImplementation(
        failingStream(new PrivacyViolationError('refusing to send chart data')),
      );
      const refused = renderHook(() => useStreamingInterpretation('chart-789'));
      await act(async () => {
        await refused.result.current.streamInterpretation('chart-789', { intent: 'user-request' });
      });
      await waitFor(() => expect(refused.result.current.errorKind).toBe('privacy'));
    });

    it('reports a chart with no raw engine output as `needs_regeneration` (an app fault, not a provider outage)', async () => {
      getChart.mockReturnValue({ chart_id: 'chart-123' }); // no sidereal_chart

      const { result } = renderHook(() => useStreamingInterpretation('chart-123'));
      await act(async () => {
        await result.current.streamInterpretation('chart-123', { intent: 'user-request' });
      });

      await waitFor(() => expect(result.current.status).toBe('error'));
      expect(result.current.errorKind).toBe('needs_regeneration');
    });
  });

  // =========================================================================
  // Evidence annotations — the SECOND, optional model call
  // =========================================================================
  //
  // After a reading completes the hook asks the model to attach interpretation
  // prose to observations the deterministic engine ALREADY computed. It is a
  // separate step by design: the reading is saved and on screen before this
  // runs, so nothing about it can degrade the reading.
  describe('evidence annotations', () => {
    /** Opt into a configured cloud provider (the only state that may annotate). */
    function configureProvider(): void {
      hydrateLlmSettings(
        JSON.stringify(openRouterPreset('test-key', 'deepseek/deepseek-v4-pro')),
      );
    }

    const ANNOTATION_PAYLOAD = {
      readings: [
        {
          observation_id: 'dignity:venus',
          interpretation: 'Affection gets audited before it is offered.',
          also_cites: ['position:venus'],
        },
      ],
      general_guidance: ['Rest is not a reward for finishing.'],
    };

    beforeEach(() => {
      getChart.mockReturnValue(CHART_WITH_FACTORS);
      mockedStream.mockImplementation(
        eventStream([{ type: 'complete', interpretation: SAMPLE_INTERPRETATION }]),
      );
      mockedAnnotate.mockResolvedValue(ANNOTATION_PAYLOAD);
    });

    it('requests annotations for the REAL engine observations and persists the payload', async () => {
      configureProvider();

      const { result } = renderHook(() => useStreamingInterpretation('chart-777'));
      await act(async () => {
        await result.current.streamInterpretation('chart-777', { intent: 'user-request' });
      });

      await waitFor(() => expect(mockedAnnotate).toHaveBeenCalledTimes(1));
      const params = mockedAnnotate.mock.calls[0][0];

      // The observation list is the engine's, not a second one invented here.
      const ids = params.observations.map((o) => o.id);
      expect(ids).toContain('lagna');
      expect(ids).toContain('dignity:venus');
      expect(ids).toContain('dasha:maha:saturn');
      // Every prompt row carries a factual statement + the computed evidence.
      for (const observation of params.observations) {
        expect(observation.statement.length).toBeGreaterThan(0);
        expect(observation.evidence.length).toBeGreaterThan(0);
      }
      // The allowlist is every CITABLE factor — a superset of the observations.
      expect(params.factorIds).toContain('position:venus');
      expect(params.factorIds).toContain('house:venus');
      expect(params.factorIds.length).toBeGreaterThan(params.observations.length);
      // The chart crossed the privacy boundary: a sanitized copy, not the store's.
      expect(params.chart).not.toBe(CHART_WITH_FACTORS.sidereal_chart);
      expect(params.chart.lagna.sign).toBe('Aries');
      // Config, language and abort signal are the interpretation path's own.
      expect(params.config.apiKey).toBe('test-key');
      expect(params.language).toBe('en');
      expect(params.signal).toBeDefined();

      expect(useInterpretationStore.getState().byChart['chart-777']?.evidenceAnnotations).toEqual(
        ANNOTATION_PAYLOAD,
      );
    });

    it('sends the persisted UI language, not a hardcoded one', async () => {
      configureProvider();
      useLanguageStore.setState({ language: 'es' });

      const { result } = renderHook(() => useStreamingInterpretation('chart-777'));
      await act(async () => {
        await result.current.streamInterpretation('chart-777', { intent: 'user-request' });
      });

      await waitFor(() => expect(mockedAnnotate).toHaveBeenCalledTimes(1));
      expect(mockedAnnotate.mock.calls[0][0].language).toBe('es');
    });

    // THE LOAD-BEARING ONE. An annotation outage is an enhancement outage. If it
    // could take the reading down with it, the whole "separate step" claim is a
    // lie and a provider hiccup would erase a reading the user already has.
    it('a FAILED annotation call never degrades the reading', async () => {
      configureProvider();
      mockedAnnotate.mockRejectedValue(new LlmRequestError('HTTP 402 out of credits'));

      const { result } = renderHook(() => useStreamingInterpretation('chart-777'));
      await act(async () => {
        await result.current.streamInterpretation('chart-777', { intent: 'user-request' });
      });

      await waitFor(() => expect(result.current.status).toBe('complete'));
      expect(result.current.interpretation).toEqual(SAMPLE_INTERPRETATION);
      expect(result.current.error).toBeNull();
      expect(result.current.errorKind).toBeNull();
      // The evidence section renders keyless — no interpretation, everything else.
      expect(
        useInterpretationStore.getState().byChart['chart-777']?.evidenceAnnotations,
      ).toBeUndefined();
    });

    it('a THROWING observation build never degrades the reading either', async () => {
      configureProvider();
      // A chart with no `dashas` block: the deterministic factor builder throws.
      getChart.mockReturnValue(CHART_WITH_RAW);

      const { result } = renderHook(() => useStreamingInterpretation('chart-123'));
      await act(async () => {
        await result.current.streamInterpretation('chart-123', { intent: 'user-request' });
      });

      await waitFor(() => expect(result.current.status).toBe('complete'));
      expect(result.current.interpretation).toEqual(SAMPLE_INTERPRETATION);
      expect(mockedAnnotate).not.toHaveBeenCalled();
    });

    it('makes NO annotation call at all when no provider is configured', async () => {
      // The hydrated settings snapshot was cleared in beforeEach: the resolved config is the
      // unconfigured local_only loopback default, with no key.
      const { result } = renderHook(() => useStreamingInterpretation('chart-777'));
      await act(async () => {
        await result.current.streamInterpretation('chart-777', { intent: 'user-request' });
      });

      await waitFor(() => expect(result.current.status).toBe('complete'));
      expect(mockedAnnotate).not.toHaveBeenCalled();
      expect(
        useInterpretationStore.getState().byChart['chart-777']?.evidenceAnnotations,
      ).toBeUndefined();
    });

    it('makes no annotation call when the reading itself failed', async () => {
      configureProvider();
      mockedStream.mockImplementation(failingStream(new LlmRequestError('HTTP 500')));

      const { result } = renderHook(() => useStreamingInterpretation('chart-777'));
      await act(async () => {
        await result.current.streamInterpretation('chart-777', { intent: 'user-request' });
      });

      await waitFor(() => expect(result.current.status).toBe('error'));
      expect(mockedAnnotate).not.toHaveBeenCalled();
    });
  });
});
