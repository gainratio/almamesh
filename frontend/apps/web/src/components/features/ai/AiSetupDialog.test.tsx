import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

import '../../../i18n/config';
import {
  configureLlmSettingsPersistence,
  hydrateLlmSettings,
  RECOMMENDED_CLOUD_MODEL,
  type ProviderConfig,
} from '@almamesh/llm';
import { ConnectAiButton } from './AiSetupDialog';
import { resetSettingsDurabilityForTests } from './aiSettingsDurability';
import { hydrateSlowModelSuggestion } from '../../../lib/modelSuggestion';

const STUB_CONFIG: ProviderConfig = {
  engine: 'openai-http',
  model: RECOMMENDED_CLOUD_MODEL,
  privacyMode: 'cloud_premium',
  baseUrl: 'https://openrouter.ai/api/v1',
  apiKey: 'sk-or-xyz',
};

function seams(testConnection = vi.fn().mockResolvedValue(undefined)) {
  return {
    resolveConfig: () => STUB_CONFIG,
    testConnection,
    fetchCredits: vi.fn().mockResolvedValue({ totalCredits: 1, totalUsage: 0, remaining: 1 }),
    fetchModels: vi.fn().mockResolvedValue([]),
  };
}

function reset() {
  hydrateLlmSettings(null);
  resetSettingsDurabilityForTests();
  hydrateSlowModelSuggestion(null);
  configureLlmSettingsPersistence(undefined);
}

describe('ConnectAiButton — opens the shared AI setup panel in place', () => {
  beforeEach(reset);
  afterEach(reset);

  it('is a button, and opens a dialog with the same panel Settings uses (no "AI off" choice)', () => {
    render(<ConnectAiButton label="Connect AI" testId="cta" panel={seams()} />);
    expect(screen.queryByRole('dialog')).toBeNull();

    fireEvent.click(screen.getByTestId('cta'));

    const dialog = screen.getByRole('dialog', { name: 'Connect AI' });
    expect(dialog.querySelector('[data-testid="tier-cloud"]')).not.toBeNull();
    expect(dialog.querySelector('[data-testid="llm-openrouter-key"]')).not.toBeNull();
    expect(dialog.querySelector('[data-testid="tier-none"]')).toBeNull();
  });

  it('says "Connect AI" once: the dialog title, not a second card title under it', () => {
    render(<ConnectAiButton label="Open" testId="cta" panel={seams()} />);
    fireEvent.click(screen.getByTestId('cta'));
    const dialog = screen.getByRole('dialog', { name: 'Connect AI' });
    expect(dialog.textContent?.match(/Connect AI/g)).toHaveLength(1);
  });

  it('moves keyboard focus into the dialog when it opens, and back to the button on Escape', async () => {
    render(<ConnectAiButton label="Connect AI" testId="cta" panel={seams()} />);
    const button = screen.getByTestId('cta');
    button.focus();
    fireEvent.click(button);

    const dialog = screen.getByRole('dialog');
    await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true));

    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(document.activeElement).toBe(button);
  });

  it('closes itself once the key is saved and the connection test passes', async () => {
    const onConnected = vi.fn();
    render(<ConnectAiButton label="Connect AI" testId="cta" panel={seams()} onConnected={onConnected} />);
    fireEvent.click(screen.getByTestId('cta'));

    fireEvent.change(screen.getByTestId('llm-openrouter-key'), { target: { value: 'sk-or-abc' } });
    fireEvent.click(screen.getByTestId('llm-save'));

    await waitFor(() => expect(onConnected).toHaveBeenCalledOnce());
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('stays open on a failed connection test, so the reason is readable', async () => {
    const failing = vi.fn().mockRejectedValue(Object.assign(new Error('bad key'), { name: 'LlmRequestError', status: 401 }));
    render(<ConnectAiButton label="Connect AI" testId="cta" panel={seams(failing)} />);
    fireEvent.click(screen.getByTestId('cta'));

    fireEvent.change(screen.getByTestId('llm-openrouter-key'), { target: { value: 'sk-or-bad' } });
    fireEvent.click(screen.getByTestId('llm-save'));

    await waitFor(() => expect(failing).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 0));
    expect(screen.getByRole('dialog')).toBeTruthy();
  });
});
