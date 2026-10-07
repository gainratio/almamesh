/**
 * The provenance line states how THIS chart was computed: the engine, data and
 * conventions recorded in its snapshot, as of its own analysis instant. It used
 * to print the live engine's metadata and today's date under every chart, so an
 * old chart claimed a version (and a date) it was never computed with.
 */
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import type { ChartSnapshot } from '@almamesh/shared-types';
import golden from '../../../../../../backend/tests/fixtures/chart_golden_de421.json';
import { ProvenanceFooter } from '../ProvenanceFooter';

// If the footer still read the running engine, it would print this.
vi.mock('../../providers/AlmaMeshRuntimeProvider', () => ({
  useChartEngine: () => ({
    meta: { engine_version: '9.9.9', ayanamsa: 'raman', ephemeris_file: 'de440.bsp' },
  }),
}));

const stamp = (golden as unknown as Record<string, { snapshot: ChartSnapshot }>)[
  '1990-01-15T12:00:00+00:00'
]!.snapshot;

function line(): string {
  return screen.getByTestId('provenance-footer').textContent ?? '';
}

describe('ProvenanceFooter', () => {
  it('names the engine, ayanamsa and ephemeris the chart was COMPUTED with', () => {
    render(
      <ProvenanceFooter
        calculations={{ snapshot: { ...stamp, engine_version: '0.0.7' }, calculation_timestamp: stamp.reference_date }}
      />,
    );

    expect(line()).toContain('Engine 0.0.7');
    expect(line()).toContain('Ayanamsa Lahiri');
    expect(line()).toContain('Ephemeris de421');
    expect(line()).not.toContain('9.9.9');
  });

  it("dates the line with the chart's analysis instant, not today", () => {
    vi.useFakeTimers({ now: new Date('2031-06-15T12:00:00Z'), toFake: ['Date'] });
    try {
      // Midday UTC, so the calendar date is the same in every test timezone.
      const midday = { ...stamp, reference_date: '2025-01-01T12:00:00+00:00' };
      render(<ProvenanceFooter calculations={{ snapshot: midday, calculation_timestamp: midday.reference_date }} />);

      expect(line()).toContain('As of Jan 1, 2025');
      expect(line()).not.toContain('2031');
    } finally {
      vi.useRealTimers();
    }
  });

  it('shows the snapshot id so two screens can be matched to one computation', () => {
    render(<ProvenanceFooter calculations={{ snapshot: stamp, calculation_timestamp: stamp.reference_date }} />);

    expect(line()).toContain(`Snapshot ${stamp.snapshot_id.slice(0, 12)}`);
  });

  it('says plainly when a chart predates snapshots, instead of borrowing the live engine', () => {
    render(<ProvenanceFooter calculations={{ calculation_timestamp: '2024-03-02T12:00:00.000Z' }} />);

    expect(line()).toContain('engine version not recorded');
    expect(line()).toContain('As of Mar 2, 2024');
    expect(line()).not.toContain('9.9.9');
  });

  it('renders nothing without a chart', () => {
    const { container } = render(<ProvenanceFooter calculations={null} />);

    expect(container.innerHTML).toBe('');
  });

  it('falls back to the legacy line when a restored snapshot is malformed, instead of crashing', () => {
    render(
      <ProvenanceFooter
        calculations={{
          snapshot: { engine_version: 7 } as unknown as ChartSnapshot,
          calculation_timestamp: '2025-01-01T00:00:00.000Z',
        }}
      />,
    );

    expect(line()).toContain('engine version not recorded');
  });
});
