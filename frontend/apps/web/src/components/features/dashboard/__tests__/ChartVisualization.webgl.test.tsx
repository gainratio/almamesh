/** The dashboard chart must survive a browser that cannot draw the 3D force field. */
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

// The 2D panels have their own tests; stand them in so this test isolates the 3D slot.
vi.mock('@almamesh/store', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@almamesh/store')>()),
  buildChartGeometry: () => ({ houses: [] }),
}));
vi.mock('../../astrologer-view', () => ({ PlanetaryTable: () => <table aria-label="planets" /> }));
vi.mock('../../../chart/NorthIndianChartSVG', () => ({ NorthIndianChartSVG: () => <svg role="img" aria-label="kundli" /> }));
vi.mock('../../../chart/SouthIndianChartSVG', () => ({ SouthIndianChartSVG: () => <svg role="img" aria-label="kundli" /> }));

import '../../../../i18n/config';
import { DEMO_CHART } from '../../../../lib/demoChart';
import { ChartVisualization } from '../ChartVisualization';

describe('ChartVisualization without WebGL', () => {
  it('says the 3D view is unavailable and still draws the 2D chart', () => {
    // jsdom has no WebGL: getContext returns null, as on a GPU-less browser.
    render(<ChartVisualization siderealChart={DEMO_CHART} />);
    expect(screen.getByTestId('force-field-unavailable').textContent).toContain("can't draw the 3D view");
    expect(screen.getByTestId('chart-visualization')).toBeTruthy();
    expect(screen.getByRole('img', { name: 'kundli' })).toBeTruthy();
  });
});
