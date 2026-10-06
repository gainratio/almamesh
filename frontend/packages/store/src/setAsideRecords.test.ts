import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { flushPortablePersistence, readCanonicalDatasetValue } from './deletionTombstones';
import { useLifeEventsStore } from './lifeEvents';
import { PortableMemoryStore } from './portableMemoryStore.testkit';
import { PortableStateRepository } from './portableState';
import { useProfilesStore } from './profiles';
import { useRectificationRecordsStore } from './rectificationRecords';
import {
  clearSetAsideRecords,
  deleteSetAsideRecord,
  listSetAsideRecords,
  restoreSetAsideRecord,
  SET_ASIDE_EXPIRY_POLICY,
  SetAsideRestoreError,
} from './setAsideRecords';

const EVENTS = [
  { id: 'e1', date: '2015-06-01', category: 'marriage', summary: 'Married Ana', precision: 'exact', createdAt: '2026-01-01T00:00:00.000Z' },
  { id: 'e2', date: '2019-02-01', category: 'relocation', summary: 'Moved to Lisbon', precision: 'exact', createdAt: '2026-01-02T00:00:00.000Z' },
];

const RECORD = {
  profileId: 'gone',
  confirmedAt: '2026-02-01T00:00:00.000Z',
  mode: 'cusp',
  band: 'clear',
  margin: 0.4,
  originalTime: '10:00',
  originalSign: 'Aries',
  rectifiedTime: '10:12',
  rectifiedSign: 'Taurus',
  supportingEventIds: ['e1'],
};

let repository: PortableStateRepository;

async function hold(row: 'almamesh-life-events' | 'almamesh-rectification-records', value: unknown) {
  await repository.holdSetAside(
    [{ row, personId: 'gone', value: JSON.stringify(value) }],
    '2026-10-05T12:00:00.000Z',
  );
  return [...(await repository.listSetAside()).keys()].find((key) => key.includes(row))!;
}

function addPerson(id: string, name: string): void {
  useProfilesStore.setState((state) => ({
    profiles: {
      ...state.profiles,
      [id]: { id, name, birth: { date: '1990-01-01', time: '10:00', place: 'Lisbon' } },
    },
  }) as never);
}

beforeEach(() => {
  repository = new PortableStateRepository(new PortableMemoryStore());
  useProfilesStore.setState({ profiles: {}, activeProfileId: null } as never);
  useLifeEventsStore.setState({ eventsByProfile: {} });
  useRectificationRecordsStore.setState({ recordsByProfile: {} });
});

afterEach(async () => {
  await flushPortablePersistence();
});

