import { describe, it, expect, vi, afterEach } from 'vitest';

import { searchCities } from './cityLookup';
import { installCityTestDatabase } from './__tests__/cityTestDb';

installCityTestDatabase();

const CHENNAI_ONLINE = {
  name: 'Chennai',
  latitude: 13.08784,
  longitude: 80.27847,
  country: 'India',
  country_code: 'IN',
  admin1: 'Tamil Nadu',
  timezone: 'Asia/Kolkata',
  population: 4646732,
  feature_code: 'PPLA',
};

function stubOnline(navigatorOnLine = true) {
  vi.stubGlobal('navigator', { onLine: navigatorOnLine });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('searchCities (online-primary + offline fallback)', () => {
  it('uses the online geocoder when reachable (result carries admin1 -> state)', async () => {
    stubOnline(true);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 200, json: () => Promise.resolve({ results: [CHENNAI_ONLINE] }) }));
    const results = await searchCities('chennai');
    expect(results[0].city).toBe('Chennai');
    expect(results[0].state).toBe('Tamil Nadu'); // only the online path supplies admin1
  });

  it('falls back to the bundled offline list when the online request fails', async () => {
    stubOnline(true);
    const fetchMock = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'));
    vi.stubGlobal('fetch', fetchMock);
    const results = await searchCities('Chennai');
    expect(fetchMock).toHaveBeenCalled(); // it tried online first
    expect(results.length).toBeGreaterThan(0); // then resolved offline
    expect(results.some((r) => r.city === 'Chennai')).toBe(true);
    expect(results[0].timezone).toBeTruthy(); // offline still resolves an IANA zone
  });

  it('skips the network entirely and uses the offline list when navigator is offline', async () => {
    stubOnline(false);
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const results = await searchCities('Chennai');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(results.some((r) => r.city === 'Chennai')).toBe(true);
  });

  it('returns [] for queries under two chars without any network call', async () => {
    stubOnline(true);
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    expect(await searchCities('a')).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns an empty online result as-is (no silent offline fallback on a valid empty response)', async () => {
    stubOnline(true);
    // The offline list HAS Chennai; the online geocoder authoritatively says none.
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, status: 200, json: () => Promise.resolve({ results: [] }) }),
    );
    // Online is primary + authoritative — an empty result must NOT fall back to
    // the offline list (that would resurface a stale/inconsistent match).
    expect(await searchCities('Chennai')).toEqual([]);
  });

  it('propagates a caller abort without falling back to the offline list', async () => {
    stubOnline(true);
    const controller = new AbortController();
    controller.abort();
    vi.stubGlobal(
      'fetch',
      vi.fn((_url: string, init: { signal: AbortSignal }) =>
        init.signal.aborted
          ? Promise.reject(new DOMException('aborted', 'AbortError'))
          : Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ results: [] }) }),
      ),
    );
    // A superseded keystroke aborts — must reject (caller bails), NOT quietly
    // run an offline search and surface stale results.
    await expect(searchCities('Chennai', 8, { signal: controller.signal })).rejects.toThrow();
  });

  it('reads a spaced state Open-Meteo cannot ("novato california") from the bundled list', async () => {
    stubOnline(true);
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, json: () => Promise.resolve({ results: [] }) });
    vi.stubGlobal('fetch', fetchMock);
    const [top] = await searchCities('novato california');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(top.displayName).toBe('Novato, California, United States');
    expect(top.timezone).toBe('America/Los_Angeles');
  });

  it('keeps only online places whose state or country the qualifier names', async () => {
    stubOnline(true);
    const springfield = (admin1: string, timezone: string, population: number) => ({
      name: 'Springfield', latitude: 39.8, longitude: -89.6, country: 'United States', country_code: 'US',
      admin1, timezone, population, feature_code: 'PPLA',
    });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 200, json: () => Promise.resolve({ results: [
      springfield('Missouri', 'America/Chicago', 166_810), springfield('Illinois', 'America/Chicago', 116_565),
    ] }) }));
    const results = await searchCities('Springfield, IL');
    expect(results.map((r) => r.displayName)).toEqual(['Springfield, Illinois, United States']);
  });

  it('labels online places like the bundled list: a state that restates the city is dropped', async () => {
    stubOnline(true);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 200, json: () => Promise.resolve({ results: [{
      name: 'Bogotá', latitude: 4.6, longitude: -74.08, country: 'Colombia', country_code: 'CO',
      admin1: 'Bogota D.C.', timezone: 'America/Bogota', population: 7_674_366, feature_code: 'PPLC',
    }] }) }));
    expect((await searchCities('Bogotá'))[0].displayName).toBe('Bogotá, Colombia');
  });
});
