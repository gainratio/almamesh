// i18n must be initialized before any component that calls useTranslation
import '../i18n/config';

import React from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import {
  useChartLibraryStore,
  useLifeEventsStore,
  useProfilesStore,
  useRectificationRecordsStore,
  registerRegenerationRunner,
  type BirthInfoChanged,
} from '@almamesh/store';
import { useRectification, type UseRectificationResult } from '../hooks/useRectification';
import { RectifyPage } from '../pages/Rectify';

// ---------------------------------------------------------------------------
// Hoisted helpers (available before vi.mock factories run)
// ---------------------------------------------------------------------------
const mockNavigate = vi.hoisted(() => vi.fn());
/** The strict chart-library write barrier; each test may make it fail or hang. */
const chartWrite = vi.hoisted(() => ({ next: (): Promise<void> => Promise.resolve() }));
const regenerationRunner = vi.fn((_event: BirthInfoChanged) => Promise.resolve());
let unregisterRunner: () => void = () => undefined;

// ---------------------------------------------------------------------------
// Heavy dep mocks — hoisted by Vitest before all imports
// ---------------------------------------------------------------------------

vi.mock('framer-motion', () => ({
  AnimatePresence: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  motion: { div: 'div' as unknown as React.ComponentType },
}));

vi.mock('../providers/chartEngineContext', () => ({
  useOptionalChartEngine: () => null,
  useChartEngine: () => null,
}));

vi.mock('../lib/predictive', () => ({
  predictiveReferenceInstant: () => '2026-01-01T00:00:00Z',
}));

vi.mock('../hooks/useRectification', () => ({
  useRectification: vi.fn(),
}));

vi.mock('../components/features/rectify/EventEntryStep', () => ({
  EventEntryStep: ({ onContinue }: { onContinue: () => void }) => (
    <div data-testid="event-entry-step">
      <button onClick={onContinue} data-testid="events-continue-btn">
        Continue
      </button>
    </div>
  ),
}));

vi.mock('../components/features/rectify/RectifyResults', () => ({
  RectifyResults: ({
    onConfirm,
    onKeepRecorded,
    result,
    recordedReading,
  }: {
    onConfirm: (c: unknown) => void;
    onKeepRecorded: () => void;
    result: { candidates: unknown[] };
    recordedReading: { signDegrees?: number } | null;
  }) => (
    <div
      data-testid="rectify-results"
      data-has-recorded={recordedReading != null ? 'true' : 'false'}
      data-recorded-degrees={
        recordedReading?.signDegrees != null ? String(recordedReading.signDegrees) : ''
      }
    >
      <button onClick={() => onConfirm(result.candidates[0])} data-testid="confirm-candidate-btn">
        Use this time
      </button>
      <button onClick={onKeepRecorded} data-testid="keep-recorded-btn">
        Keep recorded
      </button>
    </div>
  ),
}));

vi.mock('../components/features/settings/RegenerationConfirmModal', () => {
  const Stub = ({
    isOpen,
    onConfirm,
    onClose,
    signFlip,
  }: {
    isOpen: boolean;
    onConfirm: () => void;
    onClose: () => void;
    signFlip?: { from: string; to: string } | null;
  }) => {
    const [acked, setAcked] = React.useState(false);
    if (!isOpen) return null;
    return (
      <div data-testid="regen-modal">
        {signFlip && (
          <label data-testid="regen-flip-ack">
            <input
              type="checkbox"
              checked={acked}
              onChange={(e) => setAcked(e.target.checked)}
            />
          </label>
        )}
        <button
          onClick={onConfirm}
          disabled={signFlip != null && !acked}
          data-testid="regen-confirm-btn"
        >
          Confirm
        </button>
        <button onClick={onClose} data-testid="regen-cancel-btn">
          Cancel
        </button>
      </div>
    );
  };
  return { RegenerationConfirmModal: Stub };
});

vi.mock('@almamesh/store', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@almamesh/store')>();
  return { ...actual, whenChartLibraryCommitted: () => chartWrite.next() };
});

vi.mock('react-router-dom', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-router-dom')>();
  return {
    ...actual,
    useParams: () => ({ profileId: 'profile-abc' }),
    useNavigate: () => mockNavigate,
  };
});

