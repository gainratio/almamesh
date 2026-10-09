import { afterEach, describe, expect, it, vi } from 'vitest';

import { lookupPlaceOffline, placeFromRef, PLACE_CANDIDATE_LIMIT } from './placeLookup';

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
      expect(result.place.summary.label).toBe('Bogotá, Colombia');
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

  it('gives every ambiguous candidate a unique label, with no coordinates in it', async () => {
    const result = await lookupPlaceOffline('Springfield');
    expect(result.status).toBe('ambiguous');
    if (result.status !== 'ambiguous') return;
    const labels = result.candidates.map((candidate) => candidate.summary.label);
    expect(new Set(labels).size).toBe(labels.length);
    for (const candidate of result.candidates) {
      expect(candidate.summary.label).toContain('Springfield, United States');
      expect(candidate.summary.label).not.toContain(String(candidate.latitude));
      expect(candidate.summary.label).not.toContain(String(candidate.longitude));
    }
  });

  it('separates same-zone duplicates by population rank', async () => {
    const result = await lookupPlaceOffline('Springfield');
    if (result.status !== 'ambiguous') throw new Error('expected ambiguous');
    const chicago = result.candidates.filter((c) => c.summary.timezone === 'America/Chicago');
    expect(chicago.length).toBeGreaterThan(1);
    expect(chicago[0]?.summary.label).toBe('Springfield, United States, America/Chicago (1)');
    expect(chicago[1]?.summary.label).toBe('Springfield, United States, America/Chicago (2)');
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
