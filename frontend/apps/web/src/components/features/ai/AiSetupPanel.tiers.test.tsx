/**
 * AiSetupPanel — the tier structure (Spec 063 D3).
 *
 * Asserts: the None + Cloud tiers render; None is the ACTIVE default; the cloud
 * tier carries the honest "redacted chart data leaves your device" one-liner;
 * and "Turn AI off" returns a configured cloud tier to the None default.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

import '../../../i18n/config';
import {
  configureLlmSettingsPersistence,
  hydrateLlmSettings,
  readLlmSettings,
} from '@almamesh/llm';
import { AiSetupPanel } from './AiSetupPanel';

function readSaved(): Record<string, unknown> {
  return { ...readLlmSettings() };
}

// Stub the balance + model-catalog reads so a pre-seeded OpenRouter tier can't
// hit the real network when the auto-fetches fire on mount.
const fetchCredits = vi.fn().mockResolvedValue({ totalCredits: 5, totalUsage: 1, remaining: 4 });
const fetchModels = vi.fn().mockResolvedValue([]);

function renderTiers() {
  return render(<AiSetupPanel fetchCredits={fetchCredits} fetchModels={fetchModels} />);
}

describe('AiSetupPanel — tiers', () => {
  beforeEach(() => {
    hydrateLlmSettings(null);
    configureLlmSettingsPersistence(undefined);
    fetchCredits.mockClear();
    fetchModels.mockClear();
  });
  afterEach(() => {
    hydrateLlmSettings(null);
    configureLlmSettingsPersistence(undefined);
  });

  it('renders the None + Cloud tiers', () => {
    renderTiers();
    expect(screen.getByTestId('tier-none')).toBeTruthy();
    expect(screen.getByTestId('tier-cloud')).toBeTruthy();
  });

  it('None is the active DEFAULT with nothing configured', () => {
    renderTiers();
    expect(screen.getByTestId('tier-none-active')).toBeTruthy();
    expect(screen.queryByTestId('tier-cloud-active')).toBeNull();
    expect(screen.queryByTestId('tier-none-select')).toBeNull();
    // Said plainly, as a feature.
    expect(screen.getByTestId('tier-none').textContent).toContain('pure calculation');
  });

  it('the cloud tier is labeled honestly: OpenRouter/BYO, redacted data leaves', () => {
    renderTiers();
    const honesty = screen.getByTestId('tier-cloud-honesty');
    expect(honesty.textContent).toMatch(/OpenRouter/);
    expect(honesty.textContent).toMatch(/leaves your device/);
  });

  it('"Turn AI off" returns a configured cloud tier to the None default', async () => {
    hydrateLlmSettings(
      JSON.stringify({
        apiBase: 'https://openrouter.ai/api/v1',
        apiKey: 'sk-or-xyz',
        model: 'test-org/test-model',
        privacyMode: 'cloud_premium',
      }),
    );
    renderTiers();
    // Cloud active → the None tier offers the off switch.
    expect(screen.getByTestId('tier-cloud-active')).toBeTruthy();
    fireEvent.click(screen.getByTestId('tier-none-select'));

    await waitFor(() => expect(screen.getByTestId('tier-none-active')).toBeTruthy());
    expect(screen.queryByTestId('tier-cloud-active')).toBeNull();
    const saved = readSaved();
    expect(saved.engine).toBe('');
    expect(saved.apiBase).toBe('');
    // Security: disconnecting re-arms the fail-closed privacy fence (a persisted
    // cloud_premium would otherwise stay and keep ensurePrivacy inert), and drops
    // the key so nothing lingers in storage.
    expect(saved.privacyMode).toBe('local_only');
    expect(saved.apiKey).toBe('');
  });
});
