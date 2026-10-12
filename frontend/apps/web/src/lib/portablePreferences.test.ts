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
  whenChartHydrated: vi.fn(),
  whenProfilesHydrated: vi.fn(),
  whenChatHydrated: vi.fn(),
  whenInterpretationHydrated: vi.fn(),
  markUnavailable: vi.fn(),
  migrateProfiles: vi.fn(),
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
  whenProfilesHydrated: mocks.whenProfilesHydrated,
  whenChatHydrated: mocks.whenChatHydrated,
  whenInterpretationHydrated: mocks.whenInterpretationHydrated,
  markPortableStateUnavailable: mocks.markUnavailable,
  runProfileMigration: mocks.migrateProfiles,
}));

vi.mock('./modelSuggestion', () => ({
  hydrateSlowModelSuggestion: mocks.hydrateModelSuggestion,
  MODEL_SUGGESTION_DISMISSED_KEY: 'almamesh-model-suggestion-dismissed',
}));

import {
  initializePortablePreferences,
  initializePortableState,
  preparePortableState,
  rehydratePortablePreferences,
} from './portablePreferences';

describe('portable SQLite boot hydration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.languageHasHydrated.mockReturnValue(false);
    mocks.whenChartHydrated.mockResolvedValue({ status: 'hydrated' });
    mocks.whenProfilesHydrated.mockResolvedValue({ status: 'hydrated' });
    mocks.whenChatHydrated.mockResolvedValue({ status: 'hydrated' });
    mocks.whenInterpretationHydrated.mockResolvedValue({ status: 'hydrated' });
    mocks.migrateProfiles.mockResolvedValue(undefined);
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

  it('waits for language, chart, profiles, chat, and interpretation SQLite hydration before boot can render', async () => {
    await initializePortableState();

    expect(mocks.rehydrateLanguage).toHaveBeenCalledOnce();
    expect(mocks.whenChartHydrated).toHaveBeenCalledOnce();
    expect(mocks.whenProfilesHydrated).toHaveBeenCalledOnce();
    expect(mocks.whenChatHydrated).toHaveBeenCalledOnce();
    expect(mocks.whenInterpretationHydrated).toHaveBeenCalledOnce();
    expect(mocks.markUnavailable).not.toHaveBeenCalled();
  });

  it.each(['chart', 'profiles', 'chat'] as const)(
    'blocks startup when %s hydration fails instead of accepting its empty snapshot',
    async (store) => {
      const hydration = {
        chart: mocks.whenChartHydrated,
        profiles: mocks.whenProfilesHydrated,
        chat: mocks.whenChatHydrated,
      }[store];
      hydration.mockResolvedValue({ status: 'failed', error: new Error('private stored value') });

      await expect(initializePortableState()).rejects.toThrow('SQLite-backed state could not be read');
      expect(mocks.markUnavailable).toHaveBeenCalledOnce();
    },
  );

  it('preserves the existing paused-reading behavior for failed interpretation hydration', async () => {
    mocks.whenInterpretationHydrated.mockResolvedValue({ status: 'failed', error: new Error('unreadable reading') });
    await expect(initializePortableState()).resolves.toBeUndefined();
    expect(mocks.markUnavailable).not.toHaveBeenCalled();
  });

  it('blocks startup after a rejected SQLite preference read', async () => {
    mocks.getPreference.mockRejectedValue(new Error('read failed'));

    await expect(initializePortableState()).rejects.toThrow('read failed');
    expect(mocks.markUnavailable).toHaveBeenCalledOnce();
    expect(mocks.whenChartHydrated).not.toHaveBeenCalled();
  });

  it('reports a failed store without waiting for another hydration to finish', async () => {
    mocks.whenChartHydrated.mockResolvedValue({ status: 'failed', error: new Error('read failed') });
    mocks.whenProfilesHydrated.mockReturnValue(new Promise(() => undefined));

    let timer: ReturnType<typeof setTimeout> | undefined;
    const result = await Promise.race([
      initializePortableState().then(() => 'accepted', () => 'failed'),
      new Promise((resolve) => { timer = setTimeout(() => resolve('still waiting'), 50); }),
    ]).finally(() => clearTimeout(timer));
    expect(result).toBe('failed');
    expect(mocks.markUnavailable).toHaveBeenCalledOnce();
  });

  it('never migrates or permits app startup after failed hydration', async () => {
    await expect(preparePortableState(Promise.reject(new Error('read failed')))).resolves.toBe(false);
    expect(mocks.migrateProfiles).not.toHaveBeenCalled();
    expect(mocks.markUnavailable).toHaveBeenCalledOnce();
  });

  it('keeps app startup blocked when profile migration fails', async () => {
    mocks.migrateProfiles.mockRejectedValue(new Error('migration failed'));
    await expect(preparePortableState(Promise.resolve())).resolves.toBe(false);
    expect(mocks.markUnavailable).toHaveBeenCalledOnce();
  });

  it('permits app startup only after successful hydration and profile migration', async () => {
    await expect(preparePortableState(Promise.resolve())).resolves.toBe(true);
    expect(mocks.migrateProfiles).toHaveBeenCalledOnce();
    expect(mocks.markUnavailable).not.toHaveBeenCalled();
  });
});
