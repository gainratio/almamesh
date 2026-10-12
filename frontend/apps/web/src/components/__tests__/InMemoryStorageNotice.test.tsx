/**
 * OPFS refused (Safari Private Browsing): the app runs on SQLite in memory.
 * Say plainly that nothing is kept after this tab, and where to export.
 */
import { act, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

const store = vi.hoisted(() => ({
  persistence: 'pending' as string,
  listeners: new Set<() => void>(),
}));
vi.mock('@almamesh/store', () => ({
  getInitialLanguage: () => 'en',
  portableStatePersistence: () => store.persistence,
  subscribePortableStatePersistence: (listener: () => void) => {
    store.listeners.add(listener);
    return () => store.listeners.delete(listener);
  },
}));

import i18n from '../../i18n/config';
import { InMemoryStorageNotice } from '../InMemoryStorageNotice';

function publish(next: string): void {
  store.persistence = next;
  for (const listener of store.listeners) listener();
}

function renderNotice() {
  return render(
    <MemoryRouter>
      <InMemoryStorageNotice />
    </MemoryRouter>,
  );
}

afterEach(async () => {
  store.persistence = 'pending';
  store.listeners.clear();
  await i18n.changeLanguage('en');
});

describe('InMemoryStorageNotice', () => {
  it('says data is not saved and links to export when SQLite runs in memory', () => {
    store.persistence = 'memory';
    renderNotice();
    const notice = screen.getByTestId('in-memory-storage-notice');
    expect(notice.getAttribute('role')).toBe('status');
    expect(notice.textContent).toContain('This browser is not saving your data.');
    expect(notice.textContent).toContain('disappears when you close or reload this tab');
    expect(screen.getByRole('link', { name: 'Export a backup to keep it.' }).getAttribute('href')).toBe('/settings/data');
  });

  it('renders nothing for durable, pending, blocked, or unavailable storage', () => {
    for (const persistence of ['opfs', 'pending', 'blocked', 'unavailable']) {
      store.persistence = persistence;
      const view = renderNotice();
      expect(screen.queryByTestId('in-memory-storage-notice')).toBeNull();
      view.unmount();
    }
  });

  it('appears when persistence changes to memory after mount', () => {
    renderNotice();
    expect(screen.queryByTestId('in-memory-storage-notice')).toBeNull();
    act(() => publish('memory'));
    expect(screen.getByTestId('in-memory-storage-notice')).toBeTruthy();
  });

  it.each(['es', 'pt'])('is translated in %s', async (language) => {
    await i18n.changeLanguage(language);
    store.persistence = 'memory';
    renderNotice();
    const text = screen.getByTestId('in-memory-storage-notice').textContent ?? '';
    expect(text).not.toContain('storage_in_memory.');
    expect(text).not.toContain('This browser is not saving your data.');
  });
});
