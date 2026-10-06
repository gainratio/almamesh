/**
 * The tree main.tsx renders while the browser refuses storage.
 *
 * CI hang (run 37362447831, 2026-10-05): the blocked startup rendered only the
 * block screen, so <App> and its UpdateBanner never mounted, no service worker
 * was registered, and a gate awaiting navigator.serviceWorker.ready in Linux
 * WebKit (which refuses OPFS) waited for 74 minutes. A visitor stuck on the
 * block screen must still register the service worker, so it can be offered
 * the update that fixes whatever stranded them.
 */
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

vi.mock('../UpdateBanner', () => ({
  UpdateBanner: () => <div data-testid="update-banner-mounted" />,
}));
vi.mock('../StorageGate', () => ({
  StorageGate: () => <div data-testid="storage-gate-mounted" />,
}));

import { BlockedStartup } from '../BlockedStartup';

describe('BlockedStartup', () => {
  it('shows the block screen and still registers the service worker (UpdateBanner)', () => {
    render(<BlockedStartup />);
    expect(screen.getByTestId('storage-gate-mounted')).toBeTruthy();
    expect(screen.getByTestId('update-banner-mounted')).toBeTruthy();
  });
});