// ---------------------------------------------------------------------------
// Synthetic test fixtures — NO real birth data
// ---------------------------------------------------------------------------

const PROFILE_ID = 'profile-abc';

const MOCK_CHART = {
  chart_id: 'chart-1',
  profile_id: PROFILE_ID,
  is_primary: true,
  person_name: 'Test User',
  birth_data: {
    birth_datetime_utc: '1990-05-15T02:00:00Z',
    birth_datetime_local: '1990-05-15T07:30',
    birth_location_details: {
      latitude: 18.5,
      longitude: 73.8,
      timezone: 'Asia/Kolkata',
      location_name: 'Pune, India',
    },
    birth_time_original: '07:30',
  },
  // The working natal chart at the RECORDED time — its lagna carries the
  // engine's actual in-sign degrees (synthetic values; sign matches
  // MOCK_RESULT.recordedTimeSign case-insensitively, as the engine emits
  // Title-Case while the result sign is lowercase).
  sidereal_chart: {
    lagna: { sign: 'Aquarius', sign_degrees: 22.93 },
  },
};

/** Chart with birth_time_confidence: 'unknown' — user never entered a time. */
const MOCK_CHART_UNKNOWN = {
  ...MOCK_CHART,
  birth_data: {
    ...MOCK_CHART.birth_data,
    birth_time_confidence: 'unknown',
  },
};

const MOCK_RESULT = {
  mode: 'cusp' as const,
  candidates: [
    {
      ascendantSign: 'pisces',
      representativeTimeLocal: '07:45',
      lagnaLongitudeDeg: 333.8,
      lagnaCuspDistanceDeg: 3.8,
      isNearCusp: true,
      fitScore: 0.72,
      supportingEvents: [],
    },
    {
      ascendantSign: 'aquarius',
      representativeTimeLocal: '07:30',
      lagnaLongitudeDeg: 328.8,
      lagnaCuspDistanceDeg: 1.2,
      isNearCusp: true,
      fitScore: 0.68,
      supportingEvents: [],
    },
  ],
  margin: 0.04,
  band: 'leans' as const,
  discriminatingEventCount: 2,
  recordedTimeSign: 'aquarius',
  honestyNoteKey: 'rectify.honesty.leans',
};

// ---------------------------------------------------------------------------
// Render helper
// ---------------------------------------------------------------------------

