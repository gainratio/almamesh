import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { useLanguageStore, useProfilesStore } from '@almamesh/store';
import type { VimshottariDashaData } from '@almamesh/shared-types';

import '../../../../i18n/config';
import { IdentityStrip } from '../IdentityStrip';
import { FOUNDER_DASHA_CTX } from '../../../../test/dashaFixtures';

const DASHA: VimshottariDashaData = {
  maha_dasha: {
    lord: 'saturn',
    start_date: '2010-03-01T00:00:00Z',
    end_date: '2029-03-01T00:00:00Z',
    level: 'maha',
    duration_years: 19,
  },
  antar_dasha: {
    lord: 'mercury',
    start_date: '2025-01-01T00:00:00Z',
    end_date: '2027-09-01T00:00:00Z',
    level: 'antar',
    duration_years: 2.7,
  },
  pratyantar_dasha: {
    lord: 'venus',
    start_date: '2026-05-01T00:00:00Z',
    end_date: '2026-10-01T00:00:00Z',
    level: 'pratyantar',
    duration_years: 0.4,
  },
  full_sequence: [],
  convention: 'gregorian_365_2425',
};

function renderStrip(
  overrides: Partial<Parameters<typeof IdentityStrip>[0]> = {},
): ReturnType<typeof render> {
  return render(
    <MemoryRouter>
      <IdentityStrip
        name="Asha Rao"
        lagna={{ sign: 'Aquarius', longitude: 328.84, nakshatra: 'Purva_Bhadrapada', nakshatraPada: 3 }}
        moon={{ sign: 'Cancer', nakshatra: 'Pushya', nakshatraPada: 1 }}
        dasha={DASHA}
        {...overrides}
      />
    </MemoryRouter>,
  );
}

describe('IdentityStrip', () => {
  beforeEach(() => {
    useLanguageStore.setState({ language: 'en' });
  });

  it('labels the running dasha with the chip it is given, and only then', () => {
    const { unmount } = renderStrip();
    expect(screen.queryByTestId('dashboard-today-label-dasha')).toBeNull();
    unmount();
    renderStrip({ dashaLabel: 'Today' });
    const chip = screen.getByTestId('dashboard-today-label-dasha');
    expect(chip.textContent).toBe('Today');
    // It sits with the running dasha, not elsewhere in the strip.
    expect(chip.closest('div')?.querySelector('dt')?.textContent).toContain('Running');
  });

  it('renders the person name as the page heading', () => {
    renderStrip();
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Asha Rao');
  });

  it('shows the Lagna sign with in-sign degrees and nakshatra', () => {
    renderStrip();
    const strip = screen.getByTestId('identity-strip');
    expect(strip.textContent).toContain('Aquarius');
    expect(strip.textContent).toContain('28°'); // 328.84 % 30 = 28.84
    expect(strip.textContent).toContain('Purva Bhadrapada');
  });

  it('elevates a near-cusp lagna into the Birth-time sensitivity callout (product feature)', () => {
    renderStrip();
    // 328.84 → 28.84° in sign → ~1.2° from the Pisces cusp.
    const callout = screen.getByTestId('birth-time-sensitivity');
    expect(callout.textContent).toContain('Birth-time sensitivity');
    // States the computed rising sign and the engine-measured distance…
    expect(callout.textContent).toMatch(/Aquarius rises only ~1\.2° from the Pisces cusp/);
    // …names the ALTERNATIVE rising sign explicitly, qualitatively ("a few
    // minutes" — never a fake-precise minutes number), and says the stakes:
    expect(callout.textContent).toMatch(
      /A few minutes' difference in your recorded birth time would make it Pisces/,
    );
    expect(callout.textContent).toMatch(/every house in this chart would shift/);
    // …and carries the rectification link.
    const refine = screen.getByRole('link', { name: /refine your birth time/i });
    expect(refine.getAttribute('href')).toBe('/settings/profile');
  });

  it('names the correct alternative sign at a lower boundary too (generic, any sign)', () => {
    // 120.8 → 0.8° within Leo → the Cancer cusp; proves it is not chart-specific.
    renderStrip({ lagna: { sign: 'Leo', longitude: 120.8 } });
    const callout = screen.getByTestId('birth-time-sensitivity');
    expect(callout.textContent).toMatch(/Leo rises only ~0\.8° from the Cancer cusp/);
    expect(callout.textContent).toMatch(/would make it Cancer/);
  });

  it('renders NO sensitivity callout when the lagna sits mid-sign', () => {
    renderStrip({ lagna: { sign: 'Aquarius', longitude: 315.0, nakshatra: 'Shatabhisha' } });
    expect(screen.queryByTestId('birth-time-sensitivity')).toBeNull();
    expect(screen.queryByRole('link', { name: /refine your birth time/i })).toBeNull();
  });

  it('shows the Moon sign and nakshatra', () => {
    renderStrip();
    const strip = screen.getByTestId('identity-strip');
    expect(strip.textContent).toContain('Cancer');
    expect(strip.textContent).toContain('Pushya');
  });

  it('shows the full running daśā stack with level labels and convention', () => {
    renderStrip();
    const strip = screen.getByTestId('identity-strip');
    expect(strip.textContent).toContain('Saturn');
    expect(strip.textContent).toContain('Maha');
    expect(strip.textContent).toContain('Mercury');
    expect(strip.textContent).toContain('Antar');
    expect(strip.textContent).toContain('Venus');
    expect(strip.textContent).toContain('Pratyantar');
    expect(strip.textContent).toContain('Gregorian year (365.2425 days)');
    expect(strip.textContent).toContain('2029');
  });

  it('derives the engine-dated "now + next" line by pure list lookup (founder example)', () => {
    renderStrip({ dasha: FOUNDER_DASHA_CTX });
    const next = screen.getByTestId('identity-next-periods');
    // Running Saturn PD ends 2026-06-13 → next PD is Mercury from that date…
    expect(next.textContent).toContain('Next:');
    expect(next.textContent).toContain('Mercury Pratyantar from 06/13/2026');
    // …and the running Venus antar ends 2027-01-31 → next antar is Sun.
    expect(next.textContent).toContain('Sun Antar from 01/31/2027');
    // No raw ISO leaks.
    expect(next.textContent).not.toContain('2026-06-13');
    // And it links straight to the Periods explorer.
    const link = screen.getByRole('link', { name: 'All periods' });
    expect(link.getAttribute('href')).toBe('/predictive?tab=periods');
  });

  it('omits the next line entirely on older payloads without sequences (no crash)', () => {
    renderStrip(); // legacy DASHA fixture: empty full_sequence, no pratyantar_sequence
    expect(screen.queryByTestId('identity-next-periods')).toBeNull();
    expect(screen.queryByRole('link', { name: 'All periods' })).toBeNull();
  });

  it('renders honest placeholders when chart facts are unavailable', () => {
    renderStrip({ lagna: null, moon: null, dasha: undefined });
    const strip = screen.getByTestId('identity-strip');
    expect(strip.textContent).toContain('Not available');
  });

  it('renders the actions slot', () => {
    renderStrip({ actions: <button type="button">Mode</button> });
    expect(screen.getByRole('button', { name: 'Mode' })).toBeTruthy();
  });

  it('keeps wrapped mobile actions inside the viewport with touch-sized controls', () => {
    renderStrip({
      actions: (
        <>
          <button type="button">Regenerate reading</button>
          <a href="/settings">Settings</a>
          <div role="tablist" aria-label="Content mode">
            <button type="button" role="tab" aria-selected="true">
              For You
            </button>
          </div>
        </>
      ),
    });

    const actions = screen.getByRole('button', { name: 'Regenerate reading' }).parentElement;
    if (!actions) throw new Error('Regenerate reading must belong to the actions row');
    const classes = actions.className.split(' ');
    expect(classes).toEqual(
      expect.arrayContaining([
        'w-full',
        'min-w-0',
        '[&>button]:min-h-11',
        '[&>button]:min-w-11',
        '[&>a]:min-h-11',
        '[&>a]:min-w-11',
        '[&_[role=tab]]:min-h-11',
      ]),
    );
  });
});

