import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

import { EngineOperationError, type ChartEngine } from '@almamesh/browser';
import '../../i18n/config';
import { registerRegenerationRunner, useOnboardingStore } from '@almamesh/store';

// --- module mocks (declared before importing the page) ---
const navigateSpy = vi.fn();
vi.mock('react-router-dom', async (orig) => {
  const actual = await orig<typeof import('react-router-dom')>();
  return { ...actual, useNavigate: () => navigateSpy };
});

const resetAppDataSpy = vi.fn().mockResolvedValue(undefined);
vi.mock('../../lib/resetAppData', () => ({
  resetAppData: () => resetAppDataSpy(),
}));

// Controllable chart-engine context value.
type EngineValue = {
  engine: ChartEngine | null;
  error: Error | null;
  stage: null;
  meta: null;
  reboot: () => Promise<ChartEngine>;
  whenReady: () => Promise<ChartEngine>;
  startBootstrap: () => void;
};
let engineValue: EngineValue;
vi.mock('../../providers/AlmaMeshRuntimeProvider', () => ({
  useChartEngine: () => engineValue,
}));

import OnboardingPage from '../Onboarding';

const fakeEngine = { generateChart: vi.fn() } as unknown as ChartEngine;

/** Seed the onboarding store at the generating step with valid birth data. */
function seedReadyToGenerate(): void {
  useOnboardingStore.setState({
    currentStep: 5,
    data: {
      name: 'Asha',
      birthDate: new Date('1990-01-15T00:00:00'),
      birthTime: '12:00',
      timeConfidence: 'exact',
      city: 'Pune',
      state: '',
      country: 'India',
      latitude: 18.52,
      longitude: 73.85,
      timezone: 'Asia/Kolkata',
      interests: [],
      needsRectification: false,
    },
    isLoading: false,
    error: null,
    isSaving: false,
    lastSavedStep: 0,
  });
}

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/onboarding']}>
      <OnboardingPage />
    </MemoryRouter>,
  );
}

