import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useChatStore } from '@almamesh/store';

vi.mock('../../lib/storeSaved', () => ({ waitForStoreSaved: vi.fn(async () => undefined) }));

import { __resetMemoryForTest, __setMemoryForTest } from '../../lib/chatMemory';
import { useChatThread, type ChatStreamInput } from '../useChatThread';

const TRIP = { toolCallId: 'a', toolName: 'get_trip_context', args: {}, status: 'complete', result: { place: { label: 'Singapore', timezone: 'Asia/Singapore' } } } as const;
const TIMING = { toolCallId: 'b', toolName: 'get_timing', args: { section: 'dashas' }, status: 'complete', result: { data: { maha: [{ lord: 'jupiter' }] } } } as const;

beforeEach(() => {
  useChatStore.setState({ threads: {}, messages: {}, summaries: {} });
  __setMemoryForTest({
    indexMessage: vi.fn().mockResolvedValue(undefined), retrieve: vi.fn().mockResolvedValue([]),
    deleteForProfile: vi.fn().mockResolvedValue(undefined), deleteForThread: vi.fn().mockResolvedValue(undefined), clear: vi.fn().mockResolvedValue(undefined),
  });
});
afterEach(() => {
  useChatStore.setState({ threads: {}, messages: {}, summaries: {} });
  __resetMemoryForTest();
});

describe('an answer keeps the tool calls that grounded it', () => {
  it('persists each tool call (name, args, result) before the answer text, in order', async () => {
    const { result } = renderHook(() => useChatThread('p1', null));
    await act(() => result.current.submit('How was May 2019?', async (input: ChatStreamInput) => {
      input.onToolCall?.(TRIP);
      input.onToolCall?.(TIMING);
      return 'Steady work in Singapore.';
    }));
    const answer = result.current.messages.at(-1)!;
    expect(answer.content).toBe('Steady work in Singapore.');
    expect(answer.parts).toEqual([
      { type: 'tool-call', ...TRIP },
      { type: 'tool-call', ...TIMING },
      { type: 'text', text: 'Steady work in Singapore.' },
    ]);
  });

  it('an answer with no tool calls has no parts', async () => {
    const { result } = renderHook(() => useChatThread('p1', null));
    await act(() => result.current.submit('Hi', async () => 'Hello.'));
    expect(result.current.messages.at(-1)?.parts).toBeUndefined();
  });

  it('a call whose result could not be read is kept without a result', async () => {
    const { result } = renderHook(() => useChatThread('p1', null));
    await act(() => result.current.submit('Q', async (input) => {
      input.onToolCall?.({ toolCallId: 'x', toolName: 'get_timing', args: {}, status: 'error', result: undefined });
      return 'A.';
    }));
    expect(result.current.messages.at(-1)?.parts?.[0]).toEqual({ type: 'tool-call', toolCallId: 'x', toolName: 'get_timing', args: {}, status: 'error' });
  });
});
