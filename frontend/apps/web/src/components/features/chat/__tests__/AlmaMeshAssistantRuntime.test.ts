import { describe, expect, it } from 'vitest';

import type { ChatMessage } from '@almamesh/shared-types';
import {
  convertChatMessage,
  textFromComposerMessage,
} from '../AlmaMeshAssistantRuntime';

const message = (overrides: Partial<ChatMessage> = {}): ChatMessage => ({
  id: 'message-1',
  thread_id: 'thread-1',
  role: 'assistant',
  content: 'A grounded answer.',
  created_at: '2026-09-21T20:00:00.000Z',
  ...overrides,
});

describe('AlmaMesh assistant-ui external-store adapter', () => {
  it('preserves stable identity, text, time, and completed assistant status', () => {
    expect(convertChatMessage(message())).toEqual({
      id: 'message-1',
      role: 'assistant',
      content: [{ type: 'text', text: 'A grounded answer.' }],
      createdAt: new Date('2026-09-21T20:00:00.000Z'),
      status: { type: 'complete', reason: 'stop' },
      metadata: { custom: { error: false, streaming: false } },
    });
  });

  it('keeps error notices visible as metadata without turning them into model state', () => {
    const converted = convertChatMessage(message({ error: true, content: 'Endpoint unavailable.' }));
    expect(converted.metadata).toEqual({ custom: { error: true, streaming: false } });
    expect(converted.content).toEqual([{ type: 'text', text: 'Endpoint unavailable.' }]);
  });

  it('creates one running synthetic assistant message for the streaming draft', () => {
    expect(
      convertChatMessage(
        message({ id: 'stream-turn-7', content: 'Partial answer', created_at: '' }),
        { streaming: true },
      ),
    ).toMatchObject({
      id: 'stream-turn-7',
      status: { type: 'running' },
      metadata: { custom: { error: false, streaming: true } },
    });
  });

  it('accepts exactly the text parts from a composer submission', () => {
    expect(
      textFromComposerMessage({
        content: [
          { type: 'text', text: 'What time ' },
          { type: 'text', text: 'is it?' },
        ],
      }),
    ).toBe('What time is it?');
  });

  it('rejects a non-text composer payload instead of silently dropping it', () => {
    expect(() =>
      textFromComposerMessage({
        content: [{ type: 'image', image: 'data:image/png;base64,AA==' }],
      }),
    ).toThrow(/text-only/i);
  });
});

describe('tool-call parts reach assistant-ui', () => {
  it('maps persisted tool calls through, in order, with their args and the result the model got', () => {
    const converted = convertChatMessage(message({
      content: 'Steady work in Singapore.',
      parts: [
        { type: 'tool-call', toolCallId: 'a', toolName: 'get_trip_context', args: {}, status: 'complete', result: { place: { label: 'Singapore' } } },
        { type: 'tool-call', toolCallId: 'b', toolName: 'get_timing', args: { section: 'transits' }, status: 'error', result: { code: 'tool_failed' } },
        { type: 'text', text: 'Steady work in Singapore.' },
      ],
    }));
    expect(converted.content).toEqual([
      { type: 'tool-call', toolCallId: 'a', toolName: 'get_trip_context', args: {}, argsText: '{}', result: { place: { label: 'Singapore' } }, isError: false },
      { type: 'tool-call', toolCallId: 'b', toolName: 'get_timing', args: { section: 'transits' }, argsText: '{"section":"transits"}', result: { code: 'tool_failed' }, isError: true },
      { type: 'text', text: 'Steady work in Singapore.' },
    ]);
  });

  it('a message without parts stays one text part', () => {
    expect(convertChatMessage(message()).content).toEqual([{ type: 'text', text: 'A grounded answer.' }]);
  });
});

describe('thread list entries', () => {
  it('a trip and a today thread', async () => {
    const { threadListEntry } = await import('../AlmaMeshAssistantRuntime');
    const base = { profile_id: 'p1', created_at: '', updated_at: '', archived_at: null, message_count: 0 };
    expect(threadListEntry({ ...base, id: 't1', title: '⏳ May 2019 · Singapore', as_of: { start: '2019-05-01', end: '2019-05-31', granularity: 'month' } }))
      .toEqual({ status: 'regular', id: 't1', title: '⏳ May 2019 · Singapore', custom: { trip: true } });
    expect(threadListEntry({ ...base, id: 't2', title: null })).toEqual({ status: 'regular', id: 't2', custom: { trip: false } });
  });
});
