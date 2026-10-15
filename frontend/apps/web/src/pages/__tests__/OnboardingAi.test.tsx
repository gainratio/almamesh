import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

import '../../i18n/config';
import {
  configureLlmSettingsPersistence,
  hydrateLlmSettings,
  openRouterPreset,
  RECOMMENDED_CLOUD_MODEL,
  writeLlmSettings,
  type ProviderConfig,
} from '@almamesh/llm';
import { useChartLibraryStore } from '@almamesh/store';
import OnboardingAiPage from '../OnboardingAi';
import { resetSettingsDurabilityForTests } from '../../components/features/ai/aiSettingsDurability';
import { hydrateSlowModelSuggestion } from '../../lib/modelSuggestion';

const STUB_CONFIG: ProviderConfig = {
  engine: 'openai-http',
  model: RECOMMENDED_CLOUD_MODEL,
  privacyMode: 'cloud_premium',
  baseUrl: 'https://openrouter.ai/api/v1',
  apiKey: 'sk-or-xyz',
};

const seams = {
  resolveConfig: () => STUB_CONFIG,
  testConnection: vi.fn().mockResolvedValue(undefined),
  fetchCredits: vi.fn().mockResolvedValue({ totalCredits: 1, totalUsage: 0, remaining: 1 }),
  fetchModels: vi.fn().mockResolvedValue([]),
};

function reset() {
  hydrateLlmSettings(null);
  resetSettingsDurabilityForTests();
  hydrateSlowModelSuggestion(null);
  configureLlmSettingsPersistence(undefined);
}

function renderStep(props: { required?: boolean } = {}) {
  return render(
    <MemoryRouter initialEntries={['/onboarding/ai']}>
      <Routes>
        <Route path="/onboarding/ai" element={<OnboardingAiPage panel={seams} {...props} />} />
        <Route path="/onboarding" element={<div data-testid="onboarding-page" />} />
        <Route path="/dashboard" element={<div data-testid="dashboard-page" />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('Onboarding AI step', () => {
  beforeEach(() => {
    reset();
    useChartLibraryStore.setState({ charts: { 'chart-1': {} as never } });
  });
  afterEach(() => {
    reset();
    useChartLibraryStore.setState({ charts: {} });
  });

  it('shows one line of context, a primary Connect AI button (focused), and a Not now link when no AI is set up', () => {
    renderStep();
    expect(screen.getByRole('heading', { name: 'Your chart is ready' })).toBeTruthy();
    expect(screen.getByTestId('onboarding-ai-body').textContent).toMatch(/connect an ai model/i);
    const connect = screen.getByTestId('onboarding-ai-connect');
    expect(connect.textContent).toBe('Connect AI');
    expect(document.activeElement).toBe(connect);
    expect(screen.getByTestId('onboarding-ai-not-now').textContent).toBe('Not now');
    // The panel stays out of the way until asked for.
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('"Not now" goes to the dashboard', async () => {
    renderStep();
    fireEvent.click(screen.getByTestId('onboarding-ai-not-now'));
    expect(await screen.findByTestId('dashboard-page')).toBeTruthy();
  });

  it('Connect AI opens the shared setup panel; a passing connection lands on the dashboard', async () => {
    renderStep();
    fireEvent.click(screen.getByTestId('onboarding-ai-connect'));
    const dialog = screen.getByRole('dialog', { name: 'Connect AI' });
    expect(dialog.querySelector('[data-testid="tier-cloud"]')).not.toBeNull();

    fireEvent.change(screen.getByTestId('llm-openrouter-key'), { target: { value: 'sk-or-abc' } });
    fireEvent.click(screen.getByTestId('llm-save'));

    expect(await screen.findByTestId('dashboard-page')).toBeTruthy();
  });

  it('with the mandatory flag on, there is no way to skip', () => {
    renderStep({ required: true });
    expect(screen.getByTestId('onboarding-ai-connect')).toBeTruthy();
    expect(screen.queryByTestId('onboarding-ai-not-now')).toBeNull();
  });

  it('is skipped entirely when AI is already set up', () => {
    writeLlmSettings(openRouterPreset('sk-or-v1-0000-synthetic-test-key', RECOMMENDED_CLOUD_MODEL));
    renderStep();
    expect(screen.getByTestId('dashboard-page')).toBeTruthy();
    expect(screen.queryByTestId('onboarding-ai-connect')).toBeNull();
  });

  it('sends someone with no chart back to onboarding', () => {
    useChartLibraryStore.setState({ charts: {} });
    renderStep();
    expect(screen.getByTestId('onboarding-page')).toBeTruthy();
  });
});
