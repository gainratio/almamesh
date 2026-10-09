import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { act } from 'react';

import { reportDroppedWrite, resetDroppedWritesForTests } from '@almamesh/store';

import '../../../i18n/config';
import { DroppedWritesNotice } from './DroppedWritesNotice';

afterEach(() => {
  act(() => resetDroppedWritesForTests());
});

describe('DroppedWritesNotice', () => {
  it('renders nothing while every change has been saved', () => {
    render(<DroppedWritesNotice />);

    expect(screen.queryByTestId('dropped-writes-notice')).toBeNull();
  });

  it('tells the user a change was not saved and offers a reload', () => {
    const reload = vi.fn();
    render(<DroppedWritesNotice reload={reload} />);

    act(() => reportDroppedWrite('almamesh-profiles', 'dataset-busy'));

    const notice = screen.getByRole('alert');
    expect(notice.getAttribute('data-testid')).toBe('dropped-writes-notice');
    expect(notice.textContent).toContain("Some changes on this page weren't saved");
    fireEvent.click(screen.getByRole('button', { name: 'Reload' }));
    expect(reload).toHaveBeenCalledOnce();
  });

  it('says plainly when a cancelled person could not be removed, and offers to try again', () => {
    const retry = vi.fn().mockResolvedValue(undefined);
    const reload = vi.fn();
    render(<DroppedWritesNotice reload={reload} retryDiscards={retry} />);

    act(() => reportDroppedWrite('almamesh-profiles', 'discard-failed'));

    const notice = screen.getByTestId('discard-failed-notice');
    expect(notice.getAttribute('role')).toBe('alert');
    expect(notice.textContent).toContain("couldn't be removed from this device");
    // Reloading would bring the person back, so it is not offered here.
    expect(screen.queryByRole('button', { name: 'Reload' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(retry).toHaveBeenCalledOnce();
    expect(reload).not.toHaveBeenCalled();
  });
});
