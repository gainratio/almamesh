/**
 * "Where do you live now?" — one optional place per person. Empty means the app
 * behaves as before (zone only); it is never derived from the birthplace.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { createStore } from 'zustand/vanilla';

import { getCurrentPlace, type CurrentPlace } from './currentPlace';
import { profilesStoreCreator, type Profile, type ProfilesStore } from './profiles';

const NOVATO: CurrentPlace = {
  label: 'Novato, California, United States',
  timezone: 'America/Los_Angeles',
  latitude: 38.10742,
  longitude: -122.5697,
};

function person(extra: Partial<Profile> = {}): Profile {
  return { id: 'p1', name: 'Ada', createdAt: '2026-01-01T00:00:00.000Z', avatarTint: '#C9A24B', ...extra };
}

describe('getCurrentPlace', () => {
  it('is undefined with no profile, and for a profile that never set one', () => {
    expect(getCurrentPlace(undefined)).toBeUndefined();
    expect(getCurrentPlace(person())).toBeUndefined();
  });

  it('returns the label, coordinates and IANA zone the person set', () => {
    expect(getCurrentPlace(person({ currentPlace: NOVATO }))).toEqual(NOVATO);
  });

  it.each([
    ['an empty label', { ...NOVATO, label: '  ' }],
    ['a 121-character label', { ...NOVATO, label: 'x'.repeat(121) }],
    ['an unknown zone', { ...NOVATO, timezone: 'Mars/Olympus_Mons' }],
    ['an empty zone', { ...NOVATO, timezone: '' }],
    ['latitude past the pole', { ...NOVATO, latitude: 90.5 }],
    ['longitude past the antimeridian', { ...NOVATO, longitude: -180.5 }],
    ['a NaN latitude', { ...NOVATO, latitude: Number.NaN }],
    ['a string latitude', { ...NOVATO, latitude: '38.1' }],
    ['an extra field', { ...NOVATO, street: '1 Main St' }],
  ])('ignores a stored place with %s (a hand-edited or corrupt backup)', (_why, bad) => {
    expect(getCurrentPlace(person({ currentPlace: bad as unknown as CurrentPlace }))).toBeUndefined();
  });

  it('keeps a 120-character label and the exact poles', () => {
    const edge = { ...NOVATO, label: 'x'.repeat(120), latitude: -90, longitude: 180 };
    expect(getCurrentPlace(person({ currentPlace: edge }))).toEqual(edge);
  });
});

describe('profilesStore.setCurrentPlace', () => {
  let store: ReturnType<typeof createStore<ProfilesStore>>;
  let id: string;

  beforeEach(() => {
    store = createStore<ProfilesStore>(profilesStoreCreator);
    id = store.getState().createProfile('Ada');
  });

  it('a new person has no current place, so nothing assumes the birthplace', () => {
    expect(store.getState().profiles[id]?.currentPlace).toBeUndefined();
    expect(getCurrentPlace(store.getState().profiles[id])).toBeUndefined();
  });

  it('sets it once and getCurrentPlace returns it', () => {
    expect(store.getState().setCurrentPlace(id, NOVATO)).toEqual({ ok: true });
    expect(getCurrentPlace(store.getState().profiles[id])).toEqual(NOVATO);
  });

  it('clearing removes the field entirely', () => {
    store.getState().setCurrentPlace(id, NOVATO);
    expect(store.getState().setCurrentPlace(id, undefined)).toEqual({ ok: true });
    expect('currentPlace' in (store.getState().profiles[id] ?? {})).toBe(false);
  });

  it('refuses an invalid place and keeps the old one', () => {
    store.getState().setCurrentPlace(id, NOVATO);
    const result = store.getState().setCurrentPlace(id, { ...NOVATO, timezone: 'Not/AZone' });
    expect(result).toEqual({ ok: false, reason: 'invalid-place' });
    expect(getCurrentPlace(store.getState().profiles[id])).toEqual(NOVATO);
  });

  it('refuses a place whose label is not text (a hand-built call)', () => {
    const result = store.getState().setCurrentPlace(id, { ...NOVATO, label: 42 as unknown as string });
    expect(result).toEqual({ ok: false, reason: 'invalid-place' });
    expect(store.getState().profiles[id]?.currentPlace).toBeUndefined();
  });

  it('refuses an unknown person', () => {
    expect(store.getState().setCurrentPlace('ghost', NOVATO)).toEqual({ ok: false, reason: 'not-found' });
    expect(store.getState().profiles.ghost).toBeUndefined();
  });

  it('touches only that person, and survives a rename', () => {
    const other = store.getState().createProfile('Bo');
    store.getState().setCurrentPlace(id, NOVATO);
    store.getState().renameProfile(id, 'Ada L.');
    expect(getCurrentPlace(store.getState().profiles[id])).toEqual(NOVATO);
    expect(store.getState().profiles[other]?.currentPlace).toBeUndefined();
  });

  it('stores only the four place fields, trimmed', () => {
    const noisy = { ...NOVATO, label: '  Novato, California, United States ' };
    store.getState().setCurrentPlace(id, noisy);
    expect(store.getState().profiles[id]?.currentPlace).toEqual(NOVATO);
  });
});
