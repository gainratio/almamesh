/**
 * LocationSearch — coordinate fallback contract.
 *
 * Some birthplaces (small towns/villages under the bundled dataset's
 * population cutoff) are genuinely absent from the offline city list, so a
 * user can't select them. The fallback lets them enter latitude/longitude
 * directly (with an optional place label) and MUST emit the exact same
 * `LocationResult` shape the city picker emits, so the engine path still
 * receives a valid lat/lon + IANA timezone. This fallback path is fully
 * offline: the timezone is resolved on-device via `timezoneForCoordinates`
 * (tz-lookup), never a network geocoder. (City typeahead is online-primary —
 * covered by the geo-layer tests, not here; these tests never type a city.)
 *
 * These tests pin: the fallback toggle reveals the coordinate inputs; a
 * valid entry emits the correct location object (timezone derived from the
 * coordinates); out-of-range values are rejected (no emission, submit
 * disabled, inline validation); and the optional place label flows through
 * to both `displayName` and `city`.
 */
// i18n must be initialized before any component that calls useTranslation
import '../../i18n/config';
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { LocationSearch, type LocationResult } from './LocationSearch';
import { timezoneForCoordinates } from '../../lib/geo/cityLookup';
import { __setDerivedDbStorageForTest } from '../../lib/derivedDb';

function renderSearch(onChange: (l: LocationResult | null) => void) {
  return render(<LocationSearch value={null} onChange={onChange} />);
}

async function openFallback(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByTestId('coordinate-fallback-toggle'));
}

describe('LocationSearch — coordinate fallback', () => {
  it('hides the coordinate inputs until the fallback toggle is clicked', async () => {
    const user = userEvent.setup();
    renderSearch(vi.fn());

    // The toggle is discoverable, but the inputs are not yet mounted.
    expect(screen.getByTestId('coordinate-fallback-toggle')).toBeTruthy();
    expect(screen.queryByTestId('coordinate-lat-input')).toBeNull();
    expect(screen.queryByTestId('coordinate-lon-input')).toBeNull();

    await openFallback(user);

    expect(screen.getByTestId('coordinate-lat-input')).toBeTruthy();
    expect(screen.getByTestId('coordinate-lon-input')).toBeTruthy();
    expect(screen.getByTestId('coordinate-label-input')).toBeTruthy();
  });

  it('emits the picker-shaped location with an on-device timezone on valid entry', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    renderSearch(onChange);
    await openFallback(user);

    // Bengaluru-ish coordinates (a place small villages nearby lack an entry for).
    await user.type(screen.getByTestId('coordinate-lat-input'), '12.9716');
    await user.type(screen.getByTestId('coordinate-lon-input'), '77.5946');

    const submit = screen.getByTestId('coordinate-submit');
    expect(submit.hasAttribute('disabled')).toBe(false);
    await user.click(submit);

    expect(onChange).toHaveBeenCalledTimes(1);
    const emitted = onChange.mock.calls[0][0] as LocationResult;
    expect(emitted.lat).toBeCloseTo(12.9716, 4);
    expect(emitted.lon).toBeCloseTo(77.5946, 4);
    // Timezone resolved from the coordinates, offline — identical to the city path.
    expect(emitted.timezone).toBe(timezoneForCoordinates(12.9716, 77.5946));
    expect(emitted.timezone).toBeTruthy();
    // No label => displayName/city fall back to a formatted coordinate string.
    expect(emitted.displayName).toContain('12.97');
    expect(emitted.city).toBe(emitted.displayName);
    expect(emitted.state).toBe('');
    expect(emitted.country).toBe('');
  });

  it('flows the optional place label through to displayName and city', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    renderSearch(onChange);
    await openFallback(user);

    await user.type(screen.getByTestId('coordinate-lat-input'), '12.9716');
    await user.type(screen.getByTestId('coordinate-lon-input'), '77.5946');
    await user.type(screen.getByTestId('coordinate-label-input'), 'My Village');

    await user.click(screen.getByTestId('coordinate-submit'));

    const emitted = onChange.mock.calls[0][0] as LocationResult;
    expect(emitted.displayName).toBe('My Village');
    expect(emitted.city).toBe('My Village');
    expect(emitted.lat).toBeCloseTo(12.9716, 4);
    expect(emitted.timezone).toBeTruthy();
  });

  it('rejects out-of-range coordinates: submit disabled, inline error, no emission', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    renderSearch(onChange);
    await openFallback(user);

    // Latitude 95 is out of the −90..90 range; longitude 200 out of −180..180.
    await user.type(screen.getByTestId('coordinate-lat-input'), '95');
    await user.type(screen.getByTestId('coordinate-lon-input'), '200');

    const submit = screen.getByTestId('coordinate-submit');
    expect(submit.hasAttribute('disabled')).toBe(true);
    expect(screen.getByTestId('coordinate-error')).toBeTruthy();

    // Even a forced click must not emit an invalid location.
    await user.click(submit);
    expect(onChange).not.toHaveBeenCalled();
  });

  it('keeps submit disabled until both coordinates are present', async () => {
    const user = userEvent.setup();
    renderSearch(vi.fn());
    await openFallback(user);

    const submit = screen.getByTestId('coordinate-submit');
    expect(submit.hasAttribute('disabled')).toBe(true);

    await user.type(screen.getByTestId('coordinate-lat-input'), '12.97');
    // Longitude still empty — cannot submit yet.
    expect(submit.hasAttribute('disabled')).toBe(true);

    await user.type(screen.getByTestId('coordinate-lon-input'), '77.59');
    expect(submit.hasAttribute('disabled')).toBe(false);
  });
});

describe('LocationSearch — refused on-device storage', () => {
  it('says plainly when the offline city list only lives in memory for this visit', () => {
    __setDerivedDbStorageForTest('memory');
    try {
      renderSearch(vi.fn());
      expect(screen.getByTestId('city-lookup-memory-notice').textContent).toMatch(/memory/i);
    } finally {
      __setDerivedDbStorageForTest('unknown');
    }
  });

  it('shows no storage notice while the city list is on device', () => {
    __setDerivedDbStorageForTest('opfs');
    try {
      renderSearch(vi.fn());
      expect(screen.queryByTestId('city-lookup-memory-notice')).toBeNull();
    } finally {
      __setDerivedDbStorageForTest('unknown');
    }
  });
});
