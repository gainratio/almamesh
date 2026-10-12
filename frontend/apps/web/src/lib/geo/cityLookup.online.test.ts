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
});
