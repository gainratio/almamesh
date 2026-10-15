import { render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it } from 'vitest';

import i18n from '../../i18n/config';
import { Footer } from '../../components/Footer';
import HowWeTest from './HowWeTest';
import { RETRODICTION_RESULTS } from './howWeTestResults';

function renderPage(language: 'en' | 'es' | 'pt' = 'en') {
  void i18n.changeLanguage(language);
  return render(
    <MemoryRouter>
      <HowWeTest />
    </MemoryRouter>,
  );
}

afterEach(() => {
  void i18n.changeLanguage('en');
});

describe('How we test', () => {
  it('leads with the question and the answer in plain words', () => {
    renderPage();
    expect(screen.getByRole('heading', { level: 1, name: 'How we test' })).toBeTruthy();
    expect(document.body.textContent).toContain('better than random months');
    expect(document.body.textContent).toContain('readings are for reflection');
  });

  it('shows the published aggregates: baseline and the four added techniques, each at chance', () => {
    renderPage();
    const rows = within(screen.getByRole('list', { name: 'Lift over chance, by technique' })).getAllByRole('listitem');
    expect(rows.map((row) => row.textContent)).toEqual([
      expect.stringContaining('1.03 (0.90–1.16)'),
      expect.stringContaining('1.03 (0.90–1.18)'),
      expect.stringContaining('0.88 (0.56–1.30)'),
      expect.stringContaining('0.98 (0.85–1.11)'),
      expect.stringContaining('0.99 (0.86–1.12)'),
    ]);
    for (const result of RETRODICTION_RESULTS.techniques) {
      expect(result.low).toBeLessThanOrEqual(1);
      expect(result.high).toBeGreaterThanOrEqual(1);
    }
  });

  it('names the source and its licence, with totals only', () => {
    renderPage();
    const text = document.body.textContent ?? '';
    expect(text).toContain('Astro-Databank');
    expect(text).toContain('under licence');
    expect(text).toContain('6,120');
    expect(text).toContain('5,062');
  });

  it('says how a technique earns stronger wording, and that the test re-runs each release', () => {
    renderPage();
    const text = document.body.textContent ?? '';
    expect(text).toContain('held-out');
    expect(text).toContain('every release');
    expect(text).toContain('One area is being re-tested on held-out data.');
  });

  it.each(['en', 'es', 'pt'] as const)('leaks no record-level data and publishes no lead as a finding (%s)', (language) => {
    renderPage(language);
    const text = document.body.textContent ?? '';
    expect(text).not.toMatch(/\b\d{4}-\d{2}-\d{2}\b/);
    // Coordinates or a birth instant would show as a long decimal or a time of day.
    expect(text).not.toMatch(/\d[.,]\d{4,}|\b\d{1,2}:\d{2}\b/);
    expect(text).not.toMatch(/relocat|reubica|realoca|mudanza|mudança|Rodden/i);
  });

  it('localizes the numbers (es uses a decimal comma)', () => {
    renderPage('es');
    expect(document.body.textContent).toContain('1,03 (0,90–1,16)');
  });
});

describe('the footer links How we test', () => {
  it('in the app footer', () => {
    render(
      <MemoryRouter>
        <Footer />
      </MemoryRouter>,
    );
    expect(screen.getByRole('link', { name: 'How we test' }).getAttribute('href')).toBe('/how-we-test');
  });

  it('in the legal pages footer', () => {
    renderPage();
    const footer = screen.getByRole('contentinfo');
    expect(within(footer).getByRole('link', { name: 'How we test' }).getAttribute('href')).toBe('/how-we-test');
  });
});