describe('Onboarding — in-app bootstrap recovery', () => {
  // Stands in for App.tsx's regeneration subscriber: the page now waits for
  // the chart to be applied before it navigates.
  let unregisterRunner: () => void = () => undefined;
  beforeEach(() => {
    navigateSpy.mockClear();
    resetAppDataSpy.mockClear();
    useOnboardingStore.getState().reset();
    unregisterRunner = registerRegenerationRunner(() => Promise.resolve());
  });

  afterEach(() => {
    unregisterRunner();
    useOnboardingStore.getState().reset();
  });

  it('on a failed bootstrap, Generate reboots (re-syncs) and lands on the dashboard', async () => {
    const reboot = vi.fn().mockResolvedValue(fakeEngine);
    const whenReady = vi.fn();
    engineValue = {
      engine: null,
      error: new Error('bundle chunk 404'),
      stage: null,
      meta: null,
      reboot,
      whenReady,
      startBootstrap: vi.fn(),
    };
    seedReadyToGenerate();

    renderPage();
    // Drive the last step's "analyze & continue" which triggers generation.
    fireEvent.click(screen.getByTestId('life-events-input'));
    // Skip life events to reach generation directly.
    fireEvent.click(screen.getByTestId('skip-life-events-button'));

    await waitFor(() => expect(reboot).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(navigateSpy).toHaveBeenCalledWith('/dashboard'));
    expect(whenReady).not.toHaveBeenCalled();
  });

  it('during the warming race (no engine, no error), Generate awaits readiness then navigates', async () => {
    const reboot = vi.fn();
    const whenReady = vi.fn().mockResolvedValue(fakeEngine);
    engineValue = {
      engine: null,
      error: null,
      stage: null,
      meta: null,
      reboot,
      whenReady,
      startBootstrap: vi.fn(),
    };
    seedReadyToGenerate();

    renderPage();
    fireEvent.click(screen.getByTestId('skip-life-events-button'));

    await waitFor(() => expect(whenReady).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(navigateSpy).toHaveBeenCalledWith('/dashboard'));
    expect(reboot).not.toHaveBeenCalled();
  });

  it('shows a Reset & reload escape hatch on the error card and wires it to resetAppData', async () => {
    // whenReady that never resolves -> generation surfaces an engine-warming
    // error -> the error card renders with recovery actions.
    const reboot = vi.fn().mockRejectedValue(new Error('still broken'));
    const whenReady = vi.fn().mockRejectedValue(new Error('still broken'));
    engineValue = {
      engine: null,
      error: new Error('bundle chunk 404'),
      stage: null,
      meta: null,
      reboot,
      whenReady,
      startBootstrap: vi.fn(),
    };
    seedReadyToGenerate();

    renderPage();
    await act(async () => {
      fireEvent.click(screen.getByTestId('skip-life-events-button'));
    });

    // The error card appears with all three recovery actions.
    const resetButton = await screen.findByTestId('reset-app-data-button');
    expect(resetButton).toBeTruthy();
    expect(screen.getByTestId('retry-generation-button')).toBeTruthy();
    expect(screen.getByTestId('go-to-dashboard-button')).toBeTruthy();
    // Not a rollback refusal: no tampering warning, no extra confirm step.
    expect(screen.queryByTestId('rollback-warning')).toBeNull();

    fireEvent.click(resetButton);
    await waitFor(() => expect(resetAppDataSpy).toHaveBeenCalledTimes(1));
  });

  it('does not reload when Reset could not delete the data, and says why', async () => {
    const reload = vi.fn();
    vi.stubGlobal('location', { ...window.location, reload });
    resetAppDataSpy.mockRejectedValueOnce(
      Object.assign(new Error('Reset could not delete: keyval-store'), { name: 'ResetIncompleteError' }),
    );
    engineValue = {
      engine: null,
      error: new Error('bundle chunk 404'),
      stage: null,
      meta: null,
      reboot: vi.fn().mockRejectedValue(new Error('still broken')),
      whenReady: vi.fn().mockRejectedValue(new Error('still broken')),
      startBootstrap: vi.fn(),
    };
    seedReadyToGenerate();
    renderPage();
    await act(async () => {
      fireEvent.click(screen.getByTestId('skip-life-events-button'));
    });

    fireEvent.click(await screen.findByTestId('reset-app-data-button'));

    const alert = await screen.findByTestId('reset-incomplete');
    expect(alert.getAttribute('role')).toBe('alert');
    expect(alert.textContent).toContain('Close every AlmaMesh tab');
    expect(reload).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it('a RollbackError boot lands on the recovery card, warns, and clears only after a two-step confirm', async () => {
    // @gainratio/browser surfaces a durable-floor refusal as an EngineOperationError
    // with code 'rollback'. Recovery must stay a deliberate click: auto-wiping the
    // bundle cache (and with it the rollback floor) would defeat rollback protection.
    const rollback = new EngineOperationError({
      code: 'rollback',
      message: 'refusing rollback: pointer sequence 1 is below the durable floor 1700000000',
    });
    const reboot = vi.fn().mockRejectedValue(rollback);
    engineValue = {
      engine: null,
      error: rollback,
      stage: null,
      meta: null,
      reboot,
      whenReady: vi.fn().mockRejectedValue(rollback),
      startBootstrap: vi.fn(),
    };
    seedReadyToGenerate();

    renderPage();
    await act(async () => {
      fireEvent.click(screen.getByTestId('skip-life-events-button'));
    });

    const resetButton = await screen.findByTestId('reset-app-data-button');
    expect(screen.getByTestId('retry-generation-button')).toBeTruthy();
    expect(resetAppDataSpy).not.toHaveBeenCalled();
    expect(navigateSpy).not.toHaveBeenCalled();
    // The error code (not the message) drives a plain-language tampering warning.
    expect(screen.getByTestId('rollback-warning').textContent).toMatch(/older version of the engine/);

    // Dropping the rollback floor needs a deliberate two-step confirm.
    fireEvent.click(resetButton);
    expect(resetAppDataSpy).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId('rollback-reset-cancel'));
    expect(resetAppDataSpy).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId('reset-app-data-button'));
    fireEvent.click(screen.getByTestId('rollback-reset-confirm'));
    await waitFor(() => expect(resetAppDataSpy).toHaveBeenCalledTimes(1));
  });

  it('renders the failure message exactly ONCE on the recovery card (no duplicate strip)', async () => {
    // Boot failure -> the recovery card carries the CHART_GEN_001 message in
    // its body. The page's shared bottom error strip must NOT repeat it.
    const reboot = vi.fn().mockRejectedValue(new Error('still broken'));
    const whenReady = vi.fn().mockRejectedValue(new Error('still broken'));
    engineValue = {
      engine: null,
      error: new Error('bundle chunk 404'),
      stage: null,
      meta: null,
      reboot,
      whenReady,
      startBootstrap: vi.fn(),
    };
    seedReadyToGenerate();

    renderPage();
    await act(async () => {
      fireEvent.click(screen.getByTestId('skip-life-events-button'));
    });

    await screen.findByTestId('retry-generation-button');
    expect(screen.getAllByText(/CHART_GEN_001/)).toHaveLength(1);
  });
});
