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

  it('reports unchanged when the chart identity is the same and the birth time did not move', () => {
    const initial = details();
    const plan = planProfileSave({
      initial,
      current: details({ time_confidence: 'approximate' }),
      storedChartId: storedIdOf(initial),
    });

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

  it('falls back to UTC and the city name when the location omits them', () => {
    const birth = birthMetaFromDetails(
      details({ location: { ...BENGALURU, timezone: '', displayName: '' } }),
    );

    expect(birth.timezone).toBe('UTC');
    expect(birth.location_name).toBe('Bengaluru');
  });
});