function renderRectify() {
  return render(
    <MemoryRouter initialEntries={['/rectify/profile-abc']}>
      <Routes>
        <Route path="/rectify/:profileId" element={<RectifyPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('RectifyPage', () => {
  let mockRun: ReturnType<typeof vi.fn>;
  let mockReset: ReturnType<typeof vi.fn>;
  let mockRetry: ReturnType<typeof vi.fn>;

  /** Build a full useRectification return value with sensible defaults. */
  function hookState(overrides: Partial<UseRectificationResult> = {}): UseRectificationResult {
    return {
      state: { status: 'idle', result: null, error: null },
      engineReady: true,
      engineError: null,
      engineErrorCode: null,
      engineStage: null,
      missingBirth: false,
      warmingTimedOut: false,
      hasEnoughEvents: true,
      detectedMode: 'cusp',
      run: mockRun as never,
      reset: mockReset as never,
      retry: mockRetry as never,
      ...overrides,
    };
  }

  beforeEach(() => {
    mockRun = vi.fn().mockResolvedValue(undefined);
    mockReset = vi.fn();
    mockRetry = vi.fn();
    mockNavigate.mockReset();

    vi.mocked(useRectification).mockReturnValue(hookState());

    useChartLibraryStore.setState({ charts: { 'chart-1': MOCK_CHART as never } });
    useProfilesStore.setState({
      activeProfileId: PROFILE_ID,
      profiles: {
        [PROFILE_ID]: {
          id: PROFILE_ID,
          name: 'Test User',
          createdAt: '2026-01-01T00:00:00Z',
          avatarTint: '#888888',
        } as never,
      },
    });

    // Stands in for App.tsx's regeneration subscriber (the page awaits it).
    regenerationRunner.mockReset();
    regenerationRunner.mockImplementation(() => Promise.resolve());
    unregisterRunner = registerRegenerationRunner(regenerationRunner);
  });

  afterEach(() => {
    vi.useRealTimers();
    chartWrite.next = () => Promise.resolve();
    unregisterRunner();
    vi.restoreAllMocks();
    useChartLibraryStore.setState({ charts: {} });
    useLifeEventsStore.setState({ eventsByProfile: {} });
    useRectificationRecordsStore.setState({ recordsByProfile: {} });
  });

  /** Navigate from fit step to results by updating the mock and rerendering. */
  async function navigateToResults(rerender: ReturnType<typeof renderRectify>['rerender']) {
    vi.mocked(useRectification).mockReturnValue(
      hookState({ state: { status: 'ready', result: MOCK_RESULT as never, error: null } }),
    );
    rerender(
      <MemoryRouter initialEntries={['/rectify/profile-abc']}>
        <Routes>
          <Route path="/rectify/:profileId" element={<RectifyPage />} />
        </Routes>
      </MemoryRouter>,
    );
    await screen.findByTestId('rectify-results');
  }

  it('renders intro step', async () => {
    renderRectify();
    expect(await screen.findByText('Refine Your Birth Time')).toBeTruthy();
    expect(screen.getByText('Narrow your rising sign')).toBeTruthy();
    expect(screen.getByTestId('intro-start-btn')).toBeTruthy();
  });

  it('first-time user with no events starts on the intro step', async () => {
    // No events seeded — store default is empty
    renderRectify();
    expect(await screen.findByTestId('intro-start-btn')).toBeTruthy();
    expect(screen.queryByTestId('event-entry-step')).toBeNull();
  });

  it('returning user with existing structured events starts on the events step', async () => {
    // Seed one structured event for the profile so the wizard skips the intro
    useLifeEventsStore.setState({
      eventsByProfile: {
        [PROFILE_ID]: [
          {
            id: 'evt-1',
            label: 'Got a job',
            date: '2010-06-01',
            category: 'career',
            needsStructuring: false,
          } as never,
        ],
      },
    });
    renderRectify();
    expect(await screen.findByTestId('event-entry-step')).toBeTruthy();
    expect(screen.queryByTestId('intro-start-btn')).toBeNull();
  });

  it('Start navigates to events step', async () => {
    renderRectify();
    const startBtn = await screen.findByTestId('intro-start-btn');
    fireEvent.click(startBtn);
    expect(await screen.findByTestId('event-entry-step')).toBeTruthy();
  });

  it('Continue shows the honest-window question; starting with the default calls run("cusp")', async () => {
    renderRectify();
    fireEvent.click(await screen.findByTestId('intro-start-btn'));
    const continueBtn = await screen.findByTestId('events-continue-btn');
    fireEvent.click(continueBtn);

    // Spec 062: the fit does NOT auto-start — the honest-window question comes first.
    expect(await screen.findByTestId('window-selector')).toBeTruthy();
    expect(mockRun).not.toHaveBeenCalled();

    // Default for a cusp-detected profile is "as recorded" → cusp comparison.
    fireEvent.click(screen.getByTestId('window-start-btn'));
    expect(mockRun).toHaveBeenCalledWith('cusp');
    expect(await screen.findByText('Analysing your events…')).toBeTruthy();
  });

  describe('honest-window selector (Spec 062)', () => {
    /** intro → events → fit (selector visible). */
    async function gotoSelector() {
      renderRectify();
      fireEvent.click(await screen.findByTestId('intro-start-btn'));
      fireEvent.click(await screen.findByTestId('events-continue-btn'));
      return screen.findByTestId('window-selector');
    }

    it('renders all six symmetric options and no "%" anywhere', async () => {
      const selector = await gotoSelector();
      for (const id of ['as_recorded', 'quarter', 'half', 'hour', 'two_hours', 'whole_day']) {
        expect(screen.getByTestId(`window-option-${id}`)).toBeTruthy();
      }
      expect(selector.textContent).not.toContain('%');
      expect(selector.textContent).toMatch(/how sure are you/i);
    });

    it('±30m maps to run("window", 60) — spanMinutes is the TOTAL span', async () => {
      await gotoSelector();
      fireEvent.click(
        screen.getByTestId('window-option-half').querySelector('input') as HTMLInputElement,
      );
      fireEvent.click(screen.getByTestId('window-start-btn'));
      expect(mockRun).toHaveBeenCalledWith('window', 60);
    });

    it('±2h maps to run("window", 240)', async () => {
      await gotoSelector();
      fireEvent.click(
        screen.getByTestId('window-option-two_hours').querySelector('input') as HTMLInputElement,
      );
      fireEvent.click(screen.getByTestId('window-start-btn'));
      expect(mockRun).toHaveBeenCalledWith('window', 240);
    });

    it('whole day maps to run("window") with NO spanMinutes', async () => {
      await gotoSelector();
      fireEvent.click(
        screen.getByTestId('window-option-whole_day').querySelector('input') as HTMLInputElement,
      );
      fireEvent.click(screen.getByTestId('window-start-btn'));
      expect(mockRun).toHaveBeenCalledWith('window');
    });

    it('unknown-time profiles skip the question entirely and auto-run the whole day', async () => {
      useChartLibraryStore.setState({ charts: { 'chart-1': MOCK_CHART_UNKNOWN as never } });
      vi.mocked(useRectification).mockReturnValue(hookState({ detectedMode: 'window' }));
      renderRectify();
      fireEvent.click(await screen.findByTestId('intro-start-btn'));
      fireEvent.click(await screen.findByTestId('events-continue-btn'));
      // No recorded time to be sure about — no question, straight to the scan.
      expect(screen.queryByTestId('window-selector')).toBeNull();
      expect(mockRun).toHaveBeenCalledWith('window');
    });
  });

  it('rerender with ready status shows results', async () => {
    const { rerender } = renderRectify();
    fireEvent.click(await screen.findByTestId('intro-start-btn'));
    fireEvent.click(await screen.findByTestId('events-continue-btn'));
    await navigateToResults(rerender);
    expect(screen.getByTestId('rectify-results')).toBeTruthy();
  });

  it('threads the ENGINE recorded-lagna degrees into the AS RECORDED reading (regression: hardcoded 0°)', async () => {
    // The stored working chart's lagna is Aquarius 22.93° — the results page
    // must show those real degrees, never a misleading 0°00' cusp reading.
    const { rerender } = renderRectify();
    fireEvent.click(await screen.findByTestId('intro-start-btn'));
    fireEvent.click(await screen.findByTestId('events-continue-btn'));
    await navigateToResults(rerender);
    expect(screen.getByTestId('rectify-results').getAttribute('data-recorded-degrees')).toBe(
      '22.93',
    );
  });

  it('omits the recorded degrees (no invented 0°) when the stored chart lagna does not match the result sign', async () => {
    useChartLibraryStore.setState({
      charts: {
        'chart-1': {
          ...MOCK_CHART,
          sidereal_chart: { lagna: { sign: 'Pisces', sign_degrees: 1.2 } },
        } as never,
      },
    });
    const { rerender } = renderRectify();
    fireEvent.click(await screen.findByTestId('intro-start-btn'));
    fireEvent.click(await screen.findByTestId('events-continue-btn'));
    await navigateToResults(rerender);
    // Comparison still renders (sign + time), but with NO degrees value.
    expect(screen.getByTestId('rectify-results').getAttribute('data-has-recorded')).toBe('true');
    expect(screen.getByTestId('rectify-results').getAttribute('data-recorded-degrees')).toBe('');
  });

  it('confirm candidate with sign flip opens modal and blocks without ack', async () => {
    const { rerender } = renderRectify();
    fireEvent.click(await screen.findByTestId('intro-start-btn'));
    fireEvent.click(await screen.findByTestId('events-continue-btn'));
    await navigateToResults(rerender);

    fireEvent.click(screen.getByTestId('confirm-candidate-btn'));

    const modal = await screen.findByTestId('regen-modal');
    expect(modal).toBeTruthy();
    // sign flip: pisces (candidate) != aquarius (recorded) → checkbox shown
    expect(screen.getByTestId('regen-flip-ack')).toBeTruthy();
    // confirm button disabled until ack
    expect((screen.getByTestId('regen-confirm-btn') as HTMLButtonElement).disabled).toBe(true);
  });

  it('ack enables confirm which requests regeneration and navigates', async () => {
    const { rerender } = renderRectify();
    fireEvent.click(await screen.findByTestId('intro-start-btn'));
    fireEvent.click(await screen.findByTestId('events-continue-btn'));
    await navigateToResults(rerender);

    // Open modal
    fireEvent.click(screen.getByTestId('confirm-candidate-btn'));
    await screen.findByTestId('regen-modal');

    // Check the ack checkbox
    const checkbox = screen.getByRole('checkbox');
    fireEvent.click(checkbox);

    // Confirm button should now be enabled
    const confirmBtn = screen.getByTestId('regen-confirm-btn') as HTMLButtonElement;
    expect(confirmBtn.disabled).toBe(false);

    // Click confirm
    fireEvent.click(confirmBtn);

    expect(regenerationRunner).toHaveBeenCalledWith(
      expect.objectContaining({
        birth: expect.objectContaining({
          time: '07:30',
          rectifiedTime: '07:45',
          latitude: 18.5,
          longitude: 73.8,
        }),
        profileId: PROFILE_ID,
      }),
    );
    await waitFor(() => expect(mockNavigate).toHaveBeenCalledWith('/dashboard'));
  });

  it('stays on the page, showing that the chart is computing, until the new chart is applied', async () => {
    let finish: () => void = () => undefined;
    regenerationRunner.mockImplementation(() => new Promise<void>((resolve) => (finish = resolve)));
    const { rerender } = renderRectify();
    fireEvent.click(await screen.findByTestId('intro-start-btn'));
    fireEvent.click(await screen.findByTestId('events-continue-btn'));
    await navigateToResults(rerender);
    fireEvent.click(screen.getByTestId('confirm-candidate-btn'));
    await screen.findByTestId('regen-modal');
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(screen.getByTestId('regen-confirm-btn'));

    await screen.findByTestId('rectify-saving');
    expect(regenerationRunner).toHaveBeenCalledOnce();
    expect(mockNavigate).not.toHaveBeenCalled();

    finish();
    await waitFor(() => expect(mockNavigate).toHaveBeenCalledWith('/dashboard'));
  });

  it('keeps the user on the results with an error when the regeneration fails', async () => {
    regenerationRunner.mockImplementation(() => Promise.reject(new Error('worker died')));
    const { rerender } = renderRectify();
    fireEvent.click(await screen.findByTestId('intro-start-btn'));
    fireEvent.click(await screen.findByTestId('events-continue-btn'));
    await navigateToResults(rerender);
    fireEvent.click(screen.getByTestId('confirm-candidate-btn'));
    await screen.findByTestId('regen-modal');
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(screen.getByTestId('regen-confirm-btn'));

    await screen.findByTestId('rectify-save-error');
    expect(mockNavigate).not.toHaveBeenCalled();
    expect(screen.getByTestId('rectify-results')).toBeTruthy();
  });

  /** Results → confirm the first candidate → ack the flip → confirm the modal. */
  async function confirmFirstCandidate(): Promise<void> {
    const { rerender } = renderRectify();
    fireEvent.click(await screen.findByTestId('intro-start-btn'));
    fireEvent.click(await screen.findByTestId('events-continue-btn'));
    await navigateToResults(rerender);
    fireEvent.click(screen.getByTestId('confirm-candidate-btn'));
    await screen.findByTestId('regen-modal');
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(screen.getByTestId('regen-confirm-btn'));
  }

  it('refuses to regenerate a chart whose stored birthplace has no timezone (no silent UTC)', async () => {
    const noZone = {
      ...MOCK_CHART,
      birth_data: {
        ...MOCK_CHART.birth_data,
        birth_location_details: { ...MOCK_CHART.birth_data.birth_location_details, timezone: '' },
      },
    };
    useChartLibraryStore.setState({ charts: { 'chart-1': noZone as never } });
    await confirmFirstCandidate();

    await screen.findByTestId('rectify-save-error');
    expect(regenerationRunner).not.toHaveBeenCalled();
    expect(mockNavigate).not.toHaveBeenCalled();
  });

  it('logs a fixed code when the regeneration fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    regenerationRunner.mockImplementation(() => Promise.reject(new Error('worker died')));
    await confirmFirstCandidate();

    await screen.findByTestId('rectify-save-error');
    expect(warn).toHaveBeenCalledWith('[almamesh:warn:rectify.apply_failed]');
  });

  it('stays on the results with the error, logs a code, and keeps no record when the chart write fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    chartWrite.next = () => Promise.reject(new Error('opfs write failed'));
    await confirmFirstCandidate();

    await screen.findByTestId('rectify-save-error');
    expect(mockNavigate).not.toHaveBeenCalled();
    // The results (and their Confirm, the retry) stay on screen.
    expect(screen.getByTestId('confirm-candidate-btn')).toBeTruthy();
    expect(warn).toHaveBeenCalledWith('[almamesh:warn:chart.save_failed]');
    // Settings must not say "was X, now Y" while the old chart is in effect.
    expect(useRectificationRecordsStore.getState().getRecord(PROFILE_ID)).toBeNull();
  });

  it('leaves "saving" for the error and Retry when the chart write never settles', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.useFakeTimers({ shouldAdvanceTime: true });
    chartWrite.next = () => new Promise<void>(() => undefined);
    await confirmFirstCandidate();
    await screen.findByTestId('rectify-saving');

    await vi.advanceTimersByTimeAsync(30_000);

    await screen.findByTestId('rectify-save-error');
    expect(screen.queryByTestId('rectify-saving')).toBeNull();
    expect(screen.getByTestId('confirm-candidate-btn')).toBeTruthy();
    expect(mockNavigate).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith('[almamesh:warn:chart.save_timed_out]');
  });

  it('confirm persists a RectificationRecord (chosen sign/time, band, original, event ids)', async () => {
    // Seed the structured life events that inform the fit (synthetic — no PII).
    useLifeEventsStore.setState({
      eventsByProfile: {
        [PROFILE_ID]: [
          { id: 'evt-1', date: '2010-06-01', category: 'career', createdAt: '2024-01-01T00:00:00Z' } as never,
          { id: 'evt-2', date: '2015-01-01', category: 'marriage', createdAt: '2024-01-02T00:00:00Z' } as never,
        ],
      },
    });

    // Existing structured events make the wizard open on the events step.
    const { rerender } = renderRectify();
    fireEvent.click(await screen.findByTestId('events-continue-btn'));
    await navigateToResults(rerender);

    fireEvent.click(screen.getByTestId('confirm-candidate-btn'));
    await screen.findByTestId('regen-modal');
    fireEvent.click(screen.getByRole('checkbox')); // ack the sign flip
    fireEvent.click(screen.getByTestId('regen-confirm-btn'));

    // The record is saved once the new chart is on disk, then the page leaves.
    await waitFor(() => expect(mockNavigate).toHaveBeenCalledWith('/dashboard'));
    const record = useRectificationRecordsStore.getState().getRecord(PROFILE_ID);
    expect(record).toMatchObject({
      profileId: PROFILE_ID,
      mode: 'cusp',
      band: 'leans',
      margin: 0.04,
      originalTime: '07:30',
      originalSign: 'aquarius',
      rectifiedTime: '07:45',
      rectifiedSign: 'pisces',
      supportingEventIds: ['evt-1', 'evt-2'],
    });
    expect(typeof record?.confirmedAt).toBe('string');
  });

  it('keep recorded requests no regeneration and navigates back', async () => {
    const { rerender } = renderRectify();
    fireEvent.click(await screen.findByTestId('intro-start-btn'));
    fireEvent.click(await screen.findByTestId('events-continue-btn'));
    await navigateToResults(rerender);

    fireEvent.click(screen.getByTestId('keep-recorded-btn'));

    expect(regenerationRunner).not.toHaveBeenCalled();
    expect(mockNavigate).toHaveBeenCalledWith('/dashboard');
  });

  it('window mode: whole-day is the pre-selected default when detectedMode is window', async () => {
    vi.mocked(useRectification).mockReturnValue(hookState({ detectedMode: 'window' }));

    renderRectify();
    fireEvent.click(await screen.findByTestId('intro-start-btn'));
    fireEvent.click(await screen.findByTestId('events-continue-btn'));
    // The rough-time profile still answers the honest-window question; its
    // default is the whole-day scan (no invented precision).
    const wholeDayRadio = screen
      .getByTestId('window-option-whole_day')
      .querySelector('input') as HTMLInputElement;
    expect(wholeDayRadio.checked).toBe(true);
    fireEvent.click(screen.getByTestId('window-start-btn'));
    expect(mockRun).toHaveBeenCalledWith('window');
  });

  // ---------------------------------------------------------------------------
  // Unknown birth time — no placeholder comparison, no flip-ack gate
  // ---------------------------------------------------------------------------

  describe('unknown birth time (timeConfidence: unknown)', () => {
    /** Navigate to results with MOCK_CHART_UNKNOWN in the store. */
    async function navigateToResultsUnknown(
      rerender: ReturnType<typeof renderRectify>['rerender'],
    ) {
      vi.mocked(useRectification).mockReturnValue(
        hookState({
          state: { status: 'ready', result: MOCK_RESULT as never, error: null },
          detectedMode: 'window',
        }),
      );
      rerender(
        <MemoryRouter initialEntries={['/rectify/profile-abc']}>
          <Routes>
            <Route path="/rectify/:profileId" element={<RectifyPage />} />
          </Routes>
        </MemoryRouter>,
      );
      await screen.findByTestId('rectify-results');
    }

    beforeEach(() => {
      // Override the chart store with an unknown-time chart
      useChartLibraryStore.setState({ charts: { 'chart-1': MOCK_CHART_UNKNOWN as never } });
    });

    it('passes recordedReading={null} to RectifyResults (no placeholder comparison)', async () => {
      const { rerender } = renderRectify();
      fireEvent.click(await screen.findByTestId('intro-start-btn'));
      fireEvent.click(await screen.findByTestId('events-continue-btn'));
      await navigateToResultsUnknown(rerender);

      // The mock surfaces recordedReading via data-has-recorded attribute
      const resultsEl = screen.getByTestId('rectify-results');
      expect(resultsEl.getAttribute('data-has-recorded')).toBe('false');
    });

    it('confirm candidate does NOT require flip-ack (signFlip is null for unknown time)', async () => {
      const { rerender } = renderRectify();
      fireEvent.click(await screen.findByTestId('intro-start-btn'));
      fireEvent.click(await screen.findByTestId('events-continue-btn'));
      await navigateToResultsUnknown(rerender);

      // Confirm the sign-flip candidate (pisces vs recorded aquarius)
      fireEvent.click(screen.getByTestId('confirm-candidate-btn'));
      await screen.findByTestId('regen-modal');

      // No flip-ack checkbox — signFlip must be null
      expect(screen.queryByTestId('regen-flip-ack')).toBeNull();
      // Confirm button is immediately enabled (no ack required)
      expect((screen.getByTestId('regen-confirm-btn') as HTMLButtonElement).disabled).toBe(false);
    });

    it('confirm with unknown time requests regeneration and navigates', async () => {
      const { rerender } = renderRectify();
      fireEvent.click(await screen.findByTestId('intro-start-btn'));
      fireEvent.click(await screen.findByTestId('events-continue-btn'));
      await navigateToResultsUnknown(rerender);

      fireEvent.click(screen.getByTestId('confirm-candidate-btn'));
      await screen.findByTestId('regen-modal');

      // Confirm fires immediately without needing an ack
      fireEvent.click(screen.getByTestId('regen-confirm-btn'));

      expect(regenerationRunner).toHaveBeenCalledWith(
        expect.objectContaining({
          birth: expect.objectContaining({ rectifiedTime: '07:45' }),
          profileId: PROFILE_ID,
        }),
      );
      await waitFor(() => expect(mockNavigate).toHaveBeenCalledWith('/dashboard'));
    });
  });

  // ---------------------------------------------------------------------------
  // Fit step: honest warming + recoverable dead-ends (the primary defect)
  // ---------------------------------------------------------------------------

  describe('fit step — warming + dead-end recovery', () => {
    /** Click through intro → events → fit (answering the window question when asked). */
    async function gotoFit() {
      renderRectify();
      fireEvent.click(await screen.findByTestId('intro-start-btn'));
      fireEvent.click(await screen.findByTestId('events-continue-btn'));
      // The honest-window question renders only for valid inputs with a
      // recorded time; the guard-path tests (missing birth / no events) skip it.
      const startBtn = screen.queryByTestId('window-start-btn');
      if (startBtn !== null) fireEvent.click(startBtn);
    }

    it('shows the honest warming surface (timer) when the engine is not ready', async () => {
      vi.mocked(useRectification).mockReturnValue(hookState({ engineReady: false }));
      await gotoFit();
      expect(await screen.findByTestId('engine-warming')).toBeTruthy();
      // NOT a bare permanent spinner with no context
      expect(screen.queryByText('Warming up the chart engine')).toBeTruthy();
    });

    it('shows the engine-failed surface with a reset button that calls retry', async () => {
      vi.mocked(useRectification).mockReturnValue(
        hookState({ engineReady: false, engineError: 'Boot failed' }),
      );
      await gotoFit();
      const reset = await screen.findByTestId('engine-reset-btn');
      fireEvent.click(reset);
      expect(mockRetry).toHaveBeenCalledTimes(1);
    });

    it('shows the stalled reset button after a warming timeout, calling retry', async () => {
      vi.mocked(useRectification).mockReturnValue(
        hookState({ engineReady: false, warmingTimedOut: true }),
      );
      await gotoFit();
      const reset = await screen.findByTestId('engine-reset-btn');
      fireEvent.click(reset);
      expect(mockRetry).toHaveBeenCalledTimes(1);
    });

    it('shows an explicit missing-birth message instead of an infinite spinner', async () => {
      vi.mocked(useRectification).mockReturnValue(hookState({ missingBirth: true }));
      await gotoFit();
      expect(await screen.findByText(/couldn't find saved birth details/i)).toBeTruthy();
      // The silent dead-end spinner must NOT be shown
      expect(screen.queryByTestId('fit-progress')).toBeNull();
      expect(screen.queryByTestId('engine-warming')).toBeNull();
    });

    it('shows an explicit no-events message (with a back action) instead of spinning', async () => {
      vi.mocked(useRectification).mockReturnValue(hookState({ hasEnoughEvents: false }));
      await gotoFit();
      expect(await screen.findByText(/at least one dated life event/i)).toBeTruthy();
      expect(screen.queryByTestId('fit-progress')).toBeNull();
    });
  });

  // ---------------------------------------------------------------------------
  // rough birth time — comparison + flip-ack still required (existing behavior)
  // ---------------------------------------------------------------------------

  describe('rough birth time (timeConfidence: rough) — known behavior preserved', () => {
    const MOCK_CHART_ROUGH = {
      ...MOCK_CHART,
      birth_data: {
        ...MOCK_CHART.birth_data,
        birth_time_confidence: 'rough',
      },
    };

    beforeEach(() => {
      useChartLibraryStore.setState({ charts: { 'chart-1': MOCK_CHART_ROUGH as never } });
    });

    it('passes non-null recordedReading (rough time still has a recorded comparison)', async () => {
      const { rerender } = renderRectify();
      fireEvent.click(await screen.findByTestId('intro-start-btn'));
      fireEvent.click(await screen.findByTestId('events-continue-btn'));
      // Rerender in ready/cusp state
      vi.mocked(useRectification).mockReturnValue(
        hookState({ state: { status: 'ready', result: MOCK_RESULT as never, error: null } }),
      );
      rerender(
        <MemoryRouter initialEntries={['/rectify/profile-abc']}>
          <Routes>
            <Route path="/rectify/:profileId" element={<RectifyPage />} />
          </Routes>
        </MemoryRouter>,
      );
      await screen.findByTestId('rectify-results');

      const resultsEl = screen.getByTestId('rectify-results');
      expect(resultsEl.getAttribute('data-has-recorded')).toBe('true');
    });

    it('rough time: flip-ack is required when ascendant sign changes', async () => {
      const { rerender } = renderRectify();
      fireEvent.click(await screen.findByTestId('intro-start-btn'));
      fireEvent.click(await screen.findByTestId('events-continue-btn'));
      vi.mocked(useRectification).mockReturnValue(
        hookState({ state: { status: 'ready', result: MOCK_RESULT as never, error: null } }),
      );
      rerender(
        <MemoryRouter initialEntries={['/rectify/profile-abc']}>
          <Routes>
            <Route path="/rectify/:profileId" element={<RectifyPage />} />
          </Routes>
        </MemoryRouter>,
      );
      await screen.findByTestId('rectify-results');

      fireEvent.click(screen.getByTestId('confirm-candidate-btn'));
      await screen.findByTestId('regen-modal');

      // flip-ack IS shown for rough time (user entered a time, sign differs)
      expect(screen.getByTestId('regen-flip-ack')).toBeTruthy();
      expect((screen.getByTestId('regen-confirm-btn') as HTMLButtonElement).disabled).toBe(true);
    });
  });
});
