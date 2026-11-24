import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ChartEngine } from '@almamesh/browser';
import { type LocalBirthInput, useAyanamsaStore } from '@almamesh/store';

import { useLagnaPreview } from './useLagnaPreview';

function validInput(): LocalBirthInput {
  return {
    date: '1990-03-30',
    time: '12:00',
    latitude: 12.97,
    longitude: 77.59,
    timezone: 'Asia/Kolkata',
  };
}

function makeEngine() {
  const generateChart = vi.fn().mockResolvedValue({
    lagna: {
      sign: 'Aquarius',
      sign_degrees: 3.5,
      nakshatra: 'Dhanishta',
    },
  });
  return {
    engine: { generateChart } as unknown as ChartEngine,
    generateChart,
  };
}

describe('useLagnaPreview', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it('does not regenerate lagna for a new object with the same value key', async () => {
    const { engine, generateChart } = makeEngine();
    const initialInput = validInput();
    const { rerender } = renderHook(
      ({ input }: { input: LocalBirthInput }) => useLagnaPreview(engine, null, input),
      { initialProps: { input: initialInput } },
    );

    act(() => vi.advanceTimersByTime(300));
    await waitFor(() => expect(generateChart).toHaveBeenCalledTimes(1));

    rerender({ input: { ...initialInput } });
    act(() => vi.advanceTimersByTime(300));

    expect(generateChart).toHaveBeenCalledTimes(1);
  });

  it('never exposes a ready result from the previous input key', async () => {
    const { engine, generateChart } = makeEngine();
    const initialInput = validInput();
    const renderedStatuses: string[] = [];
    const { result, rerender } = renderHook(
      ({ input }: { input: LocalBirthInput }) => {
        const preview = useLagnaPreview(engine, null, input);
        renderedStatuses.push(preview.status);
        return preview;
      },
      { initialProps: { input: initialInput } },
    );

    act(() => vi.advanceTimersByTime(300));
    await waitFor(() => expect(result.current.status).toBe('ready'));

    generateChart.mockImplementationOnce(() => new Promise(() => undefined));
    renderedStatuses.length = 0;
    rerender({ input: { ...initialInput, rectifiedTime: '12:15' } });

    expect(renderedStatuses[0]).toBe('loading');
    expect(renderedStatuses).not.toContain('ready');
    expect(result.current.status).toBe('loading');
  });

  it('retries the same input when the retry attempt changes', async () => {
    const { engine, generateChart } = makeEngine();
    generateChart.mockRejectedValueOnce(new Error('preview failed'));
    const input = validInput();
    const { result, rerender } = renderHook(
      ({ retryAttempt }: { retryAttempt: number }) =>
        useLagnaPreview(engine, null, input, retryAttempt),
      { initialProps: { retryAttempt: 0 } },
    );

    act(() => vi.advanceTimersByTime(300));
    await waitFor(() => expect(result.current.status).toBe('error'));

    rerender({ retryAttempt: 1 });
    expect(result.current.status).toBe('loading');
    act(() => vi.advanceTimersByTime(300));
    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(generateChart).toHaveBeenCalledTimes(2);
  });

  it('forwards the active non-Lahiri ayanamsa and recomputes when ayanamsa changes', async () => {
    useAyanamsaStore.setState({ ayanamsa: 'KP' });
    try {
      const { engine, generateChart } = makeEngine();
      const input = validInput();
      renderHook(() => useLagnaPreview(engine, null, input));

      act(() => vi.advanceTimersByTime(300));
      await waitFor(() => expect(generateChart).toHaveBeenCalledTimes(1));
      expect(generateChart).toHaveBeenLastCalledWith(
        expect.objectContaining({ ayanamsaType: 'KP' }),
      );

      act(() => {
        useAyanamsaStore.setState({ ayanamsa: 'RAMAN' });
      });
      act(() => vi.advanceTimersByTime(300));
      await waitFor(() => expect(generateChart).toHaveBeenCalledTimes(2));
      expect(generateChart).toHaveBeenLastCalledWith(
        expect.objectContaining({ ayanamsaType: 'RAMAN' }),
      );
    } finally {
      useAyanamsaStore.setState({ ayanamsa: 'LAHIRI' });
    }
  });
});
