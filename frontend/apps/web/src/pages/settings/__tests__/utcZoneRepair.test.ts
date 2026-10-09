import { describe, expect, it } from 'vitest';

import { suggestBirthplaceZone } from '../utcZoneRepair';

const at = (lat: number, lon: number) => ({ lat, lon, timezone: 'UTC' });

describe('suggestBirthplaceZone — charts saved with the old "|| \'UTC\'" fallback', () => {
  it('flags a Bengaluru birth stored as UTC and suggests Asia/Kolkata', () => {
    expect(suggestBirthplaceZone(at(12.9716, 77.5946), '1988-08-08', '06:44')).toBe('Asia/Kolkata');
  });

  it('flags a London SUMMER birth (BST is UTC+1 at the birth instant)', () => {
    expect(suggestBirthplaceZone(at(51.5074, -0.1278), '1990-07-01', '12:00')).toBe('Europe/London');
  });

  it.each([
    ['Reykjavik', 64.1466, -21.9426, '1990-07-01'],
    ['Accra', 5.6037, -0.187, '1990-07-01'],
    ['London in winter (GMT = UTC at the birth instant)', 51.5074, -0.1278, '1990-01-15'],
  ])('does not flag %s, which really was at UTC then', (_label, lat, lon, date) => {
    expect(suggestBirthplaceZone(at(lat, lon), date, '12:00')).toBeNull();
  });

  it('does not flag a chart whose zone is not UTC', () => {
    expect(
      suggestBirthplaceZone({ lat: 12.97, lon: 77.59, timezone: 'Asia/Kolkata' }, '1988-08-08', '06:44'),
    ).toBeNull();
  });

  it('does not flag when the date or time is unreadable', () => {
    expect(suggestBirthplaceZone(at(12.97, 77.59), '', '06:44')).toBeNull();
  });
});
