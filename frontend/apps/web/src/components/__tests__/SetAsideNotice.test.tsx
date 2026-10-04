import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const setAside = vi.hoisted(() => ({ value: false }));
vi.mock('@almamesh/store', () => ({ interpretationsWereSetAside: () => setAside.value }));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

import { SetAsideNotice } from '../SetAsideNotice';

describe('SetAsideNotice', () => {
  beforeEach(() => {
    setAside.value = false;
  });

  it('renders nothing on a normal boot', () => {
    const { container } = render(<SetAsideNotice />);
    expect(container.innerHTML).toBe('');
  });

  it('tells the user, without blocking the app, that unreadable interpretations were set aside', () => {
    setAside.value = true;
    render(<SetAsideNotice />);
    expect(screen.getByRole('status').textContent).toContain('storage.interpretations_set_aside');
  });

  it('can be dismissed', async () => {
    setAside.value = true;
    render(<SetAsideNotice />);
    await userEvent.click(screen.getByRole('button', { name: 'storage.dismiss_aria' }));
    expect(screen.queryByRole('status')).toBeNull();
  });
});
