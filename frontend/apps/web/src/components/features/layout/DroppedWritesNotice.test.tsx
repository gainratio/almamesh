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
});
