import '../../../../i18n/config';
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { YogaData } from '@almamesh/browser/types';
import { DashboardYogasCard } from '../DashboardYogasCard';

const RAJA_YOGA: YogaData = {
  name: 'Raja Yoga',
  display_name: 'Raja Yoga (Sun–Venus)',
  category: 'raja',
  description: 'A kendra lord and a trikona lord in sambandha.',
  effects: 'Authority and purpose.',
  grade: 'moderate',
  strength_factors: [],
  net_marks: 0,
  max_favorable: 3,
  max_unfavorable: 3,
  strength_pct: 50,
  strength_tier: 'structural',
  planets_involved: ['sun', 'venus'],
  houses_involved: [9],
  planetary_signature: 'sun_venus_h9',
  formation_rules: [
    {
      rule: 'raja.kendra_trikona_conjunction',
      description: 'Sun (kendra lord) and Venus (trikona lord) in conjunction',
      source: 'BPHS, Raja-yoga adhyaya',
      planets: ['sun', 'venus'],
      houses: [9],
    },
  ],
  dasha_activation: {
    status: 'direct',
    direct_lords: [{ level: 'antar', lord: 'venus' }],
    dispositor_chains: [],
    aspect_links: [],
    mitigating_factors: [],
  },
};

describe('DashboardYogasCard', () => {
  it('renders plain-language yoga primer, meaning, strength badge, activation status, and classical source', () => {
    render(<DashboardYogasCard yogas={[RAJA_YOGA]} />);
    expect(screen.getByTestId('dashboard-yogas-card')).toBeTruthy();
    expect(screen.getByTestId('dashboard-yogas-primer').textContent).toContain(
      'named geometric pattern of planets and houses',
    );
    expect(screen.getByText('Raja Yoga (Sun–Venus)')).toBeTruthy();
    expect(screen.getByText('50% · moderate')).toBeTruthy();
    expect(screen.getByText('Active (direct)')).toBeTruthy();
    expect(screen.getByTestId('dashboard-yoga-meaning').textContent).toContain(
      'Links an angular house of action and structure',
    );
    const basis = screen.getByTestId('dashboard-yoga-basis');
    expect(basis.textContent).toContain('Sun (kendra lord) and Venus (trikona lord) in conjunction');
    expect(basis.querySelector('cite')?.textContent).toBe('BPHS, Raja-yoga adhyaya');
  });

  it('renders an honest empty message when no yogas formed', () => {
    render(<DashboardYogasCard yogas={[]} />);
    expect(screen.getByText(/No classical yogas from this catalog formed/)).toBeTruthy();
    expect(screen.queryByTestId('dashboard-yogas-primer')).toBeNull();
  });
});
