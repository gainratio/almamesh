import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { act, type ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import type { ChartEngine } from '@almamesh/browser';

/** Wrap the hook with a QueryClientProvider (the hook calls useQueryClient). */
function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient();
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

// --- mocks (declared before importing the hook) ---
const regenerateSpy = vi.fn().mockResolvedValue(undefined);
vi.mock('@almamesh/store', async (orig) => {
  const actual = await orig<typeof import('@almamesh/store')>();
  return { ...actual, regenerateOnBirthChange: (...args: unknown[]) => regenerateSpy(...args) };
});

let engineValue: { engine: ChartEngine | null };
vi.mock('../../providers/AlmaMeshRuntimeProvider', () => ({
  useChartEngine: () => engineValue,
}));

import { appEvents, useChatStore, usePredictiveStore, type BirthInfoChanged } from '@almamesh/store';
import { useRegenerationSubscription } from '../useRegenerationSubscription';

const fakeEngine = { generateChart: vi.fn() } as unknown as ChartEngine;

const event: BirthInfoChanged = {
  birth: {
    name: 'Asha',
    date: '1990-01-15',
    time: '12:00',
    latitude: 18.52,
    longitude: 73.85,
    timezone: 'Asia/Kolkata',
    location_name: 'Pune, India',
  },
  profileId: 'p1',
};

describe('useRegenerationSubscription — emit-before-subscribe race', () => {
  beforeEach(() => {
    regenerateSpy.mockClear();
    appEvents.all.clear();
    usePredictiveStore.getState().reset();
  });

  afterEach(() => {
    appEvents.all.clear();
  });

  it('handles a live event when the engine is already ready', () => {
    engineValue = { engine: fakeEngine };
    renderHook(() => useRegenerationSubscription(), { wrapper });

    act(() => {
      appEvents.emit('birth-info-changed', event);
    });

    expect(regenerateSpy).toHaveBeenCalledTimes(1);
    expect(regenerateSpy.mock.calls[0][0]).toBe(event);
  });

  it('hands the regeneration the live chat store, so a replaced chart never leaves a dangling chat link', () => {
    engineValue = { engine: fakeEngine };
    renderHook(() => useRegenerationSubscription(), { wrapper });

    act(() => {
      appEvents.emit('birth-info-changed', event);
    });

    const deps = regenerateSpy.mock.calls[0][1] as { chat: { unlinkMissingCharts: unknown } };
    expect(deps.chat.unlinkMissingCharts).toBe(useChatStore.getState().unlinkMissingCharts);
  });

  it('REPLAYS an event emitted BEFORE the engine was ready, once it becomes ready', () => {
    // Engine not ready yet (the warming race / post-reboot moment).
    engineValue = { engine: null };
    const { rerender } = renderHook(() => useRegenerationSubscription(), { wrapper });

    // Onboarding emits the moment resolveReadyEngine resolves — but the
    // subscriber's effect has not re-attached with a ready engine yet.
    act(() => {
      appEvents.emit('birth-info-changed', event);
    });
    expect(regenerateSpy).not.toHaveBeenCalled();

    // The engine becomes ready -> the effect re-runs and must DRAIN the pending
    // event so the chart is actually computed (no dropped compute on dashboard).
    engineValue = { engine: fakeEngine };
    act(() => {
      rerender();
    });

    expect(regenerateSpy).toHaveBeenCalledTimes(1);
    expect(regenerateSpy.mock.calls[0][0]).toBe(event);
  });

  it('does not double-handle: a replayed event is consumed exactly once', () => {
    engineValue = { engine: null };
    const { rerender } = renderHook(() => useRegenerationSubscription(), { wrapper });

    act(() => {
      appEvents.emit('birth-info-changed', event);
    });

    engineValue = { engine: fakeEngine };
    act(() => {
      rerender();
    });
    // A further unrelated rerender must NOT replay the same pending event again.
    act(() => {
      rerender();
    });

    expect(regenerateSpy).toHaveBeenCalledTimes(1);
  });

  it('invalidates predictive contexts after a birth change regenerates the chart', () => {
    usePredictiveStore.setState({
      status: 'ready',
      profileKey: 'p1',
      requestKey: 'old-natal-input',
    });
    engineValue = { engine: fakeEngine };
    renderHook(() => useRegenerationSubscription(), { wrapper });

    act(() => {
      appEvents.emit('birth-info-changed', event);
    });
    const deps = regenerateSpy.mock.calls[0]?.[1] as { onRegenerated: () => void };
    act(() => {
      deps.onRegenerated();
    });

    expect(usePredictiveStore.getState().status).toBe('idle');
    expect(usePredictiveStore.getState().requestKey).toBeUndefined();
  });

  it('preserves the active profile cache when another profile finishes regenerating', () => {
    usePredictiveStore.setState({
      status: 'ready',
      profileKey: 'profile-b',
      requestKey: 'profile-b-current-input',
    });
    engineValue = { engine: fakeEngine };
    renderHook(() => useRegenerationSubscription(), { wrapper });

    act(() => {
      appEvents.emit('birth-info-changed', event);
    });
    const deps = regenerateSpy.mock.calls[0]?.[1] as { onRegenerated: () => void };
    act(() => {
      deps.onRegenerated();
    });

    expect(usePredictiveStore.getState().status).toBe('ready');
    expect(usePredictiveStore.getState().profileKey).toBe('profile-b');
    expect(usePredictiveStore.getState().requestKey).toBe('profile-b-current-input');
  });
});
