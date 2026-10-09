/**
 * SynchronySection — the "Together in time" dates. The engine dates every
 * synchrony window bound and segment cut as a UTC instant (the window is
 * pinned to UTC midnight). West of Greenwich, a local-time render shows the
 * previous calendar day; these tests pin a negative-offset zone and require
 * the UTC calendar day the engine meant.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { useLanguageStore } from '@almamesh/store';

import '../../../../i18n/config';
import { SynchronySection } from '../SynchronySection';
import { MESH_EDGE_SPOUSE } from '../../../../test/meshFixtures';

function renderSection(): void {
  render(
    <SynchronySection
      edge={MESH_EDGE_SPOUSE}
      memberName="Dev"
      years={2}
      onYearsChange={() => undefined}
    />,
  );
}

describe('SynchronySection in a timezone west of UTC (America/Los_Angeles)', () => {
  const originalTz = process.env.TZ;
  beforeEach(() => {
    process.env.TZ = 'America/Los_Angeles';
    useLanguageStore.setState({ language: 'en' });
  });
  afterEach(() => {
    process.env.TZ = originalTz;
  });

  it('shows the window bounds as their UTC calendar day', () => {
    // Prove the pin applied: UTC midnight is the previous evening in Los Angeles.
    expect(new Date('2026-06-11T00:00:00Z').getDate()).toBe(10);
    renderSection();
    const card = screen.getByTestId('mesh-synchrony');
    expect(card.textContent).toContain('Jun 11, 2026 → Jun 11, 2028');
    expect(card.textContent).not.toContain('Jun 10');
  });

  it('shows each segment cut as its UTC calendar day', () => {
    renderSection();
    const rows = screen.getAllByTestId('mesh-synchrony-segment');
    expect(within(rows[0]!).getByText('Jun 11, 2026 → Jan 08, 2027')).toBeTruthy();
    expect(within(rows[1]!).getByText('Jan 08, 2027 → Jun 11, 2028')).toBeTruthy();
  });
});
