/**
 * ReportCover — the near-cusp callout must be ACTIONABLE, not just alarming.
 *
 * The callout tells the reader "we recommend refining the birth time in AlmaMesh
 * before relying on house placements" — and for a while there was no way to do
 * that from the report: no link, anywhere, to `/rectify/:profileId`. A recommended
 * action with no route to it is a broken feature, however correct the prose is.
 * The dashboard has had the link (`IdentityStrip`) all along; this pins the same
 * affordance onto the report.
 *
 * All data here is SYNTHETIC — never real birth data.
 */
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { LagnaData } from '@almamesh/browser/types';
import type { ProcessedBirthData } from '@almamesh/shared-types';

import '../../../../i18n/config';
import { ReportCover } from '../ReportCover';

const BIRTH = {
  birth_datetime_utc: '1990-03-30T06:30:00Z',
  birth_datetime_local: '1990-03-30T12:00:00',
  birth_location_details: {
    city: 'Bengaluru',
    state: 'Karnataka',
    country: 'India',
    latitude: 12.97,
    longitude: 77.59,
    timezone: 'Asia/Kolkata',
  },
} as unknown as ProcessedBirthData;

/** ~1.2° from the Taurus cusp — the callout renders. */
const LAGNA_CUSP = {
  sign: 'aries',
  sign_degrees: 28.8,
  lagna_cusp_distance_deg: 1.2,
  lagna_adjacent_sign: 'Taurus',
  is_near_cusp: true,
} as unknown as LagnaData;

/** Mid-sign — no callout at all. */
const LAGNA_CLEAR = {
  sign: 'aries',
  sign_degrees: 15,
  lagna_cusp_distance_deg: 15,
  lagna_adjacent_sign: null,
  is_near_cusp: false,
} as unknown as LagnaData;

function renderCover(lagna: LagnaData, profileId?: string | null) {
  return render(
    <MemoryRouter>
      <ReportCover
        personName="Synthetic Native"
        audience="you"
        birth={BIRTH}
        lagna={lagna}
        profileId={profileId}
        asOf="2025-01-01T12:00:00.000Z"
      />
    </MemoryRouter>,
  );
}

describe('ReportCover — the near-cusp callout is reachable', () => {
  it('links to the rectification flow for this profile when the lagna is near a cusp', () => {
    renderCover(LAGNA_CUSP, 'chart-1');
    const link = screen.getByTestId('report-cusp-resolve-link');
    expect(link.getAttribute('href')).toBe('/rectify/chart-1');
    expect(link.textContent).toContain('Resolve with life events');
  });

  it('renders no callout — and so no link — when the lagna is clear of a cusp', () => {
    renderCover(LAGNA_CLEAR, 'chart-1');
    expect(screen.queryByTestId('report-cusp-note')).toBeNull();
    expect(screen.queryByTestId('report-cusp-resolve-link')).toBeNull();
  });

  it('still renders the callout, minus the link, when no profile is active', () => {
    renderCover(LAGNA_CUSP, null);
    expect(screen.getByTestId('report-cusp-note')).toBeTruthy();
    expect(screen.queryByTestId('report-cusp-resolve-link')).toBeNull();
  });
});
