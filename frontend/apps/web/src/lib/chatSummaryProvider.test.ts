import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { hydrateLlmSettings } from '@almamesh/llm';
import type { ChatSummaryPlan } from '@almamesh/llm';
import { prepareProviderChatSummary } from './chatSummaryProvider';

const PLAN: ChatSummaryPlan = {
  thread_id: 'thread-local-only',
  profile_id: 'profile-local-only',
  messages_to_summarize: [
    {
      id: 'durable-message-id',
      thread_id: 'thread-local-only',
      role: 'user',
      content: 'A bounded question',
      created_at: '2026-01-01T00:00:00.000Z',
    },
  ],
  source_message_ids: ['durable-message-id'],
  source_hash: '0'.repeat(64),
};

function settings(model: string): string {
  return JSON.stringify({
    apiBase: 'http://localhost:11434/v1',
    chatModel: model,
    privacyMode: 'local_only',
  });
}

describe('prepareProviderChatSummary', () => {
  beforeEach(() => hydrateLlmSettings(settings('model-before')));

  afterEach(() => {
    hydrateLlmSettings(null);
    vi.restoreAllMocks();
  });

  it('fails before fetch when provider settings changed after binding', async () => {
    const prepared = prepareProviderChatSummary();
    hydrateLlmSettings(settings('model-after'));
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    await expect(prepared(PLAN)).rejects.toMatchObject({ name: 'AbortError' });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('passes the lifecycle AbortSignal into the bound request', async () => {
    const prepared = prepareProviderChatSummary();
    const controller = new AbortController();
    controller.abort();
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    await expect(prepared(PLAN, controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('uses its immutable provider snapshot and translates citations locally', async () => {
    const prepared = prepareProviderChatSummary();
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  items: [{ text: 'Grounded fact', source_message_ids: ['s1'] }],
                  open_questions: [],
                }),
              },
            },
          ],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );

    await expect(prepared(PLAN)).resolves.toMatchObject({
      draft: {
        items: [{ text: 'Grounded fact', source_message_ids: ['durable-message-id'] }],
      },
      generator: { model: 'model-before' },
    });
    expect(fetchSpy).toHaveBeenCalledOnce();
    expect(String(fetchSpy.mock.calls[0][0])).toBe('http://localhost:11434/v1/chat/completions');
    expect(String(fetchSpy.mock.calls[0][1]?.body)).not.toContain('durable-message-id');
  });
});