describe('set-aside records screen API', () => {
  it('lists each held record with its kind, size, date and a readable preview', async () => {
    await hold('almamesh-life-events', EVENTS);
    await hold('almamesh-rectification-records', RECORD);

    const listed = await listSetAsideRecords({ repository });

    expect(listed).toEqual([
      expect.objectContaining({
        row: 'almamesh-life-events',
        personId: 'gone',
        itemCount: 2,
        setAsideAt: '2026-10-05T12:00:00.000Z',
        preview: ['Married Ana', 'Moved to Lisbon'],
      }),
      expect.objectContaining({
        row: 'almamesh-rectification-records',
        itemCount: 1,
        preview: ['10:00 → 10:12'],
      }),
    ]);
  });

  it('restores life events onto a chosen person, keeps that person\'s own events, then releases the hold', async () => {
    addPerson('p1', 'Maria');
    useLifeEventsStore.setState({
      eventsByProfile: { p1: [{ id: 'own', date: '2001-01-01', createdAt: '2026-01-01T00:00:00.000Z' }] },
    });
    const key = await hold('almamesh-life-events', EVENTS);

    await restoreSetAsideRecord(key, 'p1', { repository });

    expect(useLifeEventsStore.getState().eventsByProfile.p1!.map((event) => event.id)).toEqual([
      'own',
      'e1',
      'e2',
    ]);
    const saved = JSON.parse((await readCanonicalDatasetValue('almamesh-life-events'))!) as {
      state: { eventsByProfile: Record<string, { id: string }[]> };
    };
    expect(saved.state.eventsByProfile.p1!.map((event) => event.id)).toEqual(['own', 'e1', 'e2']);
    expect((await repository.listSetAside()).size).toBe(0);
  });

  it('never duplicates an event that is already on the person (a restore retried after a crash)', async () => {
    addPerson('p1', 'Maria');
    useLifeEventsStore.setState({ eventsByProfile: { p1: [EVENTS[0]] as never } });
    const key = await hold('almamesh-life-events', EVENTS);

    await restoreSetAsideRecord(key, 'p1', { repository });

    expect(useLifeEventsStore.getState().eventsByProfile.p1!.map((event) => event.id)).toEqual(['e1', 'e2']);
  });

  it('migrates a record held from an older store version before restoring it', async () => {
    addPerson('p1', 'Maria');
    await repository.holdSetAside(
      [{ row: 'almamesh-life-events', personId: 'gone', value: JSON.stringify([{ id: 'old', description: 'Got a job', createdAt: 'x' }]), version: 1 }],
      '2026-10-05T12:00:00.000Z',
    );
    const [key] = [...(await repository.listSetAside()).keys()];

    await restoreSetAsideRecord(key!, 'p1', { repository });

    expect(useLifeEventsStore.getState().eventsByProfile.p1).toEqual([
      expect.objectContaining({ id: 'old', note: 'Got a job', needsStructuring: true, summary: 'Got a job' }),
    ]);
  });

  it('re-attaches a birth-time check to the chosen person', async () => {
    addPerson('p1', 'Maria');
    const key = await hold('almamesh-rectification-records', RECORD);

    await restoreSetAsideRecord(key, 'p1', { repository });

    expect(useRectificationRecordsStore.getState().recordsByProfile.p1).toMatchObject({
      ...RECORD,
      profileId: 'p1',
    });
    expect((await repository.listSetAside()).size).toBe(0);
  });

  it('refuses to overwrite a person\'s own birth-time check, and keeps the held one', async () => {
    addPerson('p1', 'Maria');
    useRectificationRecordsStore.setState({ recordsByProfile: { p1: { ...RECORD, profileId: 'p1', rectifiedTime: '09:00' } as never } });
    const key = await hold('almamesh-rectification-records', RECORD);

    await expect(restoreSetAsideRecord(key, 'p1', { repository })).rejects.toMatchObject({
      code: 'has_record',
    });
    expect(useRectificationRecordsStore.getState().recordsByProfile.p1!.rectifiedTime).toBe('09:00');
    expect((await repository.listSetAside()).size).toBe(1);
  });

  it('refuses a person who is not on this device', async () => {
    const key = await hold('almamesh-life-events', EVENTS);

    await expect(restoreSetAsideRecord(key, 'nobody', { repository })).rejects.toBeInstanceOf(
      SetAsideRestoreError,
    );
    expect((await repository.listSetAside()).size).toBe(1);
  });

  it('keeps the held copy when the restored data did not reach SQLite', async () => {
    addPerson('p1', 'Maria');
    const key = await hold('almamesh-life-events', EVENTS);

    await expect(
      restoreSetAsideRecord(key, 'p1', { repository, readSaved: async () => null }),
    ).rejects.toMatchObject({ code: 'not_saved' });
    expect((await repository.listSetAside()).size).toBe(1);
  });

  it('a birth-time check whose restore did not reach SQLite is rolled back, so a retry succeeds', async () => {
    addPerson('p1', 'Maria');
    const key = await hold('almamesh-rectification-records', RECORD);

    await expect(
      restoreSetAsideRecord(key, 'p1', { repository, readSaved: async () => null }),
    ).rejects.toMatchObject({ code: 'not_saved' });
    // Not saved means not shown: the in-memory attach is undone.
    expect(useRectificationRecordsStore.getState().recordsByProfile.p1).toBeUndefined();
    expect((await repository.listSetAside()).size).toBe(1);

    // The retry is not refused as `has_record` by the failed attempt's leftover.
    await restoreSetAsideRecord(key, 'p1', { repository });
    expect(useRectificationRecordsStore.getState().recordsByProfile.p1).toMatchObject({ profileId: 'p1' });
    expect((await repository.listSetAside()).size).toBe(0);
  });

  it('deletes one held record for good', async () => {
    const key = await hold('almamesh-life-events', EVENTS);
    await hold('almamesh-rectification-records', RECORD);

    await deleteSetAsideRecord(key, { repository });

    expect([...(await repository.listSetAside()).keys()]).not.toContain(key);
    expect((await repository.listSetAside()).size).toBe(1);
  });

  it('Start fresh clears every held record', async () => {
    await hold('almamesh-life-events', EVENTS);
    await hold('almamesh-rectification-records', RECORD);

    await clearSetAsideRecords({ repository });

    expect((await repository.listSetAside()).size).toBe(0);
  });

  it('states its expiry policy: none, records stay until the user acts', () => {
    expect(SET_ASIDE_EXPIRY_POLICY).toBe('never');
  });
});
