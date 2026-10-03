import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  configure: vi.fn(),
  getPreference: vi.fn(),
  setPreference: vi.fn().mockResolvedValue(undefined),
  hydrateLlm: vi.fn(),
  hydrateContentMode: vi.fn().mockResolvedValue(undefined),
  hydrateModelSuggestion: vi.fn(),
  rehydrateLanguage: vi.fn().mockResolvedValue(undefined),
  languageHasHydrated: vi.fn(() => false),
  whenChartHydrated: vi.fn().mockResolvedValue(undefined),
  whenInterpretationHydrated: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@almamesh/llm', () => ({
  configureLlmSettingsPersistence: mocks.configure,
  hydrateLlmSettings: mocks.hydrateLlm,
  LLM_SETTINGS_KEY: 'almamesh-llm-settings',
}));

vi.mock('@almamesh/store', () => ({
  hydrateContentModePreference: mocks.hydrateContentMode,
  portablePreferenceStorage: {
    getItem: mocks.getPreference,
    setItem: mocks.setPreference,
  },
  useLanguageStore: {
    persist: {
      hasHydrated: mocks.languageHasHydrated,
      rehydrate: mocks.rehydrateLanguage,
    },
  },
  whenChartLibraryHydrated: mocks.whenChartHydrated,
  whenInterpretationHydrated: mocks.whenInterpretationHydrated,
}));

vi.mock('./modelSuggestion', () => ({
  hydrateSlowModelSuggestion: mocks.hydrateModelSuggestion,
  MODEL_SUGGESTION_DISMISSED_KEY: 'almamesh-model-suggestion-dismissed',
}));

import {
  initializePortablePreferences,
  initializePortableState,
  rehydratePortablePreferences,
} from './portablePreferences';

describe('portable SQLite boot hydration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.languageHasHydrated.mockReturnValue(false);
    mocks.getPreference.mockImplementation(async (key: string) => {
      if (key === 'almamesh-llm-settings') return '{"apiKey":"secret"}';
      if (key === 'almamesh-model-suggestion-dismissed') return 'z-ai/glm-5.3-flash';
      return null;
    });
  });

  it('hydrates every synchronous preference consumer from canonical SQLite', async () => {
    await rehydratePortablePreferences();

    expect(mocks.hydrateLlm).toHaveBeenCalledWith('{"apiKey":"secret"}');
    expect(mocks.hydrateContentMode).toHaveBeenCalledOnce();
    expect(mocks.hydrateModelSuggestion).toHaveBeenCalledWith('z-ai/glm-5.3-flash');
  });

  it('configures LLM writes to persist only through portable SQLite', async () => {
    await initializePortablePreferences();

    const writer = mocks.configure.mock.calls[0]?.[0] as
      | ((serialized: string) => Promise<void>)
      | undefined;
    expect(writer).toBeTypeOf('function');
    await writer?.('{"apiKey":"replacement"}');
    expect(mocks.setPreference).toHaveBeenCalledWith(
      'almamesh-llm-settings',
      '{"apiKey":"replacement"}',
    );
  });

  it('waits for language, chart, and interpretation SQLite hydration before boot can render', async () => {
    await initializePortableState();

    expect(mocks.rehydrateLanguage).toHaveBeenCalledOnce();
    expect(mocks.whenChartHydrated).toHaveBeenCalledOnce();
    expect(mocks.whenInterpretationHydrated).toHaveBeenCalledOnce();
  });
});
