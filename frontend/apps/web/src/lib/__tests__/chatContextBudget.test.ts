import { CLOUD_CHAT_BUDGET, hydrateLlmSettings, type ProviderConfig } from '@almamesh/llm';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { chatContextFor } from '../chatContextBudget';

const OPENROUTER: ProviderConfig = { engine: 'openai-http', model: 'mock/ctx-1m', privacyMode: 'cloud_premium', baseUrl: 'https://openrouter.ai/api/v1', apiKey: 'k' };
const LOCAL: ProviderConfig = { engine: 'openai-http', model: 'llama3.1', privacyMode: 'local_only', baseUrl: 'http://localhost:11434/v1' };

afterEach(() => hydrateLlmSettings(null));

describe('chatContextFor (the chat turn\'s context budget seam)', () => {
  it('an OpenRouter model reads its window from the catalog and keeps the cloud prompt sizing', async () => {
    const fetchImpl = vi.fn(async () => Response.json({ data: [{ id: 'mock/ctx-1m', context_length: 1_000_000 }] }));
    const context = await chatContextFor(OPENROUTER, undefined, fetchImpl as typeof fetch);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(context.promptBudget).toBe(CLOUD_CHAT_BUDGET);
    expect(context.contextTokens).toBe(1_000_000);
    expect(typeof context.telemetry.onRound).toBe('function');
    expect(typeof context.telemetry.onToolCall).toBe('function');
  });

  it('a local endpoint uses the configured window from settings, with no network read', async () => {
    hydrateLlmSettings(JSON.stringify({ chatContextTokens: 8_192 }));
    const fetchImpl = vi.fn();
    const context = await chatContextFor(LOCAL, undefined, fetchImpl as unknown as typeof fetch);
    expect(context.promptBudget.promptTokens).toBe(1_638);
    expect(context.contextTokens).toBe(8_192);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('an unknown window caps the prompt as for 8k', async () => {
    const context = await chatContextFor(LOCAL, undefined, vi.fn() as unknown as typeof fetch);
    expect(context.promptBudget.promptTokens).toBe(1_638);
    expect(context.contextTokens).toBeUndefined(); // the tool loop then assumes 8k
  });
});
