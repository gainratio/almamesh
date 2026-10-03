import { describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';

import { useSingleFlight, type FlightTask } from '../useSingleFlight';

function deferredTask(): { task: FlightTask; finish: () => void; release: () => void } {
  let finish!: () => void;
  let release!: () => void;
  const task: FlightTask = (rel) => {
    release = rel;
    return new Promise<void>((resolve) => {
      finish = resolve;
    });
  };
  return { task, finish: () => finish(), release: () => release() };
}

describe('useSingleFlight', () => {
  it('attaches a repeat request for the same key to the run in flight', () => {
    const { result } = renderHook(() => useSingleFlight());
    const first = deferredTask();
    const second = vi.fn(deferredTask().task);
    const supersede = vi.fn();

    let a: Promise<void> | undefined;
    let b: Promise<void> | undefined;
    act(() => {
      a = result.current.run('chart-1', first.task, supersede);
      b = result.current.run('chart-1', second, supersede);
    });

    expect(b).toBe(a);
    expect(second).not.toHaveBeenCalled();
    expect(supersede).toHaveBeenCalledTimes(1);
    expect(result.current.activeKey).toBe('chart-1');
  });

  it('accepts a new request once the first releases its visible phase', () => {
    const { result } = renderHook(() => useSingleFlight());
    const first = deferredTask();
    const second = vi.fn(deferredTask().task);

    act(() => {
      void result.current.run('chart-1', first.task, () => {});
    });
    act(() => first.release());
    expect(result.current.activeKey).toBeNull();

    act(() => {
      void result.current.run('chart-1', second, () => {});
    });
    expect(second).toHaveBeenCalledTimes(1);
    expect(result.current.activeKey).toBe('chart-1');
  });

  it('a late settle of an old run never clears the newer run', async () => {
    const { result } = renderHook(() => useSingleFlight());
    const first = deferredTask();
    const second = deferredTask();
    const third = vi.fn(deferredTask().task);

    act(() => {
      void result.current.run('chart-1', first.task, () => {});
    });
    act(() => first.release());
    act(() => {
      void result.current.run('chart-1', second.task, () => {});
    });
    await act(async () => first.finish());

    expect(result.current.activeKey).toBe('chart-1');
    act(() => {
      void result.current.run('chart-1', third, () => {});
    });
    expect(third).not.toHaveBeenCalled();
  });

  it('a task that releases synchronously never registers as in flight', () => {
    const { result } = renderHook(() => useSingleFlight());
    const next = vi.fn(deferredTask().task);

    act(() => {
      void result.current.run('chart-1', (release) => {
        release();
        return new Promise<void>(() => {});
      }, () => {});
    });
    expect(result.current.activeKey).toBeNull();

    act(() => {
      void result.current.run('chart-1', next, () => {});
    });
    expect(next).toHaveBeenCalledTimes(1);
  });
});
