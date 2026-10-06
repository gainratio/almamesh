import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { useChartLibraryStore, useLanguageStore } from '@almamesh/store';

import '../../../i18n/config';

vi.mock('../../../providers/chartEngineContext', () => ({
  useChartEngine: () => ({ startBootstrap: () => {} }),
  useOptionalChartEngine: () => null,
}));

import { GITHUB_URL } from './LandingFooter';
import { LandingNav } from './LandingNav';

const setHasChart = (hasChart: boolean) =>
  useChartLibraryStore.setState({
    charts: hasChart
      ? ({ saved: { chart_id: 'saved', person_name: 'Saved', is_primary: true } } as never)
      : {},
  });

function renderNav() {
  return render(
    <MemoryRouter>
      <LandingNav />
    </MemoryRouter>,
  );
}

describe('LandingNav', () => {
  beforeEach(() => {
    useLanguageStore.setState({ language: 'en' });
    setHasChart(false);
  });

  describe('open-source GitHub link (goodwill signal)', () => {
    it('points at the canonical repository', () => {
      renderNav();
      expect(screen.getByTestId('landing-nav-github').getAttribute('href')).toBe(GITHUB_URL);
    });

    it('is visible on ALL breakpoints (not hidden below sm)', () => {
      renderNav();
      // Regression guard against the old `hidden ... sm:inline-flex` treatment.
      const link = screen.getByTestId('landing-nav-github');
      expect(link.className).not.toContain('hidden');
    });

    it('renders a real inline octocat SVG (no external icon CDN)', () => {
      renderNav();
      expect(screen.getByTestId('landing-nav-github').querySelector('svg')).toBeTruthy();
    });
  });

  describe('phone language control', () => {
    it('keeps the accessible name and mirrors the chosen language as a code', () => {
      useLanguageStore.setState({ language: 'pt' });
      renderNav();
      const select = screen.getByRole('combobox', { name: 'Language' }) as HTMLSelectElement;
      expect(select.value).toBe('pt');
      const code = screen.getByTestId('landing-language-code');
      expect(code.textContent).toBe('pt');
      expect(code.getAttribute('aria-hidden')).toBe('true');
    });
  });

  describe('wordmark', () => {
    it('is named AlmaMesh for assistive tech at every width', () => {
      renderNav();
      expect(screen.getByRole('link', { name: 'AlmaMesh' })).toBeTruthy();
    });
  });

  describe('adaptive CTA', () => {
    it('routes a first-time visitor to /onboarding with the generate label', () => {
      renderNav();
      const cta = screen.getByTestId('landing-nav-cta');
      expect(cta.getAttribute('href')).toBe('/onboarding');
      expect(cta.textContent).toContain('Generate my chart');
    });

    it('routes a returning visitor straight to /dashboard with the returning label', () => {
      setHasChart(true);
      renderNav();
      const cta = screen.getByTestId('landing-nav-cta');
      expect(cta.getAttribute('href')).toBe('/dashboard');
      expect(cta.textContent).toContain('Open my chart');
    });
  });
});
