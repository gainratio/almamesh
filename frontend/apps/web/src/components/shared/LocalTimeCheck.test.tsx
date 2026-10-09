/**
 * LocalTimeCheck — daylight-saving edges are shown to the user, never silently
 * resolved. A spring-forward gap time is refused with an explanation; a
 * fall-back time that happened twice asks which occurrence, offering both with
 * their UTC offsets; an ordinary time renders nothing.
 */
import '../../i18n/config';
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { LocalTimeCheck } from './LocalTimeCheck';

const LA = 'America/Los_Angeles';

describe('LocalTimeCheck', () => {
  it('explains that a spring-forward gap time did not exist', () => {
    render(<LocalTimeCheck date="2024-03-10" time="02:30" timeZone={LA} onFoldChange={vi.fn()} />);
    const notice = screen.getByTestId('dst-gap-notice');
    expect(notice.getAttribute('role')).toBe('alert');
    expect(notice.textContent).toMatch(/02:30/);
    expect(notice.textContent).toMatch(/did not exist/i);
  });

  it('asks which occurrence of a repeated hour, showing both offsets', async () => {
    const onFoldChange = vi.fn();
    const user = userEvent.setup();
    render(<LocalTimeCheck date="2024-11-03" time="01:30" timeZone={LA} onFoldChange={onFoldChange} />);
    const earlier = screen.getByRole<HTMLInputElement>('radio', { name: /first.*UTC−07:00/i });
    const later = screen.getByRole<HTMLInputElement>('radio', { name: /second.*UTC−08:00/i });
    expect(earlier.checked).toBe(false);
    expect(later.checked).toBe(false);
    await user.click(later);
    expect(onFoldChange).toHaveBeenCalledWith('later');
  });

  it('marks the chosen occurrence', () => {
    render(
      <LocalTimeCheck date="2024-11-03" time="01:30" timeZone={LA} fold="earlier" onFoldChange={vi.fn()} />,
    );
    expect(screen.getByRole<HTMLInputElement>('radio', { name: /first/i }).checked).toBe(true);
  });

  it('renders nothing for an ordinary time', () => {
    const { container } = render(
      <LocalTimeCheck date="2024-01-10" time="00:30" timeZone="Australia/Sydney" onFoldChange={vi.fn()} />,
    );
    expect(container.innerHTML).toBe('');
  });
});
