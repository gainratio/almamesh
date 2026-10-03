/** Device settings that travel inside the encrypted bundle. Synthetic fixtures. */
import { describe, expect, it } from 'vitest';
import { LLM_SETTINGS_KEY } from '@almamesh/llm';
import {
  filterPortableSettings,
  PORTABLE_SETTINGS_KEYS,
} from './portableSettings';

const LLM = JSON.stringify({ apiBase: 'https://openrouter.ai/api/v1', apiKey: 'sk-synthetic' });

describe('portable settings', () => {
  it('accepts only the legacy-v2 AI settings key', () => {
    expect(PORTABLE_SETTINGS_KEYS).toEqual(['almamesh-llm-settings']);
    expect(PORTABLE_SETTINGS_KEYS).toContain(LLM_SETTINGS_KEY);
    expect(filterPortableSettings({ 'almamesh-llm-settings': LLM, other: 'ignored' })).toEqual({
      'almamesh-llm-settings': LLM,
    });
  });

  it('treats a non-object or non-string settings section as empty', () => {
    expect(filterPortableSettings(null)).toEqual({});
    expect(filterPortableSettings(['x'])).toEqual({});
    expect(filterPortableSettings({ 'almamesh-llm-settings': 42 })).toEqual({});
  });
});
