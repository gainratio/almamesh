/**
 * StorageGate: when the browser refuses site storage (Safari "Block all
 * cookies" makes the localStorage getter throw SecurityError), the app routes
 * that need on-device storage must explain why instead of rendering blank or
 * hanging on "Loading Your Chart".
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { PortableStatePersistence } from '@almamesh/store';

const persistence = vi.hoisted(() => ({
  current: 'pending' as PortableStatePersistence,
  listeners: new Set<() => void>(),
}));

vi.mock('@almamesh/store', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@almamesh/store')>()),
  portableStatePersistence: () => persistence.current,
  subscribePortableStatePersistence: (listener: () => void) => {
    persistence.listeners.add(listener);
    return () => persistence.listeners.delete(listener);
  },
}));

function setPersistence(next: PortableStatePersistence): void {
  persistence.current = next;
  for (const listener of persistence.listeners) listener();
}

import '../../i18n/config';
import { StorageGate } from '../StorageGate';

const realDescriptor = Object.getOwnPropertyDescriptor(window, 'localStorage');

function blockSiteStorage(): void {
  Object.defineProperty(window, 'localStorage', {
    configurable: true,
    get() {
      throw new DOMException('The operation is insecure.', 'SecurityError');
    },
  });
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    get() {
      throw new DOMException('The operation is insecure.', 'SecurityError');
    },
  });
}

afterEach(() => {
  persistence.current = 'pending';
  if (realDescriptor) {
    Object.defineProperty(window, 'localStorage', realDescriptor);
    Object.defineProperty(globalThis, 'localStorage', realDescriptor);
  }
});

describe('StorageGate', () => {
  it('renders the page when the browser allows site storage', () => {
    render(
      <StorageGate>
        <p>onboarding form</p>
      </StorageGate>,
    );
    expect(screen.getByText('onboarding form')).toBeTruthy();
    expect(screen.queryByTestId('storage-blocked-notice')).toBeNull();
  });

  it('explains blocked storage, and how to allow it, instead of the page', () => {
    blockSiteStorage();
    render(
      <StorageGate>
        <p>onboarding form</p>
      </StorageGate>,
    );
    const notice = screen.getByTestId('storage-blocked-notice');
    expect(notice.getAttribute('role')).toBe('alert');
    expect(notice.textContent).toContain('Your browser is blocking site storage');
    expect(notice.textContent).toContain('Block all cookies');
    expect(screen.queryByText('onboarding form')).toBeNull();
  });

  it('keeps the page and adds a "won\'t be saved, export it" note when OPFS fell back to memory', () => {
    render(
      <MemoryRouter>
        <StorageGate>
          <p>dashboard chart</p>
        </StorageGate>
      </MemoryRouter>,
    );
    expect(screen.queryByTestId('ephemeral-storage-notice')).toBeNull();
    act(() => setPersistence('memory'));
    expect(screen.getByText('dashboard chart')).toBeTruthy();
    const note = screen.getByTestId('ephemeral-storage-notice');
    expect(note.getAttribute('role')).toBe('status');
    expect(note.getAttribute('data-durability')).toBe('memory');
    expect(note.textContent).toContain('This browser is not saving your data');
    // A reload loses it too, not only closing the tab (WebKit audit 2026-10-04).
    expect(note.textContent).toContain('reload or close this tab');
    expect(note.textContent).toContain('Export a backup');
    expect(note.querySelector('a')?.getAttribute('href')).toBe('/settings/data');
  });

  it('says the chart engine is not kept either, so a reload needs a connection (OPFS refused)', () => {
    render(
      <MemoryRouter>
        <StorageGate>
          <p>dashboard chart</p>
        </StorageGate>
      </MemoryRouter>,
    );
    act(() => setPersistence('memory'));
    const note = screen.getByTestId('ephemeral-storage-notice');
    expect(note.textContent).toContain('The chart engine download is not kept either');
    expect(note.textContent).toContain('needs an internet connection');
  });

  it('says the same about the engine in Spanish and Portuguese', async () => {
    const es = (await import('../../locales/es/common.json')).default.storage_ephemeral;
    const pt = (await import('../../locales/pt/common.json')).default.storage_ephemeral;
    expect(es.engine).toMatch(/motor/i);
    expect(es.engine).toMatch(/conexión a internet/i);
    expect(pt.engine).toMatch(/motor/i);
    expect(pt.engine).toMatch(/conexão com a internet/i);
  });

  it('explains, instead of hanging, when no on-device database can start at all', () => {
    setPersistence('unavailable');
    render(
      <MemoryRouter>
        <StorageGate>
          <p>dashboard chart</p>
        </StorageGate>
      </MemoryRouter>,
    );
    const notice = screen.getByTestId('storage-blocked-notice');
    expect(notice.getAttribute('data-reason')).toBe('database-unavailable');
    expect(notice.textContent).toContain('cannot start its on-device database');
    expect(screen.queryByText('dashboard chart')).toBeNull();
  });
});
