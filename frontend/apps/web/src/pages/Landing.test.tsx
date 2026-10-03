import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { useChartLibraryStore, useLanguageStore } from '@almamesh/store';

import '../i18n/config';

// Prewarm hook reads the engine context; stub it so the landing renders without
// a real provider and we can assert the CTA wiring in isolation.
vi.mock('../providers/chartEngineContext', () => ({
  useChartEngine: () => ({ startBootstrap: () => {} }),
  useOptionalChartEngine: () => null,
}));

// The force-field is WebGL (no support in happy-dom) — stub the lazy module so
// the page renders. The hero's OWN test covers the force-field wiring.
vi.mock('../components/forcefield', () => ({
  ForceFieldExperience: () => <div data-testid="forcefield-stub" />,
}));

import { GITHUB_URL } from '../components/features/landing';
import Landing from './Landing';

const setHasChart = (hasChart: boolean) =>
  useChartLibraryStore.setState({
    charts: hasChart
      ? ({ saved: { chart_id: 'saved', person_name: 'Saved', is_primary: true } } as never)
      : {},
  });

function renderLanding(variant: 'home' | 'welcome' = 'welcome') {
  return render(
    <MemoryRouter>
      <Landing variant={variant} />
    </MemoryRouter>,
  );
}

describe('Landing', () => {
  beforeEach(() => {
    useLanguageStore.setState({ language: 'en' });
    setHasChart(false);
  });

  it('renders the hero headline', () => {
    renderLanding();
    expect(
      screen.getByRole('heading', {
        level: 1,
        name: /Your real sky\. Computed on your device\. Free, forever\./i,
      }),
    ).toBeTruthy();
  });

  it('links the primary hero CTA to /onboarding', () => {
    renderLanding();
    const cta = screen.getByTestId('hero-cta');
    expect(cta.getAttribute('href')).toBe('/onboarding');
  });

  it('renders the nav CTA linking to /onboarding', () => {
    renderLanding();
    const navCta = screen.getByTestId('landing-nav-cta');
    expect(navCta.getAttribute('href')).toBe('/onboarding');
  });

  it('surfaces the open-source GitHub link in the nav on all breakpoints', () => {
    renderLanding();
    const gh = screen.getByTestId('landing-nav-github');
    expect(gh.getAttribute('href')).toBe(GITHUB_URL);
    // Regression guard: the old treatment hid it below the `sm` breakpoint.
    expect(gh.className).not.toContain('hidden');
  });

  it('routes the primary CTAs to /dashboard for a returning visitor with a saved chart', () => {
    setHasChart(true);
    renderLanding();
    expect(screen.getByTestId('hero-cta').getAttribute('href')).toBe('/dashboard');
    expect(screen.getByTestId('landing-nav-cta').getAttribute('href')).toBe('/dashboard');
    expect(screen.getByTestId('final-cta').getAttribute('href')).toBe('/dashboard');
  });

  it('renders a footer with a link to the privacy policy', () => {
    renderLanding();
    const footer = screen.getByRole('contentinfo');
    const privacy = within(footer).getByRole('link', { name: /Privacy Policy/i });
    expect(privacy.getAttribute('href')).toBe('/privacy');
  });

  it('renders every content section in spec order under <main>', () => {
    renderLanding();
    const main = screen.getByRole('main');
    const headings = within(main)
      .getAllByRole('heading', { level: 2 })
      .map((h) => h.textContent);
    expect(headings).toEqual([
      'What it computes',
      'What you can do',
      "Why we're different",
      'How it works',
      "Who it's for",
      'Where & when',
      'Why I built this',
      'The engine you can trust',
      'Generate your chart — free, private, yours.',
    ]);
  });

  it('keeps the home variant focused on the brand hero instead of duplicating the explainer', () => {
    renderLanding('home');
    const main = screen.getByRole('main');
    expect(within(main).getAllByRole('heading', { level: 1 })).toHaveLength(1);
    expect(within(main).queryAllByRole('heading', { level: 2 })).toHaveLength(0);
  });
});
