/**
 * StorageGate: AlmaMesh runs only on persistent on-device SQLite (OPFS). When
 * the browser refuses that storage, the app does not run in RAM: it shows a
 * screen that says so plainly and walks the user through allowing it, for the
 * browser they are actually using, with a "Check again" that continues into
 * the app without a reload.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import type { PortableStatePersistence } from '@almamesh/store';

const store = vi.hoisted(() => ({
  persistence: 'pending' as PortableStatePersistence,
  siteBlocked: false,
  nextOnCheck: 'blocked' as PortableStatePersistence,
  listeners: new Set<() => void>(),
  checkAgain: vi.fn(),
}));

vi.mock('@almamesh/store', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@almamesh/store')>()),
  portableStatePersistence: () => store.persistence,
  subscribePortableStatePersistence: (listener: () => void) => {
    store.listeners.add(listener);
    return () => store.listeners.delete(listener);
  },
  siteStorageBlocked: () => store.siteBlocked,
  checkPortableStorageAgain: store.checkAgain,
}));

const permission = vi.hoisted(() => ({ request: vi.fn(async () => false) }));
vi.mock('../../lib/storagePermission', () => ({ requestPersistentStorage: permission.request }));

function setPersistence(next: PortableStatePersistence): void {
  store.persistence = next;
  for (const listener of store.listeners) listener();
}

import '../../i18n/config';
import { StorageGate } from '../StorageGate';

const UA = {
  'safari-macos':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15',
  'safari-ios':
    'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
  chromium:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36',
  firefox: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:131.0) Gecko/20100101 Firefox/131.0',
  other: 'SomeBrowser/1.0',
} as const;
type Browser = keyof typeof UA;

/** A phrase only that browser's steps contain. */
const SIGNATURE: Record<Browser, string> = {
  'safari-macos': 'the Privacy tab',
  'safari-ios': 'Open the Settings app',
  chromium: 'Incognito',
  firefox: 'Manage Exceptions',
  other: "In your browser's settings",
};

function pretendBrowser(browser: Browser): void {
  vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(UA[browser]);
  vi.spyOn(navigator, 'maxTouchPoints', 'get').mockReturnValue(browser === 'safari-ios' ? 5 : 0);
}

function renderGate() {
  return render(
    <StorageGate>
      <p>dashboard chart</p>
    </StorageGate>,
  );
}

beforeEach(() => {
  store.checkAgain.mockImplementation(async () => {
    setPersistence(store.nextOnCheck);
    return store.nextOnCheck;
  });
});

afterEach(() => {
  store.persistence = 'pending';
  store.siteBlocked = false;
  store.nextOnCheck = 'blocked';
  store.listeners.clear();
  store.checkAgain.mockReset();
  permission.request.mockClear();
  vi.restoreAllMocks();
});

describe('StorageGate passes through when storage is fine or still starting', () => {
  it.each<PortableStatePersistence>(['pending', 'opfs'])('renders the page while %s', (state) => {
    store.persistence = state;
    renderGate();
    expect(screen.getByText('dashboard chart')).toBeTruthy();
    expect(screen.queryByTestId('storage-blocked-notice')).toBeNull();
  });
});

