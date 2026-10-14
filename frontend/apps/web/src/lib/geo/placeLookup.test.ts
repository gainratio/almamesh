import { afterEach, describe, expect, it, vi } from 'vitest';

import { listPlacesOffline, lookupPlaceOffline, placeFromRef, PLACE_CANDIDATE_LIMIT, PLACE_SUGGESTION_LIMIT } from './placeLookup';
import { installCityTestDatabase } from './__tests__/cityTestDb';

installCityTestDatabase();

afterEach(() => vi.unstubAllGlobals());

function refOf(result: Awaited<ReturnType<typeof lookupPlaceOffline>>): string {
  if (result.status !== 'found') throw new Error(`expected found, got ${result.status}`);
  return result.place.summary.place_ref;
}

describe('lookupPlaceOffline', () => {
  it('finds Bogotá with or without the accent, in any case, with its zone', async () => {
    for (const query of ['Bogotá', 'bogota', 'BOGOTÁ']) {
      const result = await lookupPlaceOffline(query);
      expect(result.status).toBe('found');
      if (result.status !== 'found') return;
      expect(result.place.summary.label).toBe('Bogotá, Colombia'); // "Bogota D.C." only restates the city
      expect(result.place.summary.timezone).toBe('America/Bogota');
      expect(result.place.summary.place_ref).toMatch(/^city:\d{1,6}$/);
    }
  });

  it('finds Los Angeles by population dominance over Los Ángeles, Chile', async () => {
    const result = await lookupPlaceOffline('Los Angeles');
    expect(result.status).toBe('found');
    if (result.status === 'found') expect(result.place.summary.timezone).toBe('America/Los_Angeles');
  });

  it('honours a country qualifier', async () => {
    const result = await lookupPlaceOffline('Los Angeles, US');
    expect(result.status).toBe('found');
  });

  it('returns up to five candidates, each with its own ref, when the name is shared', async () => {
    const result = await lookupPlaceOffline('Springfield');
    expect(result.status).toBe('ambiguous');
    if (result.status !== 'ambiguous') return;
    expect(result.candidates.length).toBeGreaterThan(1);
    expect(result.candidates.length).toBeLessThanOrEqual(PLACE_CANDIDATE_LIMIT);
    const refs = result.candidates.map((candidate) => candidate.summary.place_ref);
    expect(new Set(refs).size).toBe(refs.length);
  });

  // Contract reversed (2026-10-14): candidates used to read "Springfield, United
  // States, America/Chicago (1)" because the bundled list had no state. They now
  // carry GeoNames' admin1 name, which is what a person recognises.
  it('names every ambiguous candidate by city, state and country, with no coordinates or zone', async () => {
    const result = await lookupPlaceOffline('Springfield');
    expect(result.status).toBe('ambiguous');
    if (result.status !== 'ambiguous') return;
    const labels = result.candidates.map((candidate) => candidate.summary.label);
    expect(new Set(labels).size).toBe(labels.length);
    expect(labels).toContain('Springfield, Illinois, United States');
    for (const candidate of result.candidates) {
      expect(candidate.summary.label).toMatch(/^Springfield, [A-Z][a-z]+, United States$/);
      expect(candidate.summary.label).not.toContain(candidate.summary.timezone);
      expect(candidate.summary.label).not.toContain(String(candidate.latitude));
    }
  });

  it('a state qualifier settles the place: "Springfield, IL" is found in America/Chicago', async () => {
    const result = await lookupPlaceOffline('Springfield, IL');
    expect(result.status).toBe('found');
    if (result.status !== 'found') return;
    expect(result.place.summary.label).toBe('Springfield, Illinois, United States');
    expect(result.place.summary.timezone).toBe('America/Chicago');
  });

  it('finds a place named with a spaced state ("springfield illinois") as one place', async () => {
    const result = await lookupPlaceOffline('springfield illinois');
    expect(result.status).toBe('found');
  });

  it('finds Novato, CA (Harish, 2019) with Los Angeles time', async () => {
    const result = await lookupPlaceOffline('novato, ca');
    expect(result.status).toBe('found');
    if (result.status !== 'found') return;
    expect(result.place.summary.label).toBe('Novato, California, United States');
    expect(result.place.summary.timezone).toBe('America/Los_Angeles');
    expect(result.place.latitude).toBeCloseTo(38.107, 2);
  });

  it('returns not_found for text that names no city', async () => {
    expect(await lookupPlaceOffline('Qwxzvbnm')).toEqual({ status: 'not_found' });
    expect(await lookupPlaceOffline('a')).toEqual({ status: 'not_found' });
  });

  it('never touches the network', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await lookupPlaceOffline('Bogotá');
    await placeFromRef('city:0');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('answers in under 100 ms once the list is loaded', async () => {
    await lookupPlaceOffline('Bogotá');
    const t0 = performance.now();
    await lookupPlaceOffline('São Paulo');
    expect(performance.now() - t0).toBeLessThan(100);
  });
});

describe('listPlacesOffline (the place boxes)', () => {
  it('lists every match, so a dominant Paris never hides Paris, Texas', async () => {
    const places = await listPlacesOffline('Paris');
    const labels = places.map((place) => place.summary.label);
    expect(labels[0]).toBe('Paris, Île-de-France, France');
    expect(labels).toContain('Paris, Texas, United States');
    expect(places.length).toBeLessThanOrEqual(PLACE_SUGGESTION_LIMIT);
    expect(PLACE_SUGGESTION_LIMIT).toBe(6);
  });

  it('splits each suggestion into the city and its muted region', async () => {
    const [novato] = await listPlacesOffline('novato, ca');
    expect(novato.region).toBe('California, United States');
    expect(novato.summary.label).toBe('Novato, California, United States');
    expect(novato.summary.timezone).toBe('America/Los_Angeles');
  });

  it('lists nothing for a qualifier that names no state or country', async () => {
    expect(await listPlacesOffline('Portland, ZZ')).toEqual([]);
  });
});

describe('placeFromRef', () => {
  it('round-trips a ref to the same label, zone and coordinates', async () => {
    const found = await lookupPlaceOffline('Bogotá');
    const back = await placeFromRef(refOf(found));
    expect(back).toEqual(found.status === 'found' ? found.place : undefined);
  });

  it.each(['city:99999999', 'city:-1', 'bogota', 'city:', 'city:1.5', ''])('refuses %s', async (ref) => {
    expect(await placeFromRef(ref)).toBeUndefined();
  });
});
