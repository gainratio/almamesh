import { describe, it, expect } from 'vitest';
import { searchCitiesOffline, timezoneForCoordinates } from './cityLookup';
import { installCityTestDatabase } from './__tests__/cityTestDb';

installCityTestDatabase();

describe('cityLookup (offline geocoder)', () => {
    it('resolves Chennai to its coordinates and IANA timezone', async () => {
        const results = await searchCitiesOffline('Chennai');
        const chennai = results.find((r) => r.city === 'Chennai');

        expect(chennai).toBeDefined();
        expect(chennai!.latitude).toBeCloseTo(13.08, 1);
        expect(chennai!.longitude).toBeCloseTo(80.27, 1);
        expect(chennai!.timezone).toBe('Asia/Kolkata');
        expect(chennai!.country).toBe('India');
        expect(chennai!.countryCode).toBe('IN');
    });

    it('resolves New York to America/New_York', async () => {
        const results = await searchCitiesOffline('New York');
        const ny = results.find((r) => r.countryCode === 'US' && r.city.startsWith('New York'));

        expect(ny).toBeDefined();
        expect(ny!.timezone).toBe('America/New_York');
        expect(ny!.latitude).toBeCloseTo(40.71, 1);
        expect(ny!.longitude).toBeCloseTo(-74.0, 1);
    });

    it('ranks the most populous match first for an exact-name query', async () => {
        const results = await searchCitiesOffline('London');
        expect(results.length).toBeGreaterThan(0);
        // London, GB (8M+) should outrank smaller Londons (e.g. Ontario, Ohio).
        expect(results[0].city).toBe('London');
        expect(results[0].countryCode).toBe('GB');
        expect(results[0].timezone).toBe('Europe/London');
    });

    it('returns no results for queries shorter than two characters', async () => {
        expect(await searchCitiesOffline('')).toEqual([]);
        expect(await searchCitiesOffline('a')).toEqual([]);
    });

    it('returns an empty list for a nonsense query (city-not-found)', async () => {
        const results = await searchCitiesOffline('zzzzzqqqqqxxxxx');
        expect(results).toEqual([]);
    });

    it('every result carries a non-empty IANA timezone', async () => {
        const results = await searchCitiesOffline('Tokyo');
        expect(results.length).toBeGreaterThan(0);
        for (const result of results) {
            expect(result.timezone).toMatch(/^[A-Za-z]+\/[A-Za-z_]+/);
        }
    });

    it('timezoneForCoordinates resolves lat/lon to an IANA zone offline', () => {
        expect(timezoneForCoordinates(13.08, 80.27)).toBe('Asia/Kolkata');
        expect(timezoneForCoordinates(35.68, 139.69)).toBe('Asia/Tokyo');
    });
});

describe('cityLookup — natural-language & diacritic matching', () => {
    // Every natural way a user types San Francisco must surface the real city
    // (United States, ~37.77, ~-122.42) as the FIRST result — including a
    // state qualifier ("CA" / "California") the dataset has no field for, and
    // country qualifiers ("USA" / "United States").
    const SF_QUERIES = [
        'San Francisco',
        'san francisco',
        'San Francisco, CA',
        'San Francisco California',
        'San Francisco, USA',
        'San Francisco, United States',
    ];

    it.each(SF_QUERIES)('surfaces San Francisco #1 for %j', async (query) => {
        const results = await searchCitiesOffline(query);
        expect(results.length).toBeGreaterThan(0);
        const top = results[0];
        expect(top.city).toBe('San Francisco');
        expect(top.country).toBe('United States');
        expect(top.countryCode).toBe('US');
        expect(top.latitude).toBeCloseTo(37.77, 1);
        expect(top.longitude).toBeCloseTo(-122.42, 1);
    });

    it('folds diacritics: "Sao Paulo" -> São Paulo, Brazil #1', async () => {
        const results = await searchCitiesOffline('Sao Paulo');
        expect(results[0].city).toBe('São Paulo');
        expect(results[0].country).toBe('Brazil');
    });

    it('folds diacritics: "Zurich" -> Zürich, Switzerland #1', async () => {
        const results = await searchCitiesOffline('Zurich');
        expect(results[0].city).toBe('Zürich');
        expect(results[0].country).toBe('Switzerland');
    });

    it('folds diacritics: "Bogota" -> Bogotá, Colombia #1', async () => {
        const results = await searchCitiesOffline('Bogota');
        expect(results[0].city).toBe('Bogotá');
        expect(results[0].country).toBe('Colombia');
    });

    it('does not over-match: a nonsense query returns nothing', async () => {
        expect(await searchCitiesOffline('Zzzznotacity')).toEqual([]);
    });

    it('honours the min-2-char gate (a single char returns nothing)', async () => {
        expect(await searchCitiesOffline('x')).toEqual([]);
    });

    it('a plain unqualified city still resolves: "Paris" -> Paris, France #1', async () => {
        const results = await searchCitiesOffline('Paris');
        expect(results[0].city).toBe('Paris');
        expect(results[0].country).toBe('France');
    });
});

describe('cityLookup — state-aware places (bundled GeoNames admin1)', () => {
    it.each(['novato, ca', 'Novato', 'novato california', 'Novato, CA, USA'])(
        '%j -> Novato, California, United States with its own zone',
        async (query) => {
            const [top] = await searchCitiesOffline(query);
            expect(top.displayName).toBe('Novato, California, United States');
            expect(top.state).toBe('California');
            expect(top.timezone).toBe('America/Los_Angeles');
            expect(top.latitude).toBeCloseTo(38.107, 2);
            expect(top.longitude).toBeCloseTo(-122.570, 2);
        },
    );

    it('lists every Springfield by state, most populous first', async () => {
        const results = await searchCitiesOffline('Springfield', 6);
        const labels = results.map((r) => r.displayName);
        expect(labels).toHaveLength(6);
        expect(new Set(labels).size).toBe(6);
        expect(labels).toContain('Springfield, Illinois, United States');
        const populations = results.map((r) => r.population);
        expect(populations).toEqual([...populations].sort((a, b) => b - a));
    });

    it('tells Portland, OR from Portland, ME', async () => {
        const oregon = await searchCitiesOffline('Portland, OR');
        expect(oregon.map((r) => r.displayName)).toEqual(['Portland, Oregon, United States']);
        expect(oregon[0].timezone).toBe('America/Los_Angeles');
        const maine = await searchCitiesOffline('Portland, ME');
        expect(maine.map((r) => r.displayName)).toEqual(['Portland, Maine, United States']);
        expect(maine[0].timezone).toBe('America/New_York');
    });

    it('offers San Jose, California and San José, Costa Rica', async () => {
        const labels = (await searchCitiesOffline('San Jose', 6)).map((r) => r.displayName);
        expect(labels[0]).toBe('San Jose, California, United States');
        expect(labels).toContain('San José, Costa Rica');
    });

    it('resolves Vadodara to Gujarat, India and Asia/Kolkata', async () => {
        const [top] = await searchCitiesOffline('Vadodara');
        expect(top.displayName).toBe('Vadodara, Gujarat, India');
        expect(top.timezone).toBe('Asia/Kolkata');
    });

    it('a state code filters: "paris tx" is only Paris, Texas', async () => {
        const results = await searchCitiesOffline('paris tx');
        expect(results.map((r) => r.displayName)).toEqual(['Paris, Texas, United States']);
        expect(results[0].timezone).toBe('America/Chicago');
    });
});
