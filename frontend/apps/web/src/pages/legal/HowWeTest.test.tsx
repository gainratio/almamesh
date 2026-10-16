import { readdirSync, readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
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

  it('shows the published aggregates: baseline, the four added techniques, and the classical dasha rules by area, each at chance', () => {
    renderPage();
    const rows = within(screen.getByRole('list', { name: 'Lift over chance, by technique' })).getAllByRole('listitem');
    expect(rows.map((row) => row.textContent)).toEqual([
      expect.stringContaining('1.03 (0.90–1.16)'),
      expect.stringContaining('1.03 (0.90–1.18)'),
      expect.stringContaining('0.88 (0.56–1.30)'),
      expect.stringContaining('0.98 (0.85–1.11)'),
      expect.stringContaining('0.99 (0.86–1.12)'),
      expect.stringContaining('classical dasha rules'),
    ]);
    const sixth = rows[5]?.textContent ?? '';
    for (const line of ['career 1.04 (0.74–1.41)', 'relationships 1.06 (0.85–1.29)', 'family 1.22 (0.87–1.66)', 'health 0.94 (0.49–1.57)']) {
      expect(sixth).toContain(line);
    }
    expect(sixth).toContain('5,098 events across the four areas');
    for (const result of RETRODICTION_RESULTS.techniques) {
      expect(result.low).toBeLessThanOrEqual(1);
      expect(result.high).toBeGreaterThanOrEqual(1);
    }
    for (const area of RETRODICTION_RESULTS.classicalDasha.areas) {
      expect(area.low).toBeLessThanOrEqual(1);
      expect(area.high).toBeGreaterThanOrEqual(1);
    }
  });

  it.each(['en', 'es', 'pt'] as const)('says the classical dasha rules show no lift, with the best corrected p, and publishes aggregates only (%s)', (language) => {
    renderPage(language);
    const text = document.body.textContent ?? '';
    expect(text).toMatch(language === 'es' ? /0,80/ : language === 'pt' ? /0,80/ : /0\.80/);
    expect(text).toMatch(language === 'en' ? /finds no lift from them/ : language === 'es' ? /no encuentra mejora alguna con ellas/ : /não encontra ganho algum com elas/);
    expect(text).not.toMatch(/\bp\s*=\s*0[.,]10\b/);
  });

  it('names the source and its licence, with totals only', () => {
    renderPage();
    const text = document.body.textContent ?? '';
    expect(text).toContain('Astro-Databank');
    expect(text).toContain('under licence');
    expect(text).toContain('6,120');
    expect(text).toContain('5,062');
  });

  // CONTRACT REVERSED (PR #366 review): this used to require "every release".
  // No workflow re-runs the test per release (the licensed data cannot go to
  // CI), so the page must promise only what is done: a re-run whenever the way
  // readings are computed changes.
  it('says how a technique earns stronger wording, and when the test is re-run (truthfully)', () => {
    renderPage();
    const text = document.body.textContent ?? '';
    expect(text).toContain('held-out');
    expect(text).toContain('whenever we change how readings are computed');
    expect(text).not.toMatch(/every release/i);
    expect(text).toContain('One area is being re-tested on held-out data.');
  });

  it.each([
    ['es', /cada versión/i],
    ['pt', /cada versão/i],
  ] as const)('makes no per-release promise in %s either', (language, perRelease) => {
    renderPage(language);
    expect(document.body.textContent ?? '').not.toMatch(perRelease);
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

describe('the How we test sources', () => {
  it('cite only documents that exist in this repository', () => {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const repoRoot = path.resolve(here, '../../../../../..');
    const cited = readdirSync(here)
      .filter((name) => /^(?:HowWeTest|howWeTest)/.test(name) && !name.includes('.test.'))
      .flatMap((name) => [...readFileSync(path.join(here, name), 'utf-8').matchAll(/\bdocs\/[\w./*-]+/g)].map((m) => m[0]));
    for (const ref of cited) {
      expect(ref.includes('*') ? `${ref} (a glob, not a document)` : existsSync(path.join(repoRoot, ref)) ? ref : `${ref} (missing)`).toBe(ref);
    }
  });
});