describe('StorageGate blocks the app when on-device storage is refused', () => {
  it.each([
    ['storage-blocked', () => (store.persistence = 'blocked')],
    ['site-storage-blocked', () => (store.siteBlocked = true)],
  ])('shows the block screen, not the page (%s)', (reason, block) => {
    block();
    renderGate();
    const notice = screen.getByTestId('storage-blocked-notice');
    expect(notice.getAttribute('data-reason')).toBe(reason);
    expect(screen.queryByText('dashboard chart')).toBeNull();
    expect(screen.queryByTestId('ephemeral-storage-notice')).toBeNull();
  });

  it('says plainly that AlmaMesh needs permission and cannot run without it', () => {
    store.persistence = 'blocked';
    renderGate();
    const notice = screen.getByTestId('storage-blocked-notice');
    expect(notice.textContent).toContain(
      "AlmaMesh needs permission to store data on this device so SQLite can save your chart. Until you allow it, AlmaMesh (including Import and Export) can't run.",
    );
  });

  it('never claims AlmaMesh uses cookies or can open browser settings', () => {
    for (const browser of Object.keys(UA) as Browser[]) {
      pretendBrowser(browser);
      store.persistence = 'blocked';
      const { unmount } = renderGate();
      const text = screen.getByTestId('storage-blocked-notice').textContent ?? '';
      expect(text).not.toMatch(/(we|almamesh|this site|it) uses? cookies/i);
      expect(text).not.toMatch(/we('ll| will)? open (your )?(browser )?settings/i);
      unmount();
      vi.restoreAllMocks();
    }
  });

  it('moves focus to the headline so screen readers start there', () => {
    store.persistence = 'blocked';
    renderGate();
    const heading = screen.getByRole('heading', { level: 1 });
    expect(document.activeElement).toBe(heading);
    expect(heading.getAttribute('tabindex')).toBe('-1');
    expect(screen.getByTestId('storage-blocked-notice').getAttribute('role')).toBe('alert');
  });
});

describe('StorageGate shows only the steps for the browser in use', () => {
  it.each(Object.keys(UA) as Browser[])('%s', (browser) => {
    pretendBrowser(browser);
    store.persistence = 'blocked';
    renderGate();
    const steps = screen.getByTestId('storage-steps');
    expect(steps.getAttribute('data-browser')).toBe(browser);
    expect(steps.tagName).toBe('OL');
    const text = steps.textContent ?? '';
    for (const other of Object.keys(UA) as Browser[]) {
      if (other === browser) expect(text).toContain(SIGNATURE[other]);
      else expect(text).not.toContain(SIGNATURE[other]);
    }
    expect(text).toMatch(/Private|Incognito|private/);
  });

  it('names the Safari setting to switch off and draws it switched off', () => {
    pretendBrowser('safari-macos');
    store.persistence = 'blocked';
    renderGate();
    expect(screen.getByTestId('storage-steps').textContent).toContain('Block all cookies');
    const art = screen.getByRole('img', { name: /Block all cookies/ });
    expect(art.getAttribute('data-switch')).toBe('off');
  });

  it('draws an "Allow site data" switch turned on for other browsers', () => {
    pretendBrowser('chromium');
    store.persistence = 'blocked';
    renderGate();
    const art = screen.getByRole('img', { name: /Allow site data/ });
    expect(art.getAttribute('data-switch')).toBe('on');
  });
});

describe('StorageGate lets the user fix it in place', () => {
  it('Check again continues into the app without a reload once storage opens', async () => {
    const reload = vi.fn();
    vi.spyOn(window, 'location', 'get').mockReturnValue({ ...window.location, reload });
    store.persistence = 'blocked';
    store.nextOnCheck = 'opfs';
    renderGate();
    await act(async () => {
      fireEvent.click(screen.getByTestId('storage-check-again-button'));
    });
    expect(store.checkAgain).toHaveBeenCalledTimes(1);
    expect(screen.getByText('dashboard chart')).toBeTruthy();
    expect(screen.queryByTestId('storage-blocked-notice')).toBeNull();
    expect(reload).not.toHaveBeenCalled();
  });

  it('Check again re-reads site storage, so a fixed Safari setting lets the app through', async () => {
    store.siteBlocked = true;
    store.persistence = 'blocked';
    store.nextOnCheck = 'opfs';
    store.checkAgain.mockImplementation(async () => {
      store.siteBlocked = false;
      setPersistence('opfs');
      return 'opfs';
    });
    renderGate();
    await act(async () => {
      fireEvent.click(screen.getByTestId('storage-check-again-button'));
    });
    expect(screen.getByText('dashboard chart')).toBeTruthy();
  });

  it('says "Still blocked" when the browser still refuses', async () => {
    store.persistence = 'blocked';
    store.nextOnCheck = 'blocked';
    renderGate();
    await act(async () => {
      fireEvent.click(screen.getByTestId('storage-check-again-button'));
    });
    expect(screen.getByTestId('storage-still-blocked').textContent).toContain('Still blocked');
    expect(screen.queryByText('dashboard chart')).toBeNull();
  });

  // A recheck that finds storage allowed while SQLite is still opening resolves
  // 'pending'. That is not "still blocked": if a later open is refused again,
  // the screen must come back without a stale "Still blocked" from this check.
  it('a recheck that resolves pending is not reported as still blocked', async () => {
    store.persistence = 'blocked';
    store.nextOnCheck = 'pending';
    renderGate();
    await act(async () => {
      fireEvent.click(screen.getByTestId('storage-check-again-button'));
    });
    expect(screen.getByText('dashboard chart')).toBeTruthy();
    act(() => setPersistence('blocked'));
    expect(screen.getByTestId('storage-blocked-notice')).toBeTruthy();
    expect(screen.queryByTestId('storage-still-blocked')).toBeNull();
  });

  it('shows a busy state while checking', async () => {
    store.persistence = 'blocked';
    let finish: (value: PortableStatePersistence) => void = () => undefined;
    store.checkAgain.mockImplementation(
      () => new Promise<PortableStatePersistence>((resolve) => (finish = resolve)),
    );
    renderGate();
    const button = screen.getByTestId('storage-check-again-button') as HTMLButtonElement;
    await act(async () => {
      fireEvent.click(button);
    });
    expect(button.disabled).toBe(true);
    expect(button.getAttribute('aria-busy')).toBe('true');
    expect(button.textContent).toContain('Checking');
    await act(async () => finish('blocked'));
    expect(button.disabled).toBe(false);
  });

  it('Allow storage asks the browser to persist storage, then checks again', async () => {
    const order: string[] = [];
    permission.request.mockImplementation(async () => {
      order.push('persist');
      return true;
    });
    store.checkAgain.mockImplementation(async () => {
      order.push('check');
      setPersistence('opfs');
      return 'opfs';
    });
    store.persistence = 'blocked';
    renderGate();
    const allow = screen.getByTestId('storage-allow-button');
    expect(allow.tagName).toBe('BUTTON');
    await act(async () => {
      fireEvent.click(allow);
    });
    expect(order).toEqual(['persist', 'check']);
    expect(screen.getByText('dashboard chart')).toBeTruthy();
  });
});

describe('StorageGate when SQLite cannot run at all', () => {
  it('shows the distinct unavailable card instead of hanging', () => {
    store.persistence = 'unavailable';
    renderGate();
    const notice = screen.getByTestId('storage-blocked-notice');
    expect(notice.getAttribute('data-reason')).toBe('database-unavailable');
    expect(notice.textContent).toContain('cannot start its on-device database');
    expect(screen.queryByTestId('storage-steps')).toBeNull();
    expect(screen.queryByText('dashboard chart')).toBeNull();
  });
});

describe('storage copy in every language', () => {
  it('has no in-memory "not saving your data" notice left', async () => {
    for (const lang of ['en', 'es', 'pt']) {
      const catalog = (await import(`../../locales/${lang}/common.json`)).default as Record<string, unknown>;
      expect(catalog.storage_ephemeral).toBeUndefined();
    }
  });
});
