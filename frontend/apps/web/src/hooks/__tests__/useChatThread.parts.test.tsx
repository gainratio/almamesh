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

describe('history compaction: a past turn\'s tool results reach the next turn only as summaries', () => {
  it('the next turn gets one facts note with each earlier result on one line, never the full payload', async () => {
    const BIG = { toolCallId: 'c', toolName: 'get_timing', args: {}, status: 'complete', result: { period: { label: 'May 2019' }, blob: 'q'.repeat(5_000) } } as const;
    const { result } = renderHook(() => useChatThread('p1', null));
    await act(() => result.current.submit('How was May 2019?', async (input) => {
      input.onToolCall?.(TRIP);
      input.onToolCall?.(BIG);
      return 'Steady work in Singapore.';
    }));
    let next: ChatStreamInput | undefined;
    await act(() => result.current.submit('And June?', async (input) => {
      next = input;
      return 'Quieter.';
    }));
    const note = next?.retrievedContext.find((entry) => entry.startsWith('Facts gathered by tools in earlier turns'));
    expect(note).toContain('- get_trip_context: Singapore');
    expect(note).toContain('- get_timing: May 2019');
    expect(note).not.toContain('q'.repeat(50));
    // The prior answer's prose still rides as an ordinary history turn.
    expect(next?.history.map((turn) => turn.content)).toContain('Steady work in Singapore.');
  });

  it('a thread with no earlier tool calls gets no facts note', async () => {
    const { result } = renderHook(() => useChatThread('p1', null));
    await act(() => result.current.submit('Hi', async () => 'Hello.'));
    let next: ChatStreamInput | undefined;
    await act(() => result.current.submit('Again', async (input) => { next = input; return 'Hi.'; }));
    expect(next?.retrievedContext.some((entry) => entry.startsWith('Facts gathered'))).toBe(false);
  });
});
