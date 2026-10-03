import { beforeEach, describe, expect, it, vi } from 'vitest';

const { setPortablePreference } = vi.hoisted(() => ({
  setPortablePreference: vi.fn(() => Promise.resolve()),
}));

vi.mock('@almamesh/store', () => ({
  portablePreferenceStorage: { setItem: setPortablePreference },
}));

import {
  dismissSlowModelSuggestion,
  hydrateSlowModelSuggestion,
  isSlowModelSuggestionDismissed,
  MODEL_SUGGESTION_DISMISSED_KEY,
} from './modelSuggestion';

describe('model suggestion dismissal persistence', () => {
  beforeEach(() => {
    window.localStorage.clear();
    hydrateSlowModelSuggestion(null);
    setPortablePreference.mockClear();
  });

  it('updates the in-memory snapshot and queues the canonical SQLite preference', () => {
    dismissSlowModelSuggestion();

    expect(isSlowModelSuggestionDismissed()).toBe(true);
    expect(window.localStorage.getItem(MODEL_SUGGESTION_DISMISSED_KEY)).toBeNull();
    expect(setPortablePreference).toHaveBeenCalledWith(
      MODEL_SUGGESTION_DISMISSED_KEY,
      'z-ai/glm-5.3-flash',
    );
  });

  it('hydrates the synchronous snapshot only from the canonical value', () => {
    window.localStorage.setItem(MODEL_SUGGESTION_DISMISSED_KEY, 'z-ai/glm-5.3-flash');

    hydrateSlowModelSuggestion(null);
    expect(isSlowModelSuggestionDismissed()).toBe(false);

    hydrateSlowModelSuggestion('z-ai/glm-5.3-flash');
    expect(isSlowModelSuggestionDismissed()).toBe(true);
  });
});
