import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Page } from '@playwright/test';

import { waitForMemoryDashboard } from '../../e2e/timeTravelMemory.helpers';

// This suite exercises the actual helper's Page boundary, with no Playwright
// runner/browser transport loaded inside Vitest's DOM environment.
vi.mock('@playwright/test', () => ({ expect: vi.fn() }));

function fixture() {
  const navigation = Promise.withResolvers<void>();
  const visible = vi.fn(async () => false);
  const first = vi.fn(() => ({ isVisible: visible }));
  const getByText = vi.fn(() => ({ first }));
  const waitForURL = vi.fn(() => navigation.promise);
  return { navigation, visible, getByText, waitForURL, page: { waitForURL, getByText } as unknown as Page };
}
afterEach(() => { vi.useRealTimers(); });

describe('memory onboarding outcome', () => {
  it('keeps the 300000ms dashboard deadline and resolves success', async () => {
    const f = fixture();
    const ready = waitForMemoryDashboard(f.page);
    f.navigation.resolve();
    await expect(ready).resolves.toBeUndefined();
    expect(f.waitForURL).toHaveBeenCalledExactlyOnceWith('**/dashboard', { timeout: 300_000 });
  });

  it('fails promptly when CHART_GEN_001 is visible without awaiting or retrying navigation', async () => {
    const f = fixture();
    f.visible.mockResolvedValue(true);
    let settled = false;
    const outcome = waitForMemoryDashboard(f.page).then(() => 'unexpected dashboard', (error: Error) => { settled = true; return error.message; });
    await new Promise((resolve) => setTimeout(resolve, 0));
    try {
      expect(settled).toBe(true);
      expect(await outcome).toBe('Memory onboarding failed: CHART_GEN_001 is visible.');
      expect(f.waitForURL).toHaveBeenCalledOnce();
      expect(f.getByText).toHaveBeenCalledWith(/CHART_GEN_001/);
    } finally { f.navigation.resolve(); await outcome; }
  });

  it('stops error polling after success and handles a losing late visibility rejection', async () => {
    vi.useFakeTimers();
    const f = fixture();
    const visibility = Promise.withResolvers<boolean>();
    void visibility.promise.catch(() => undefined);
    f.visible.mockImplementationOnce(() => visibility.promise);
    const outcome = waitForMemoryDashboard(f.page);
    f.navigation.resolve();
    await outcome;
    visibility.reject(new Error('late page closure'));
    await vi.advanceTimersByTimeAsync(1_000);
    expect(f.visible).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('propagates navigation failures and stops polling', async () => {
    vi.useFakeTimers();
    const f = fixture();
    const failure = new Error('native navigation deadline');
    const outcome = waitForMemoryDashboard(f.page);
    const rejection = expect(outcome).rejects.toBe(failure);
    f.navigation.reject(failure);
    await rejection;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('handles a synchronous navigation throw without leaving the error watcher unhandled', async () => {
    const f = fixture();
    const visibility = Promise.withResolvers<boolean>();
    void visibility.promise.catch(() => undefined);
    f.visible.mockImplementationOnce(() => visibility.promise);
    const failure = new Error('native call failed');
    f.waitForURL.mockImplementationOnce(() => { throw failure; });
    await expect(waitForMemoryDashboard(f.page)).rejects.toBe(failure);
    visibility.reject(new Error('late visibility failure'));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  it('handles a losing late navigation rejection after the visible error won', async () => {
    const f = fixture();
    f.visible.mockResolvedValue(true);
    const outcome = waitForMemoryDashboard(f.page).catch((error: Error) => error.message);
    await new Promise((resolve) => setTimeout(resolve, 0));
    f.navigation.reject(new Error('late native navigation failure'));
    expect(await outcome).toBe('Memory onboarding failed: CHART_GEN_001 is visible.');
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
});
