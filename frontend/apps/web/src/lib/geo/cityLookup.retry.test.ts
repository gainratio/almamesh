import { afterEach, describe, expect, it, vi } from 'vitest';

const ROW = { n: 'Bogota', c: 'Colombia', cc: 'CO', lat: 4.6, lon: -74.08, p: 7_000_000 };

afterEach(() => {
  vi.doUnmock('../../data/cities.min.json');
  vi.resetModules();
});

describe('city list load failure', () => {
  it('is not cached: a later lookup retries the import and succeeds', async () => {
    vi.resetModules();
    let reads = 0;
    vi.doMock('../../data/cities.min.json', () => ({
      get default() {
        reads += 1;
        if (reads === 1) throw new Error('chunk fetch failed');
        return [ROW];
      },
    }));
    const { searchCityRowsOffline } = await import('./cityLookup');
    await expect(searchCityRowsOffline('Bogota')).rejects.toThrow();

    const rows = await searchCityRowsOffline('Bogota');
    expect(rows.map((r) => r.match.city)).toEqual(['Bogota']);
  });
});
