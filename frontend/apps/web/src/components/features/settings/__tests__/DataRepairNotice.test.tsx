import { afterEach, describe, expect, it } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { act } from 'react';

import { EMPTY_PORTABLE_REPAIR_REPORT } from '@almamesh/store';

import '../../../../i18n/config';
import { useDataRepairNotice } from '../../../../lib/dataRepairNotice';
import { DataRepairNotice } from '../DataRepairNotice';

afterEach(() => useDataRepairNotice.getState().dismiss());

describe('DataRepairNotice (boot self-heal, on screen)', () => {
  it('renders nothing until a boot repair is reported', () => {
    render(<DataRepairNotice />);
    expect(screen.queryByTestId('data-repair-notice')).toBeNull();
  });

  it('says what the boot repair changed, and can be dismissed', () => {
    render(<DataRepairNotice />);
    act(() =>
      useDataRepairNotice.getState().show({
        ...EMPTY_PORTABLE_REPAIR_REPORT,
        unlinkedChatThreadIds: ['t1'],
        setAside: [{ row: 'almamesh-life-events', personId: 'gone', value: '[]' }],
      }),
    );

    const notice = screen.getByTestId('data-repair-notice');
    expect(notice.textContent).toContain('AlmaMesh repaired your saved data');
    expect(notice.textContent).toContain('1 chat conversation was started on a chart that no longer exists.');
    expect(notice.textContent).toContain('It is set aside on this device, not deleted');

    fireEvent.click(screen.getByRole('button', { name: 'Got it' }));
    expect(screen.queryByTestId('data-repair-notice')).toBeNull();
  });

  it('renders nothing for a repair the user would not act on (a cleared link only)', () => {
    render(<DataRepairNotice />);
    act(() => useDataRepairNotice.getState().show({ ...EMPTY_PORTABLE_REPAIR_REPORT, clearedProfileLinks: ['p1'] }));
    expect(screen.queryByTestId('data-repair-notice')).toBeNull();
  });
});