describe('IdentityStrip — refine-birth-time invitation (confidence-gated)', () => {
  // A mid-sign lagna (15° into Aquarius) so BirthTimeSensitivity renders null —
  // isolating the standalone refine invitation from the near-cusp callout.
  const MID_SIGN = { sign: 'Aquarius', longitude: 315.0, nakshatra: 'Shatabhisha' } as const;

  beforeEach(() => {
    useLanguageStore.setState({ language: 'en' });
    useProfilesStore.setState({ activeProfileId: 'p1' });
  });

  afterEach(() => {
    useProfilesStore.setState({ activeProfileId: null });
  });

  it('shows the optional refine invitation when the birth time is uncertain', () => {
    renderStrip({ lagna: MID_SIGN, timeConfidence: 'rough' });
    const link = screen.getByRole('link', { name: /refine your birth time/i });
    expect(link.getAttribute('href')).toBe('/rectify/p1');
  });

  it('shows the invitation for unknown/legacy charts (no confidence recorded)', () => {
    renderStrip({ lagna: MID_SIGN }); // timeConfidence undefined
    expect(screen.getByRole('link', { name: /refine your birth time/i })).toBeTruthy();
  });

  it('hides the invitation when the birth time is recorded as exact (no nagging)', () => {
    renderStrip({ lagna: MID_SIGN, timeConfidence: 'exact' });
    expect(screen.queryByRole('link', { name: /refine your birth time/i })).toBeNull();
  });
});

describe('IdentityStrip — engine-authoritative cusp signal', () => {
  beforeEach(() => {
    useLanguageStore.setState({ language: 'en' });
  });

  it('fires the callout off the ENGINE near-cusp signal even when the TS degree is mid-sign', () => {
    // longitude 315 -> 15° into Aquarius, which the local 3° rule would treat as
    // safely mid-sign (no callout). The engine's own cusp block, however, reports
    // a 0.4° distance to Pisces and is_near_cusp = true. The strip must defer to
    // the engine and render the callout verbatim — proving the engine, not the
    // local TS recompute, is the source of truth.
    renderStrip({
      lagna: {
        sign: 'Aquarius',
        longitude: 315,
        cuspDistanceDeg: 0.4,
        adjacentSign: 'Pisces',
        isNearCusp: true,
      },
    });
    const callout = screen.getByTestId('birth-time-sensitivity');
    expect(callout.textContent).toMatch(/Aquarius rises only ~0\.4° from the Pisces cusp/);
    expect(callout.textContent).toMatch(/would make it Pisces/);
    expect(callout.textContent).toMatch(/every house in this chart would shift/);
  });

  it('suppresses the callout when the engine says NOT near-cusp, even if the TS degree is within 3°', () => {
    // longitude 328.84 -> 28.84° -> 1.16° from the Pisces boundary by the local
    // rule (which alone would fire). The engine (authoritative) reports this is
    // NOT a near-cusp chart, so the strip stays silent.
    renderStrip({
      lagna: {
        sign: 'Aquarius',
        longitude: 328.84,
        cuspDistanceDeg: 6.0,
        adjacentSign: 'Pisces',
        isNearCusp: false,
      },
    });
    expect(screen.queryByTestId('birth-time-sensitivity')).toBeNull();
  });
});
