/**
 * StorageGate: when the browser refuses site storage (Safari "Block all
 * cookies" makes the localStorage getter throw SecurityError), the app routes
 * that need on-device storage must explain why instead of rendering blank or
 * hanging on "Loading Your Chart".
 */
import { afterEach, describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';

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
});
