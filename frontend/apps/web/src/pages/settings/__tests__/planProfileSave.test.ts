import { describe, expect, it } from 'vitest';
import { chartId } from '@almamesh/store';

import type { BirthDetails } from '../birthDetailsFromBirthData';
import { birthMetaFromDetails, planProfileSave } from '../planProfileSave';

const BENGALURU = {
  displayName: 'Bengaluru, Karnataka, India',
  city: 'Bengaluru',
  state: 'Karnataka',
  country: 'India',
  lat: 12.9716,
  lon: 77.5946,
  timezone: 'Asia/Kolkata',
};

function details(overrides: Partial<BirthDetails> = {}): BirthDetails {
  return {
    name: 'Reference Native',
    birth_date: '1988-08-08',
    birth_time: '06:44',
    location: BENGALURU,
    rectified_time: '',
    time_confidence: 'exact',
    ...overrides,
  };
}

/** The id the stored chart carries: what regeneration compares against. */
function storedIdOf(saved: BirthDetails): string {
  return chartId(birthMetaFromDetails(saved));
}

describe('planProfileSave', () => {
  it('regenerates at the new birth time when no rectification exists', () => {
    const initial = details();
    const plan = planProfileSave({
      initial,
      current: details({ birth_time: '06:14' }),
      storedChartId: storedIdOf(initial),
    });

    expect(plan.kind).toBe('regenerate');
    if (plan.kind !== 'regenerate') return;
    expect(plan.birth.time).toBe('06:14');
    expect(plan.birth.rectifiedTime).toBeUndefined();
    expect(chartId(plan.birth)).not.toBe(storedIdOf(initial));
  });

  it('reports that the rectified time still governs when only the birth time changed', () => {
    const initial = details({ rectified_time: '06:59' });
    const plan = planProfileSave({
      initial,
      current: details({ birth_time: '07:30', rectified_time: '06:59' }),
      storedChartId: storedIdOf(initial),
    });

    expect(plan).toEqual({ kind: 'rectification-governs', rectifiedTime: '06:59' });
  });

  it('regenerates when the rectification is cleared along with the birth-time edit', () => {
    const initial = details({ rectified_time: '06:59' });
    const plan = planProfileSave({
      initial,
      current: details({ birth_time: '07:30', rectified_time: '' }),
      storedChartId: storedIdOf(initial),
    });

    expect(plan.kind).toBe('regenerate');
    if (plan.kind !== 'regenerate') return;
    expect(plan.birth.time).toBe('07:30');
    expect(plan.birth.rectifiedTime).toBeUndefined();
  });

  it('regenerates when the rectified time itself changes', () => {
    const initial = details();
    const plan = planProfileSave({
      initial,
      current: details({ rectified_time: '06:59' }),
      storedChartId: storedIdOf(initial),
    });

    expect(plan.kind).toBe('regenerate');
    if (plan.kind !== 'regenerate') return;
    expect(plan.birth.rectifiedTime).toBe('06:59');
  });

  it('treats a rectified time equal to the birth time as no rectification', () => {
    const plan = planProfileSave({
      initial: details(),
      current: details({ birth_time: '06:14', rectified_time: '06:14' }),
      storedChartId: storedIdOf(details()),
    });

    expect(plan.kind).toBe('regenerate');
    if (plan.kind !== 'regenerate') return;
    expect(plan.birth.rectifiedTime).toBeUndefined();
  });

  // CONTRACT REVERSED (2026-10-05, #246 grade). This test used to assert that a
  // confidence-only edit is `unchanged`: the page said "Nothing to save" and the
  // edit was silently dropped. Confidence does not define the chart, so it is
  // saved WITHOUT a regeneration.
  it('saves a confidence-only edit without regenerating', () => {
    const initial = details();
    const plan = planProfileSave({
      initial,
      current: details({ time_confidence: 'approximate' }),
      storedChartId: storedIdOf(initial),
    });

    expect(plan).toEqual({ kind: 'confidence-only', timeConfidence: 'approximate' });
  });

  it('reports unchanged when nothing at all changed', () => {
    const initial = details();
    const plan = planProfileSave({ initial, current: details(), storedChartId: storedIdOf(initial) });

    expect(plan).toEqual({ kind: 'unchanged' });
  });

  it('regenerates when there is no stored chart to compare against', () => {
    const plan = planProfileSave({ initial: details(), current: details(), storedChartId: null });

    expect(plan.kind).toBe('regenerate');
  });
});

describe('birthMetaFromDetails', () => {
  it('refuses to build engine input without a birth location', () => {
    expect(() => birthMetaFromDetails(details({ location: null }))).toThrow(
      'a birth location is required',
    );
  });

  // CONTRACT REVERSED (time-handling increment). This test used to assert
  // `birth.timezone === 'UTC'` when the location had no zone: the defect as the
  // requirement. A chart regenerated "in UTC" for a Bengaluru birth is wrong by
  // 5h30m. A missing zone is now refused (see the next describe); the city-name
  // fallback, which is harmless display copy, is still pinned here.
  it('falls back to the city name when the location omits a display name', () => {
    const birth = birthMetaFromDetails(details({ location: { ...BENGALURU, displayName: '' } }));

    expect(birth.location_name).toBe('Bengaluru');
  });

  it('no longer falls back to UTC when the location omits its timezone', () => {
    expect(() =>
      birthMetaFromDetails(details({ location: { ...BENGALURU, timezone: '', displayName: '' } })),
    ).toThrow(/timezone is missing/);
  });
});

describe('birthMetaFromDetails — no silent UTC, explicit DST choice', () => {
  it('refuses a location with no timezone instead of computing the chart in UTC', () => {
    const noZone = { ...BENGALURU, timezone: '' };
    expect(() => birthMetaFromDetails(details({ location: noZone }))).toThrow(
      /timezone is missing/,
    );
  });

  it('carries the chosen occurrence of a repeated DST hour to the engine input', () => {
    const la = { ...BENGALURU, lat: 34.05, lon: -118.24, timezone: 'America/Los_Angeles' };
    const meta = birthMetaFromDetails(
      details({ location: la, birth_date: '2024-11-03', birth_time: '01:30', dst_fold: 'later' }),
    );
    expect(meta.dstFold).toBe('later');
  });
});
