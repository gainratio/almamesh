import { afterEach, describe, it, expect, beforeEach, vi } from 'vitest';
import { useLanguageStore, type StoredChart } from '@almamesh/store';
import type { ProcessedBirthData } from '@almamesh/shared-types';
import {
  buildEnsurePredictiveInput,
  formatPredictiveDate,
  formatPredictiveWindowBound,
  formatReferenceDay,
  predictiveReferenceInstant,
  selectPrimaryStoredChart,
  titleCaseToken,
  toVargaChart,
} from '../predictive';
import { VARGA_CTX_FULL } from '../../test/predictiveFixtures';

const BIRTH: ProcessedBirthData = {
  birth_datetime_utc: '1990-01-15T12:00:00+00:00',
  birth_datetime_local: '1990-01-15T07:00:00',
  birth_location_details: {
    city: 'New York',
    latitude: 40.7128,
    longitude: -74.006,
    timezone: 'America/New_York',
  },
};

describe('predictiveReferenceInstant', () => {
  it('pins to UTC midnight of the given day', () => {
    expect(predictiveReferenceInstant(new Date('2026-06-09T18:45:12Z'))).toBe(
      '2026-06-09T00:00:00Z',
    );
  });

  it('uses the chart-local calendar day when a timezone is supplied', () => {
    const now = new Date('2026-06-09T20:00:00Z');
    expect(predictiveReferenceInstant(now, 'Asia/Kolkata')).toBe('2026-06-10T00:00:00Z');
    expect(predictiveReferenceInstant(now, 'America/Los_Angeles')).toBe(
      '2026-06-09T00:00:00Z',
    );
  });
});

describe('buildEnsurePredictiveInput', () => {
  it('builds the full lazy-compute input from stored birth data', () => {
    const input = buildEnsurePredictiveInput('profile-1', BIRTH, '2026-06-09T00:00:00Z');
    expect(input).toEqual({
      profileKey: 'profile-1',
      datetimeUtc: '1990-01-15T12:00:00+00:00',
      latitude: 40.7128,
      longitude: -74.006,
      referenceInstant: '2026-06-09T00:00:00Z',
      // EST at the birth instant: the engine reads the Vedic weekday off it.
      utcOffsetMinutes: -300,
    });
  });

  it('sends the birthplace civil offset at the birth instant (date-line zone, DST)', () => {
    const apia: ProcessedBirthData = {
      birth_datetime_utc: '2024-01-09T21:00:00.000Z',
      birth_datetime_local: '2024-01-10T10:00:00',
      birth_location_details: { city: 'Apia', latitude: -13.83, longitude: -171.77, timezone: 'Pacific/Apia' },
    };
    expect(buildEnsurePredictiveInput('p', apia, '2026-06-09T00:00:00Z')?.utcOffsetMinutes).toBe(780);
    const laSummer: ProcessedBirthData = {
      ...BIRTH,
      birth_datetime_utc: '2024-07-01T19:00:00.000Z',
      birth_location_details: { ...BIRTH.birth_location_details, timezone: 'America/Los_Angeles' },
    };
    expect(buildEnsurePredictiveInput('p', laSummer, '2026-06-09T00:00:00Z')?.utcOffsetMinutes).toBe(-420);
  });

  it('returns null for an unknown birthplace zone instead of throwing', () => {
    const bogus: ProcessedBirthData = {
      ...BIRTH,
      birth_location_details: { ...BIRTH.birth_location_details, timezone: 'Mars/Olympus' },
    };
    expect(buildEnsurePredictiveInput('p', bogus, '2026-06-09T00:00:00Z')).toBeNull();
  });

  it('returns null when the birthplace timezone is missing (no UTC guess)', () => {
    const noZone: ProcessedBirthData = {
      ...BIRTH,
      birth_location_details: { ...BIRTH.birth_location_details, timezone: '' },
    };
    expect(buildEnsurePredictiveInput('p', noZone, '2026-06-09T00:00:00Z')).toBeNull();
  });

  it('returns null when birth data is missing (no silent guesses)', () => {
    expect(buildEnsurePredictiveInput('p', undefined, '2026-06-09T00:00:00Z')).toBeNull();
  });
});

describe('selectPrimaryStoredChart', () => {
  it('selects the primary chart inside the active profile, not another profile', () => {
    const charts = {
      'other-primary': {
        chart_id: 'other-primary',
        profile_id: 'profile-2',
        is_primary: true,
      },
      'active-primary': {
        chart_id: 'active-primary',
        profile_id: 'profile-1',
        is_primary: true,
      },
    } as unknown as Readonly<Record<string, StoredChart>>;

    expect(selectPrimaryStoredChart(charts, 'profile-1')?.chart_id).toBe('active-primary');
  });
});

describe('toVargaChart', () => {
  it('Title-Cases the adapter lowercase signs for the geometry builder', () => {
    const d9 = VARGA_CTX_FULL.charts.D9;
    expect(d9).toBeDefined();
    const chart = toVargaChart(d9!);
    expect(chart.name).toBe('D9');
    expect(chart.lagna_sign).toBe('Scorpio');
    expect(chart.planets.saturn).toEqual({
      name: 'saturn',
      sign: 'Aquarius',
      sign_lord: 'saturn',
      // The engine's D1 combustion flag carries through to the geometry builder.
      is_combust: true,
    });
  });

  it('carries the engine combustion flag so the varga dims combust grahas', () => {
    const d9 = VARGA_CTX_FULL.charts.D9;
    const chart = toVargaChart(d9!);
    // Saturn is combust in the fixture; Jupiter is not.
    expect(chart.planets.saturn?.is_combust).toBe(true);
    expect(chart.planets.jupiter?.is_combust).toBe(false);
  });
});

describe('formatPredictiveDate', () => {
  beforeEach(() => {
    useLanguageStore.setState({ language: 'en' });
  });

  it('renders a date-only ISO as that calendar date (never rolled via UTC)', () => {
    expect(formatPredictiveDate('2026-10-26')).toContain('2026');
    expect(formatPredictiveDate('2026-10-26')).toContain('26');
  });

  it('renders a full instant without throwing', () => {
    expect(formatPredictiveDate('2026-09-12T04:00:00Z')).toContain('2026');
  });
});

describe('formatPredictiveWindowBound', () => {
  beforeEach(() => {
    useLanguageStore.setState({ language: 'en' });
  });

  it('renders a UTC-midnight bound as its UTC calendar day', () => {
    expect(formatPredictiveWindowBound('2026-10-09T00:00:00Z')).toBe('Oct 09, 2026');
  });

  it('keeps the date-only and unparseable paths of formatPredictiveDate', () => {
    expect(formatPredictiveWindowBound('2026-10-26')).toBe(formatPredictiveDate('2026-10-26'));
    expect(formatPredictiveWindowBound('2026-10-26T99:99:99Z')).toBe(formatPredictiveDate('2026-10-26T99:99:99Z'));
  });
});

describe('titleCaseToken', () => {
  it('capitalizes a lowercase engine token', () => {
    expect(titleCaseToken('saturn')).toBe('Saturn');
    expect(titleCaseToken('')).toBe('');
  });
});

describe('formatReferenceDay', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it.each(['America/Los_Angeles', 'UTC', 'Asia/Kolkata', 'Pacific/Auckland'])(
    'prints the calendar day a UTC-midnight reference names, for a viewer in %s',
    (zone) => {
      vi.stubEnv('TZ', zone);
      expect(formatReferenceDay('2026-10-07T00:00:00Z')).toBe('Oct 7, 2026');
    },
  );
});
