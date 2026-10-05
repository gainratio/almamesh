import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

import { SetAsideRestoreError, useProfilesStore, type HeldSetAsideRecord } from '@almamesh/store';

import '../../../../i18n/config';
import { SetAsideRecords, type SetAsideApi } from '../SetAsideRecords';

const EVENTS: HeldSetAsideRecord = {
  key: 'gone/almamesh-life-events/abc',
  row: 'almamesh-life-events',
  personId: 'gone',
  setAsideAt: '2026-10-05T12:00:00.000Z',
  itemCount: 2,
  preview: ['Married Ana', 'Moved to Lisbon'],
};

const CHECK: HeldSetAsideRecord = {
  key: 'gone/almamesh-rectification-records/def',
  row: 'almamesh-rectification-records',
  personId: 'gone',
  setAsideAt: '2026-10-05T12:00:00.000Z',
  itemCount: 1,
  preview: ['10:00 → 10:12'],
};

function api(records: HeldSetAsideRecord[]): SetAsideApi & { held: HeldSetAsideRecord[] } {
  const held = [...records];
  return {
    held,
    list: vi.fn(async () => [...held]),
    restore: vi.fn(async (key: string) => {
      held.splice(held.findIndex((record) => record.key === key), 1);
    }),
    remove: vi.fn(async (key: string) => {
      held.splice(held.findIndex((record) => record.key === key), 1);
    }),
  };
}

beforeEach(() => {
  useProfilesStore.setState({
    profiles: {
      p1: { id: 'p1', name: 'Maria' },
      p2: { id: 'p2', name: 'João' },
    },
    activeProfileId: 'p1',
  } as never);
});

describe('SetAsideRecords (Settings → Backup & Restore)', () => {
  it('renders nothing when nothing is set aside', async () => {
    const fake = api([]);
    render(<SetAsideRecords api={fake} />);
    await waitFor(() => expect(fake.list).toHaveBeenCalled());
    expect(screen.queryByTestId('set-aside-records')).toBeNull();
  });

  it('lists each set-aside record in plain words with the no-expiry policy', async () => {
    render(<SetAsideRecords api={api([EVENTS, CHECK])} />);

    const panel = await screen.findByTestId('set-aside-records');
    expect(panel.textContent).toContain('2 life events');
    expect(panel.textContent).toContain('Married Ana');
    expect(panel.textContent).toContain('A birth-time check');
    expect(panel.textContent).toContain('until you restore or delete them');
    expect(panel.textContent).toContain('not included in backups');
  });

  it('restores a record onto the chosen person and says so', async () => {
    const fake = api([EVENTS]);
    render(<SetAsideRecords api={fake} />);

    const select = await screen.findByTestId(`set-aside-target-${EVENTS.key}`);
    fireEvent.change(select, { target: { value: 'p2' } });
    fireEvent.click(screen.getByTestId(`set-aside-restore-${EVENTS.key}`));

    await waitFor(() => expect(fake.restore).toHaveBeenCalledWith(EVENTS.key, 'p2'));
    expect((await screen.findByTestId('set-aside-status')).textContent).toContain('João');
    await waitFor(() => expect(screen.queryByTestId('set-aside-records')).toBeNull());
  });

  it('deletes only after a second, explicit confirmation', async () => {
    const fake = api([EVENTS]);
    render(<SetAsideRecords api={fake} />);

    fireEvent.click(await screen.findByTestId(`set-aside-delete-${EVENTS.key}`));
    expect(fake.remove).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId(`set-aside-delete-confirm-${EVENTS.key}`));

    await waitFor(() => expect(fake.remove).toHaveBeenCalledWith(EVENTS.key));
  });

  it('explains a refused restore and keeps the record listed', async () => {
    const fake = api([CHECK]);
    fake.restore = vi.fn(async () => {
      throw new SetAsideRestoreError('has_record');
    });
    render(<SetAsideRecords api={fake} />);

    fireEvent.click(await screen.findByTestId(`set-aside-restore-${CHECK.key}`));

    expect((await screen.findByTestId('set-aside-error')).textContent).toContain(
      'already has a birth-time check',
    );
    expect(screen.getByTestId('set-aside-records')).toBeTruthy();
  });
});
