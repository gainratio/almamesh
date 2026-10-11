import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';

import '../../../i18n/config';
import { configureLlmSettingsPersistence, hydrateLlmSettings } from '@almamesh/llm';
import AiSettings from '../AiSettings';

describe('AiSettings — Settings → AI renders the shared AI setup panel', () => {
  beforeEach(() => {
    hydrateLlmSettings(null);
    configureLlmSettingsPersistence(undefined);
  });
  afterEach(() => {
    hydrateLlmSettings(null);
    configureLlmSettingsPersistence(undefined);
  });

  it('renders the panel inside the AI Model card, with the AI-off choice and no intro', () => {
    render(<AiSettings />);
    expect(screen.getByRole('heading', { name: 'AI Model' })).toBeTruthy();
    const card = screen.getByTestId('ai-model-settings');
    expect(card.querySelector('[data-testid="tier-none"]')).not.toBeNull();
    expect(card.querySelector('[data-testid="tier-cloud"]')).not.toBeNull();
    expect(card.querySelector('[data-testid="tier-cloud-honesty"]')).not.toBeNull();
    expect(screen.queryByTestId('ai-setup-intro')).toBeNull();
  });
});
