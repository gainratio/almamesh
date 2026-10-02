import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

// `virtual:pwa-register` is stubbed via a vitest.config alias — it never reports
// an update, so `needRefresh` stays false and only the version poller can raise
// the banner. That is exactly the branch this file guards.
vi.mock('../../lib/swSelfHeal', () => ({ healStrandedServiceWorker: vi.fn() }));
vi.mock('../../lib/swUpdate', () => ({ applyServiceWorkerUpdate: vi.fn(), reloadPage: vi.fn() }));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

import { applyServiceWorkerUpdate, reloadPage, type UpdateStatus } from '../../lib/swUpdate';
import { UpdateBanner } from '../UpdateBanner';

const applyUpdate = vi.mocked(applyServiceWorkerUpdate);
const reloadNow = vi.mocked(reloadPage);

/** Click "Reload to update" and hand back the status callback the click armed. */
async function clickUpdate(): Promise<(status: UpdateStatus) => void> {
  stubVersionEndpoint(['build-1', 'build-2']);
  await renderAndDeploy();
  await userEvent.click(await screen.findByRole('button', { name: 'update.reload_cta' }));
  await waitFor(() => expect(applyUpdate).toHaveBeenCalledTimes(1));
  const onStatus = applyUpdate.mock.calls[0]?.[0]?.onStatus;
  if (!onStatus) throw new Error('the click must report its status to the banner');
  return (status) => act(() => onStatus(status));
}

/** Serve /version.json, changing the version on the Nth call to fake a deploy. */
function stubVersionEndpoint(versions: string[]) {
  let call = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      const version = versions[Math.min(call++, versions.length - 1)];
      return {
        ok: true,
        json: async () => ({ version, buildTime: '2026-08-01T00:00:00Z' }),
      } as Response;
    }),
  );
}

/**
 * Render, let the boot-time version check settle, then fake a deploy by firing
 * the window focus the poller listens for. Sequencing matters: the poller drops
 * a concurrent check, so a focus fired while the first fetch is in flight is
 * silently ignored.
 */
async function renderAndDeploy() {
  render(<UpdateBanner />);
  await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
  window.dispatchEvent(new Event('focus'));
}

beforeEach(() => {
  applyUpdate.mockClear();
  reloadNow.mockClear();
  vi.stubGlobal('navigator', { ...navigator, storage: { persist: async () => true } });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('UpdateBanner', () => {
  it('applies the service-worker update when the version poller raised the banner', async () => {
    // THE REGRESSION. Only /version.json noticed the deploy — the browser has
    // not re-checked sw.js, so Workbox reports nothing and `needRefresh` is
    // false. This branch used to run a bare window.location.reload(), which
    // cannot activate a waiting worker, leaving the user on the stale build.
    stubVersionEndpoint(['build-1', 'build-2']);
    await renderAndDeploy();

    const cta = await screen.findByRole('button', { name: 'update.reload_cta' });
    await userEvent.click(cta);

    await waitFor(() => expect(applyUpdate).toHaveBeenCalledTimes(1));
  });

  it('stays hidden while the deployed version is unchanged', async () => {
    stubVersionEndpoint(['build-1']);
    await renderAndDeploy();

    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
    expect(screen.queryByRole('button', { name: 'update.reload_cta' })).toBeNull();
  });

  it('sits above the app chrome so the CTA cannot be buried', async () => {
    // The landing header is `sticky top-0 z-50` and comes later in the DOM, so
    // an equal z-index paints over this banner: invisible and unclickable.
    stubVersionEndpoint(['build-1', 'build-2']);
    await renderAndDeploy();

    const banner = await screen.findByRole('status');

    expect(banner.className).toContain('z-[60]');
    expect(banner.className).not.toMatch(/\bz-50\b/);
  });

  it('stays up after the click and says it is finishing the previous download', async () => {
    // A busy previous worker holds activation for up to 5 min. The banner must
    // not vanish while the user waits, or the update looks like it failed.
    const report = await clickUpdate();

    report('finishing-previous');

    expect(await screen.findByText('update.finishing_previous')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'update.reload_cta' })).toBeNull();
  });

  it('offers a manual "Reload now" while it waits', async () => {
    const report = await clickUpdate();
    report('finishing-previous');

    await userEvent.click(await screen.findByRole('button', { name: 'update.reload_now' }));

    expect(reloadNow).toHaveBeenCalledTimes(1);
  });

  it('says plainly when the update could not finish', async () => {
    const report = await clickUpdate();

    report('stalled');

    expect(await screen.findByText('update.stalled')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'update.reload_now' })).toBeTruthy();
  });
});
