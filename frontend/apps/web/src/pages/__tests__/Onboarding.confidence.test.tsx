import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

import type { ChartEngine } from '@almamesh/browser';
import { timeConfidenceMargin } from '@almamesh/constants';
import {
  registerRegenerationRunner,
  useLifeEventsStore,
  useOnboardingStore,
  useProfilesStore,
  type BirthInfoChanged,
} from '@almamesh/store';
import '../../i18n/config';

// --- module mocks (declared before importing the page) ---
const navigateSpy = vi.fn();
const structureLifeEventsSpy = vi.hoisted(() => vi.fn());
const structurerAvailability = vi.hoisted(() => ({ enabled: true }));
vi.mock('react-router-dom', async (orig) => {
  const actual = await orig<typeof import('react-router-dom')>();
  return { ...actual, useNavigate: () => navigateSpy };
});

vi.mock('../../lib/resetAppData', () => ({
  resetAppData: () => Promise.resolve(),
}));

vi.mock('@almamesh/llm', async (orig) => {
  const actual = await orig<typeof import('@almamesh/llm')>();
  return { ...actual, structureLifeEvents: structureLifeEventsSpy };
});

vi.mock('../../components/features/rectify/rectifyLlmConfig', () => ({
  isAiUsable: () => structurerAvailability.enabled,
  resolveConfig: () => ({
    engine: 'openai-http',
    endpoint: 'https://example.invalid/v1',
    apiKey: 'synthetic-test-key',
    model: 'synthetic/test-model',
    privacyMode: 'pii_redacted',
  }),
  toPromptLanguage: () => 'en',
}));

const fakeEngine = { generateChart: vi.fn() } as unknown as ChartEngine;
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

function readyEngine(): void {
  engineValue = {
    engine: fakeEngine,
    error: null,
    stage: null,
    meta: null,
    reboot: vi.fn().mockResolvedValue(fakeEngine),
    whenReady: vi.fn().mockResolvedValue(fakeEngine),
    startBootstrap: vi.fn(),
  };
}

