import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { buildVargaGeometry, useChartStore, useLanguageStore } from '@almamesh/store';
import type { SiderealChart } from '@almamesh/browser/types';

import '../../../../i18n/config';
import { DEMO_CHART } from '../../../../lib/demoChart';
import { DashboardKundliCard } from '../DashboardKundliCard';

const CHART_WITH_NAVAMSA: SiderealChart = {
  ...DEMO_CHART,
  navamsa: {
    name: 'D9',
    lagna_sign: 'Scorpio',
    lagna_sign_lord: 'mars',
    planets: {
      sun: { name: 'sun', sign: 'Leo', sign_lord: 'sun', is_combust: false },
      jupiter: { name: 'jupiter', sign: 'Pisces', sign_lord: 'jupiter', is_combust: false },
    },
  },
};

describe('DashboardKundliCard', () => {
  beforeEach(() => {
    useLanguageStore.setState({ language: 'en' });
    useChartStore.setState({ displayStyle: 'south' });
  });

  it('defaults to D1 and switches instantly to D9 Navamsa when stored on the chart', () => {
    const d1Geometry = buildVargaGeometry({
      name: 'D1',
      lagna_sign: 'Gemini',
      lagna_sign_lord: 'mercury',
      planets: {
        sun: { name: 'sun', sign: 'Cancer', sign_lord: 'moon', is_combust: true },
      },
    });
    render(
      <DashboardKundliCard
        siderealChart={CHART_WITH_NAVAMSA}
        d1Geometry={d1Geometry}
        size={300}
        selectedPlanet={null}
        onSelectPlanet={() => {}}
      />,
    );

    expect(screen.getByTestId('dashboard-varga-D1').getAttribute('aria-pressed')).toBe('true');
    expect((screen.getByTestId('dashboard-varga-D9') as HTMLButtonElement).disabled).toBe(false);
    // Without a live worker or cached varga_context_full, D60 is honestly disabled.
    expect((screen.getByTestId('dashboard-varga-D60') as HTMLButtonElement).disabled).toBe(true);

    fireEvent.click(screen.getByTestId('dashboard-varga-D9'));
    expect(screen.getByTestId('dashboard-varga-D9').getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByTestId('south-chart-center-code').textContent).toBe('D9');
    expect(screen.getByTestId('south-chart-center-title').textContent).toBe('Navāṁśa');
  });
});
