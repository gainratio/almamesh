/**
 * isAiUsable — the rectification-interview AI gate.
 *
 * Matrix: the interview is actionable on every configured provider, including
 * private local endpoints, and stays gated only when no usable provider exists.
 *
 * These tests drive the REAL settings pipeline (boot-hydrated SQLite value →
 * readLlmSettings → describeLlmStatus) — no mocks — so the matrix proves the
 * production wiring, not a stub.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { hydrateLlmSettings, OPENROUTER_API_BASE } from '@almamesh/llm';

import { isAiUsable } from './rectifyLlmConfig';

function seedSettings(blob: Record<string, unknown>): void {
  hydrateLlmSettings(JSON.stringify(blob));
}

describe('isAiUsable — provider gate matrix', () => {
  beforeEach(() => hydrateLlmSettings(null));
  afterEach(() => hydrateLlmSettings(null));

  it('none (no settings saved) → gated', () => {
    expect(isAiUsable()).toBe(false);
  });

  it('BYO local endpoint (Ollama) → usable without cloud egress', () => {
    seedSettings({ apiBase: 'http://localhost:11434/v1', model: 'llama3' });
    expect(isAiUsable()).toBe(true);
  });

  it('OpenRouter, fully configured → usable', () => {
    seedSettings({ apiBase: OPENROUTER_API_BASE, apiKey: 'sk-or-test', model: 'some/model' });
    expect(isAiUsable()).toBe(true);
  });

  it('OpenRouter without a key (not configured) → gated', () => {
    seedSettings({ apiBase: OPENROUTER_API_BASE, model: 'some/model' });
    expect(isAiUsable()).toBe(false);
  });

  it('custom cloud endpoint, fully configured → usable', () => {
    seedSettings({ apiBase: 'https://api.example.com/v1', apiKey: 'sk-test', model: 'gpt-x' });
    expect(isAiUsable()).toBe(true);
  });
});
