import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useChatStore } from '@almamesh/store';

vi.mock('../../lib/storeSaved', () => ({ waitForStoreSaved: vi.fn(async () => undefined) }));

import { __resetMemoryForTest, __setMemoryForTest } from '../../lib/chatMemory';
import { buildPeriodReading, periodReadingSummary } from '../../lib/periodReading';
import { periodReadingFixture } from '../../lib/__tests__/periodReadingFixtures';
import { useChatThread, type ChatStreamInput } from '../useChatThread';

const TRIP = { toolCallId: 'a', toolName: 'travel', args: { to: '2019-05', place: 'Singapore' }, status: 'complete', result: { status: 'queued', action: 'travel', place_label: 'Singapore' } } as const;
const TIMING = { toolCallId: 'b', toolName: 'read_period', args: { start: '2019-05', end: null, place: null, time: null, focus: 'dashas' }, status: 'complete', result: { dashas: { maha: [{ lord: 'jupiter' }] } } } as const;

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
      input.onToolCall?.({ toolCallId: 'x', toolName: 'read_period', args: {}, status: 'error', result: undefined });
      return 'A.';
    }));
    expect(result.current.messages.at(-1)?.parts?.[0]).toEqual({ type: 'tool-call', toolCallId: 'x', toolName: 'read_period', args: {}, status: 'error' });
  });
});

describe('history compaction: a past turn\'s tool results reach the next turn only as summaries', () => {
  it('the next turn gets one facts note with each earlier result on one line, never the full payload', async () => {
    const BIG = { toolCallId: 'c', toolName: 'read_period', args: {}, status: 'complete', result: { period: { label: 'May 2019' }, blob: 'q'.repeat(5_000) } } as const;
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
    expect(note).toContain('- travel: action: travel · place_label: Singapore · status: queued');
    // A result read_period's own summary cannot read falls back to the default line.
    expect(note).toContain('- read_period: May 2019');
    expect(note).not.toContain('q'.repeat(50));
    // The prior answer's prose still rides as an ordinary history turn.
    expect(next?.history.map((turn) => turn.content)).toContain('Steady work in Singapore.');
  });

  it('an earlier period reading reaches the next turn as its own summary line, not the generic default', async () => {
    const reading = buildPeriodReading(periodReadingFixture('delhi-2019-05'), {
      period: { start: '2019-05-01', end: '2019-05-31', granularity: 'month', label: 'May 2019', tense: 'past' },
      place: { label: 'Singapore', timezone: 'Asia/Singapore' },
    });
    const READING = { toolCallId: 'r', toolName: 'read_period', args: {}, status: 'complete', result: reading } as const;
    const { result } = renderHook(() => useChatThread('p1', null));
    await act(() => result.current.submit('How was May 2019?', async (input) => {
      input.onToolCall?.(READING);
      return 'A Rahu month.';
    }));
    let next: ChatStreamInput | undefined;
    await act(() => result.current.submit('And June?', async (input) => { next = input; return 'Quieter.'; }));
    const note = next?.retrievedContext.find((entry) => entry.startsWith('Facts gathered by tools in earlier turns'));
    const own = periodReadingSummary(reading);
    // read_period's own line: the period and place, then the reading's own summary, then its cited factors.
    expect(note).toContain(`- read_period: May 2019 · Singapore · ${own.line} (${own.factors.join('; ')})`);
  });

  it('a thread with no earlier tool calls gets no facts note', async () => {
    const { result } = renderHook(() => useChatThread('p1', null));
    await act(() => result.current.submit('Hi', async () => 'Hello.'));
    let next: ChatStreamInput | undefined;
    await act(() => result.current.submit('Again', async (input) => { next = input; return 'Hi.'; }));
    expect(next?.retrievedContext.some((entry) => entry.startsWith('Facts gathered'))).toBe(false);
  });
});