function seedAt(step: number, partial: Partial<ReturnType<typeof useOnboardingStore.getState>['data']> = {}): void {
  useOnboardingStore.setState({
    currentStep: step,
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
      ...partial,
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

// Stands in for App.tsx's regeneration subscriber: the page now waits for the
// chart to be applied before it navigates.
const regenerationRunner = vi.fn((_event: BirthInfoChanged) => Promise.resolve());
let unregisterRunner: () => void = () => undefined;

beforeEach(() => {
  regenerationRunner.mockClear();
  unregisterRunner = registerRegenerationRunner(regenerationRunner);
  navigateSpy.mockClear();
  readyEngine();
  useOnboardingStore.getState().reset();
  useProfilesStore.setState({ profiles: {}, activeProfileId: null });
  useLifeEventsStore.setState({ eventsByProfile: {} });
  structurerAvailability.enabled = true;
  structureLifeEventsSpy.mockReset();
  structureLifeEventsSpy.mockResolvedValue({
    status: 'ok',
    events: [
      { date: '2015-01-01', category: 'marriage', precision: 'year', summary: 'Got married' },
      { date: '2020-01-01', category: 'career_change', precision: 'year', summary: 'Changed careers' },
    ],
  });
});

afterEach(() => {
  unregisterRunner();
  useOnboardingStore.getState().reset();
});

describe('timeConfidenceMargin helper (TIME_CONFIDENCE.margin consumer path)', () => {
  it('exposes the margin for each confidence key', () => {
    expect(timeConfidenceMargin('exact')).toBe(0);
    expect(timeConfidenceMargin('approximate')).toBe(15);
    expect(timeConfidenceMargin('rough')).toBe(60);
    expect(timeConfidenceMargin('unknown')).toBeNull();
  });
});

describe('Onboarding — birth-time confidence selector', () => {
  it('persists the selected confidence onto the onboarding (profile) birth details', () => {
    seedAt(4);
    renderPage();

    fireEvent.click(screen.getByTestId('confidence-option-approximate'));
    expect(useOnboardingStore.getState().data.timeConfidence).toBe('approximate');
    expect(useOnboardingStore.getState().data.needsRectification).toBe(false);

    fireEvent.click(screen.getByTestId('confidence-option-unknown'));
    expect(useOnboardingStore.getState().data.timeConfidence).toBe('unknown');
    expect(useOnboardingStore.getState().data.needsRectification).toBe(true);
  });

  it('carries the chosen confidence into the requested birth metadata at generation', async () => {
    seedAt(5, { timeConfidence: 'approximate' });
    renderPage();

    fireEvent.click(screen.getByTestId('skip-life-events-button'));

    await waitFor(() => expect(navigateSpy).toHaveBeenCalledWith('/dashboard'));
    expect(regenerationRunner).toHaveBeenCalledOnce();
    expect(regenerationRunner.mock.calls[0]?.[0].birth.timeConfidence).toBe('approximate');
  });
});

describe('Onboarding — honest life-events copy', () => {
  it('does not claim analysis that does not happen', () => {
    seedAt(5);
    renderPage();

    // No element in the life-events step claims to "analyze" the narrative.
    expect(screen.queryByText(/analyz/i)).toBeNull();
    // The CTA is still reachable (a real button, just honestly labeled).
    expect(screen.getByTestId('extract-events-button')).toBeTruthy();
  });

  it('discloses the configured-AI narrative egress before Save is pressed', () => {
    seedAt(5);
    renderPage();

    expect(screen.getByText(/connected AI provider/i)).toBeTruthy();
  });

  it('bounds the narrative sent to a provider or deterministic parser', () => {
    seedAt(5);
    renderPage();

    expect((screen.getByTestId('life-events-input') as HTMLTextAreaElement).maxLength).toBe(5000);
  });
});

describe('Onboarding — life events persist per profile', () => {
  it('uses configured AI to persist one typed row per event', async () => {
    seedAt(5);
    renderPage();

    fireEvent.change(screen.getByTestId('life-events-input'), {
      target: { value: 'I got married in 2015 and changed careers in 2020.' },
    });
    fireEvent.click(screen.getByTestId('extract-events-button'));

    await waitFor(() => expect(navigateSpy).toHaveBeenCalledWith('/dashboard'), { timeout: 6000 });

    const profileId = useProfilesStore.getState().activeProfileId;
    expect(profileId).toBeTruthy();
    const events = useLifeEventsStore.getState().getEvents(profileId as string);
    expect(structureLifeEventsSpy).toHaveBeenCalledOnce();
    expect(events).toHaveLength(2);
    expect(events.map((event) => event.category)).toEqual(['marriage', 'career_change']);
    expect(events.map((event) => event.date)).toEqual(['2015-01-01', '2020-01-01']);
    expect(events.every((event) => event.needsStructuring !== true)).toBe(true);
  }, 8000);

  it('deterministically separates dated events when AI is unavailable', async () => {
    structurerAvailability.enabled = false;
    seedAt(5);
    renderPage();

    fireEvent.change(screen.getByTestId('life-events-input'), {
      target: { value: 'I got married in 2015. I changed careers in 2020.' },
    });
    fireEvent.click(screen.getByTestId('extract-events-button'));

    await waitFor(() => expect(navigateSpy).toHaveBeenCalledWith('/dashboard'), { timeout: 6000 });

    expect(structureLifeEventsSpy).not.toHaveBeenCalled();
    const profileId = useProfilesStore.getState().activeProfileId;
    const events = useLifeEventsStore.getState().getEvents(profileId as string);
    expect(events).toHaveLength(2);
    expect(events.map((event) => event.category)).toEqual(['marriage', 'career_change']);
    expect(events.map((event) => event.precision)).toEqual(['year', 'year']);
  }, 8000);
});
