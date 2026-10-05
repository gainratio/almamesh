/**
 * The engine cache is held by another AlmaMesh tab (opfs-sahpool allows one
 * owner). Say that plainly and offer a retry, never the generic engine error.
 */
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { EngineStorageBlockedError } from '@almamesh/browser';

const engine = vi.hoisted(() => ({ error: null as Error | null, reboot: vi.fn(async () => undefined) }));
vi.mock('../../providers/chartEngineContext', () => ({
  useChartEngine: () => ({ error: engine.error, reboot: engine.reboot }),
}));

import '../../i18n/config';
import { EngineOtherTabNotice } from '../EngineOtherTabNotice';

describe('EngineOtherTabNotice', () => {
  it('says AlmaMesh is open in another tab and retries on request', () => {
    engine.error = new Error('bootstrap failed', { cause: new EngineStorageBlockedError('pool-in-use') });
    render(<EngineOtherTabNotice />);
    const notice = screen.getByTestId('engine-other-tab-notice');
    expect(notice.getAttribute('role')).toBe('alert');
    expect(notice.textContent).toContain('AlmaMesh is open in another tab');
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(engine.reboot).toHaveBeenCalledOnce();
  });

  it('renders nothing for any other engine state', () => {
    for (const error of [null, new Error('network unreachable'), new EngineStorageBlockedError('opfs-unavailable')]) {
      engine.error = error;
      const view = render(<EngineOtherTabNotice />);
      expect(screen.queryByTestId('engine-other-tab-notice')).toBeNull();
      view.unmount();
    }
  });
});
