/** Device settings that travel inside the encrypted bundle. Synthetic fixtures. */
import { describe, expect, it } from 'vitest';
import { LLM_SETTINGS_KEY } from '@almamesh/llm';
import {
  applyPortableSettings,
  collectPortableSettings,
  filterPortableSettings,
  PORTABLE_SETTINGS_KEYS,
} from './portableSettings';

function memoryStorage(seed: Record<string, string> = {}) {
  const map = new Map(Object.entries(seed));
  return {
    map,
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => void map.set(key, value),
    removeItem: (key: string) => void map.delete(key),
  };
}

const LLM = JSON.stringify({ apiBase: 'https://openrouter.ai/api/v1', apiKey: 'sk-synthetic' });

describe('portable settings', () => {
  it('carries the AI provider settings, including the API key', () => {
    expect(PORTABLE_SETTINGS_KEYS).toEqual(['almamesh-llm-settings']);
    expect(PORTABLE_SETTINGS_KEYS).toContain(LLM_SETTINGS_KEY);
    const storage = memoryStorage({ 'almamesh-llm-settings': LLM, 'almamesh-chart': '1' });

    expect(collectPortableSettings(storage)).toEqual({ 'almamesh-llm-settings': LLM });
  });

  it('collects nothing when no settings were saved', () => {
    expect(collectPortableSettings(memoryStorage())).toEqual({});
  });

  it('replaces settings: writes carried keys and removes absent ones', () => {
    const target = memoryStorage({ 'almamesh-llm-settings': 'old', 'almamesh-chart': '1' });

    applyPortableSettings(target, {});
    expect(target.map.has('almamesh-llm-settings')).toBe(false);
    expect(target.map.get('almamesh-chart')).toBe('1');

    applyPortableSettings(target, { 'almamesh-llm-settings': LLM, other: 'ignored' });
    expect(target.map.get('almamesh-llm-settings')).toBe(LLM);
    expect(target.map.has('other')).toBe(false);
  });

  it('treats a non-object or non-string settings section as empty', () => {
    expect(filterPortableSettings(null)).toEqual({});
    expect(filterPortableSettings(['x'])).toEqual({});
    expect(filterPortableSettings({ 'almamesh-llm-settings': 42 })).toEqual({});
  });
});
