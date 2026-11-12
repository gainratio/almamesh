import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { EngineOperationError, EngineStorageBlockedError } from '@almamesh/browser';
import { afterEach, describe, expect, it, vi } from 'vitest';

import '../../../../i18n/config';
import { ChartEngineContext, type ChartEngineContextValue } from '../../../../providers/chartEngineContext';
import { ChatEngineAlert } from '../ChatEngineAlert';

const clearEngineBundleCache = vi.fn().mockResolvedValue(true);
vi.mock('../../../../lib/resetAppData', () => ({
  clearEngineBundleCache: () => clearEngineBundleCache(),
}));

function makeEngineCtx(error: Error | null, reboot = vi.fn().mockResolvedValue({})): ChartEngineContextValue {
  return {
    engine: null,
    stage: null,
    error,
    meta: null,
    startBootstrap: vi.fn(),
    whenReady: vi.fn(),
    reboot,
  };
}

afterEach(() => {
  cleanup();
  clearEngineBundleCache.mockClear();
});

describe('ChatEngineAlert', () => {
  it('renders nothing when there is no engine error', () => {
    render(
      <ChartEngineContext.Provider value={makeEngineCtx(null)}>
        <ChatEngineAlert />
      </ChartEngineContext.Provider>,
    );
    expect(screen.queryByTestId('chat-engine-error')).toBeNull();
  });

  it('surfaces multi-tab OPFS lock inside chat with Retry and without cache-clear button', () => {
    const reboot = vi.fn().mockResolvedValue({});
    render(
      <ChartEngineContext.Provider value={makeEngineCtx(new EngineStorageBlockedError('pool-in-use'), reboot)}>
        <ChatEngineAlert />
      </ChartEngineContext.Provider>,
    );
    expect(screen.getByTestId('chat-engine-error').textContent).toContain('Another AlmaMesh tab');
    expect(screen.queryByTestId('chat-clear-engine-cache')).toBeNull();
    fireEvent.click(screen.getByTestId('chat-engine-retry'));
    expect(reboot).toHaveBeenCalledTimes(1);
  });

  it('clears engine bundle cache and reloads on explicit click for non-rollback failures', async () => {
    const onReload = vi.fn();
    render(
      <ChartEngineContext.Provider value={makeEngineCtx(new Error('chunk sha256 mismatch'))}>
        <ChatEngineAlert onReload={onReload} />
      </ChartEngineContext.Provider>,
    );
    expect(screen.getByTestId('chat-engine-error-detail').textContent).toBe('chunk sha256 mismatch');
    fireEvent.click(screen.getByTestId('chat-clear-engine-cache'));
    await waitFor(() => expect(clearEngineBundleCache).toHaveBeenCalledTimes(1));
    expect(onReload).toHaveBeenCalledTimes(1);
  });

  it('guards rollback refusals behind RollbackResetGuard two-step confirmation', async () => {
    const onReload = vi.fn();
    const rollbackErr = new EngineOperationError({ code: 'rollback', message: 'refusing rollback' });
    render(
      <ChartEngineContext.Provider value={makeEngineCtx(rollbackErr)}>
        <ChatEngineAlert onReload={onReload} />
      </ChartEngineContext.Provider>,
    );
    expect(screen.getByTestId('rollback-warning')).toBeTruthy();
    fireEvent.click(screen.getByTestId('chat-clear-engine-cache'));
    expect(clearEngineBundleCache).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId('rollback-reset-confirm'));
    await waitFor(() => expect(clearEngineBundleCache).toHaveBeenCalledTimes(1));
    expect(onReload).toHaveBeenCalledTimes(1);
  });
});
