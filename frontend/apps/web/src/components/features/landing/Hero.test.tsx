import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { useChartLibraryStore, useLanguageStore } from '@almamesh/store';

import '../../../i18n/config';

vi.mock('../../../providers/chartEngineContext', () => ({
  useChartEngine: () => ({ startBootstrap: () => {} }),
  useOptionalChartEngine: () => null,
}));

// happy-dom has no WebGL; stub the lazy force-field scene.
vi.mock('../../forcefield', () => ({
  ForceFieldExperience: () => <div data-testid="forcefield-stub" />,
}));

import { GITHUB_URL } from './LandingFooter';
import { Hero } from './Hero';

const setHasChart = (hasChart: boolean) =>
  useChartLibraryStore.setState({
    charts: hasChart
      ? ({ saved: { chart_id: 'saved', person_name: 'Saved', is_primary: true } } as never)
      : {},
  });

function renderHero() {
  return render(
    <MemoryRouter>
      <Hero />
    </MemoryRouter>,
  );
}

describe('Hero', () => {
  beforeEach(() => {
    useLanguageStore.setState({ language: 'en' });
    setHasChart(false);
  });

  it('renders the approved headline', () => {
    renderHero();
    expect(
      screen.getByRole('heading', {
        level: 1,
        name: 'Your real sky. Computed on your device. Free, forever.',
      }),
    ).toBeTruthy();
  });

  it('renders the microcopy', () => {
    renderHero();
    expect(screen.getByText(/Works offline · 3 languages · open engine\./i)).toBeTruthy();
  });

  describe('first-time visitor (no local chart)', () => {
    it('routes the CTA to /onboarding', () => {
      renderHero();
      expect(screen.getByTestId('hero-cta').getAttribute('href')).toBe('/onboarding');
    });

    it('labels the CTA "Generate my chart — free"', () => {
      renderHero();
      expect(screen.getByTestId('hero-cta').textContent).toContain('Generate my chart — free');
    });

    // A person moving to a new phone must be able to restore BEFORE making a chart.
    it('offers "Restore from a backup" next to the CTA', async () => {
      renderHero();
      expect(
        await screen.findByRole('button', { name: 'Restore from a backup' }, { timeout: 5_000 }),
      ).toBeTruthy();
    });
  });

  describe('returning visitor (a chart already exists locally)', () => {
    beforeEach(() => {
      setHasChart(true);
    });

    it('routes the CTA straight to /dashboard', () => {
      renderHero();
      expect(screen.getByTestId('hero-cta').getAttribute('href')).toBe('/dashboard');
    });

    it('labels the CTA "Open my chart"', () => {
      renderHero();
      expect(screen.getByTestId('hero-cta').textContent).toContain('Open my chart');
    });

    it('does not offer a first-run restore (Settings → Data owns restore once data exists)', () => {
      renderHero();
      expect(screen.queryByTestId('first-run-restore')).toBeNull();
    });
  });

  it('surfaces a prominent "free & open source" GitHub badge pointing at the repo', () => {
    renderHero();
    const badge = screen.getByTestId('hero-github-badge');
    expect(badge.getAttribute('href')).toBe(GITHUB_URL);
    expect(badge.textContent).toContain('Free & open source on GitHub');
    // A real inline octocat SVG — no external icon CDN (project zero-egress rule).
    expect(badge.querySelector('svg')).toBeTruthy();
  });
});
