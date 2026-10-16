import { afterEach, describe, expect, it } from 'vitest';

import type { ResolvedPlace } from '../geo/placeLookup';
import { askToPickPlace, mountPlacePicker, NO_PLACE_PICKER, pendingPlacePick, subscribePlacePick } from '../placePick';

const ILLINOIS: ResolvedPlace = {
  summary: { place_ref: 'city:3823', label: 'Springfield, Illinois, United States', timezone: 'America/Chicago' },
  latitude: 39.8, longitude: -89.64, region: 'Illinois, United States',
};
const MISSOURI: ResolvedPlace = {
  summary: { place_ref: 'city:2602', label: 'Springfield, Missouri, United States', timezone: 'America/Chicago' },
  latitude: 37.2, longitude: -93.3, region: 'Missouri, United States',
};

let unmount: (() => void) | undefined;
afterEach(() => { unmount?.(); unmount = undefined; });

describe('placePick: the chat waits for the person to pick a place', () => {
  it('answers at once that nobody can pick when no picker is on screen', async () => {
    expect(await askToPickPlace('Springfield', [ILLINOIS, MISSOURI], new AbortController().signal)).toBe(NO_PLACE_PICKER);
    expect(pendingPlacePick()).toBeUndefined();
  });

  it('shows the request to the mounted picker and resolves with the pick', async () => {
    unmount = mountPlacePicker();
    let seen = 0;
    const stop = subscribePlacePick(() => { seen += 1; });
    const answer = askToPickPlace('Springfield', [ILLINOIS, MISSOURI], new AbortController().signal);
    const request = pendingPlacePick();
    expect(request?.query).toBe('Springfield');
    expect(request?.candidates).toEqual([ILLINOIS, MISSOURI]);
    request?.answer(ILLINOIS);
    expect(await answer).toBe(ILLINOIS);
    expect(pendingPlacePick()).toBeUndefined();
    expect(seen).toBe(2);
    stop();
  });

  it('resolves with no place when the person cancels', async () => {
    unmount = mountPlacePicker();
    const answer = askToPickPlace('Springfield', [ILLINOIS, MISSOURI], new AbortController().signal);
    pendingPlacePick()?.answer(undefined);
    expect(await answer).toBeUndefined();
  });

  it('closes the picker when the chat stops or the tool times out', async () => {
    unmount = mountPlacePicker();
    const controller = new AbortController();
    const answer = askToPickPlace('Springfield', [ILLINOIS, MISSOURI], controller.signal);
    controller.abort();
    expect(await answer).toBeUndefined();
    expect(pendingPlacePick()).toBeUndefined();
  });

  it('a late answer to a closed request changes nothing', async () => {
    unmount = mountPlacePicker();
    const first = askToPickPlace('Springfield', [ILLINOIS], new AbortController().signal);
    const stale = pendingPlacePick();
    const second = askToPickPlace('Portland', [MISSOURI], new AbortController().signal);
    expect(await first).toBeUndefined();
    stale?.answer(ILLINOIS);
    expect(pendingPlacePick()?.query).toBe('Portland');
    pendingPlacePick()?.answer(MISSOURI);
    expect(await second).toBe(MISSOURI);
  });

  it('a picker that unmounts cancels what it was showing', async () => {
    unmount = mountPlacePicker();
    const answer = askToPickPlace('Springfield', [ILLINOIS], new AbortController().signal);
    unmount();
    unmount = undefined;
    expect(await answer).toBeUndefined();
    expect(await askToPickPlace('Springfield', [ILLINOIS], new AbortController().signal)).toBe(NO_PLACE_PICKER);
  });
});
