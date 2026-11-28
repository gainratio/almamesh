/**
 * PeriodsPanel — the Vimśottarī explorer: 9 mahā rows → antar drill-down →
 * pratyantars of the running antar. Everything renders verbatim from the
 * engine sequences (founder example fixtures); the running path is highlighted
 * and OPEN by default ("you are here" at a glance); older payloads without
 * depth degrade to an honest note, never a crash.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, within, fireEvent } from '@testing-library/react';
import { useLanguageStore } from '@almamesh/store';

import i18n from '../../../../i18n/config';
import { useContentModeStore } from '../../../../stores/contentMode';
import { PeriodsPanel } from '../PeriodsPanel';
import { FOUNDER_DASHAS, FOUNDER_DASHAS_NO_DEPTH } from '../../../../test/dashaFixtures';

describe('PeriodsPanel', () => {
  beforeEach(async () => {
    useLanguageStore.setState({ language: 'en' });
    useContentModeStore.setState({ contentMode: 'layman' });
    // In the app a provider hook syncs the store into i18next; tests do it directly.
    await i18n.changeLanguage('en');
  });

  it('renders all nine mahā rows with lord, locale-formatted dates and duration', () => {
    render(<PeriodsPanel dashas={FOUNDER_DASHAS} />);
    const tree = screen.getByTestId('dasha-tree');
    for (const lord of ['sun', 'moon', 'mars', 'rahu', 'jupiter', 'saturn', 'mercury', 'ketu', 'venus']) {
      expect(screen.getByTestId(`dasha-tree-maha-${lord}`)).toBeTruthy();
    }
    const saturn = screen.getByTestId('dasha-tree-maha-saturn');
    expect(saturn.textContent).toContain('Saturn');
    expect(saturn.textContent).toContain('01/09/2017'); // locale date, never raw ISO
    expect(saturn.textContent).toContain('01/31/2036');
    expect(saturn.textContent).toContain('19 y');
    expect(tree.textContent).not.toContain('2017-01-09');
  });

  it('marks the running mahā (aria-current) and opens it by default onto its antars', () => {
    render(<PeriodsPanel dashas={FOUNDER_DASHAS} />);
    const saturn = screen.getByTestId('dasha-tree-maha-saturn');
    expect(saturn.getAttribute('aria-current')).toBe('true');
    // The running mahā's disclosure starts expanded; a non-running one starts collapsed.
    expect(within(saturn).getAllByRole('button', { expanded: true }).length).toBeGreaterThan(0);
    const jupiter = screen.getByTestId('dasha-tree-maha-jupiter');
    expect(within(jupiter).getByRole('button', { expanded: false })).toBeTruthy();
    // Founder antars are in the (open) running mahā: Venus 12/01/2023 → 01/31/2027.
    const antars = screen.getByTestId('dasha-tree-antars-saturn');
    expect(within(antars).getByTestId('dasha-tree-antar-saturn-venus').textContent).toContain('12/01/2023');
    expect(within(antars).getByTestId('dasha-tree-antar-saturn-sun').textContent).toContain('01/31/2027');
  });

  it('highlights the running antar and reveals its nine pratyantars (running PD marked)', () => {
    render(<PeriodsPanel dashas={FOUNDER_DASHAS} />);
    const venusAntar = screen.getByTestId('dasha-tree-antar-saturn-venus');
    expect(venusAntar.getAttribute('aria-current')).toBe('true');
    const pds = screen.getByTestId('dasha-tree-pds');
    const pdLords = within(pds)
      .getAllByTestId(/dasha-tree-pd-/)
      .map((el) => el.getAttribute('data-testid'));
    expect(pdLords).toHaveLength(9);
    const saturnPd = screen.getByTestId('dasha-tree-pd-saturn');
    expect(saturnPd.getAttribute('aria-current')).toBe('true');
    expect(saturnPd.textContent).toContain('06/13/2026'); // founder: running PD ends Jun 13, 2026
    expect(screen.getByTestId('dasha-tree-pd-mercury').textContent).toContain('11/24/2026');
    expect(screen.getByTestId('dasha-tree-pd-ketu').textContent).toContain('01/31/2027');
  });

  it('expands a non-running mahā on click to show its antars', () => {
    render(<PeriodsPanel dashas={FOUNDER_DASHAS} />);
    const jupiter = screen.getByTestId('dasha-tree-maha-jupiter');
    const trigger = within(jupiter).getByRole('button', { expanded: false });
    fireEvent.click(trigger);
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByTestId('dasha-tree-antars-jupiter')).toBeTruthy();
  });

  it('shows the "you are here" path with the running stack and the next boundary date', () => {
    render(<PeriodsPanel dashas={FOUNDER_DASHAS} />);
    const path = screen.getByTestId('dasha-tree-path');
    expect(path.textContent).toContain('Saturn'); // mahā + pratyantar lords
    expect(path.textContent).toContain('Venus'); // antar lord
    expect(path.textContent).toContain('06/13/2026'); // the innermost (PD) boundary
  });

  it('states the daśā-year convention exactly once at the top', () => {
    render(<PeriodsPanel dashas={FOUNDER_DASHAS} />);
    const note = screen.getByTestId('periods-convention');
    expect(note.textContent).toContain('Gregorian year (365.2425 days)');
    expect(screen.getAllByText(/Gregorian year/)).toHaveLength(1);
  });

  it('degrades honestly when the stored payload has no sub-period depth', () => {
    render(<PeriodsPanel dashas={FOUNDER_DASHAS_NO_DEPTH} />);
    // All nine mahā rows still render…
    expect(screen.getByTestId('dasha-tree-maha-saturn').textContent).toContain('Saturn');
    // …but nothing is expandable, and an honest note explains why.
    expect(screen.queryAllByRole('button', { expanded: false })).toHaveLength(0);
    expect(screen.getByTestId('periods-no-depth')).toBeTruthy();
  });

  it('renders an honest unavailable state when there is no dasha payload at all', () => {
    render(<PeriodsPanel dashas={undefined} />);
    expect(screen.getByTestId('periods-unavailable')).toBeTruthy();
    expect(screen.queryByTestId('dasha-tree')).toBeNull();
  });

  it('renders fully localized in Spanish (catalog parity is behavioral, not just structural)', async () => {
    useLanguageStore.setState({ language: 'es' });
    await i18n.changeLanguage('es');
    render(<PeriodsPanel dashas={FOUNDER_DASHAS} />);
    expect(screen.getByTestId('periods-panel').textContent).toContain('Períodos Vimśottarī');
    expect(screen.getByTestId('dasha-tree-path').textContent).toContain('Estás aquí');
    expect(screen.getByTestId('periods-convention').textContent).toContain('Año gregoriano');
    // Localized graha name + es date order (DD/MM/YYYY).
    expect(screen.getByTestId('dasha-tree-maha-saturn').textContent).toContain('Saturno');
    expect(screen.getByTestId('dasha-tree-pd-mercury').textContent).toContain('13/06/2026');
  });

  it('surfaces sub-period meaning and bullet points in both For You and For Astrologer modes', () => {
    const planets = {
      venus: { house: 10, sign: 'pisces', houses_ruled: [3, 8], dignity: 'exalted', is_yogakaraka: true },
    };
    const { rerender } = render(<PeriodsPanel dashas={FOUNDER_DASHAS} planets={planets} />);
    const currentGuide = screen.getByTestId('periods-current-subperiod-guide');
    expect(currentGuide.textContent).toContain('12/01/2023');
    expect(currentGuide.textContent).toContain('01/31/2027');
    expect(currentGuide.textContent).toContain('career direction, public work, and reputation');
    expect(currentGuide.textContent).not.toContain('House 10');

    // Non-running antars and every pratyantar carry their own guide block without duplicating the running antar.
    expect(screen.queryByTestId('subperiod-guide-antar-saturn-venus')).toBeNull();
    expect(screen.getByTestId('subperiod-guide-antar-saturn-sun')).toBeTruthy();
    expect(screen.getByTestId('subperiod-guide-pd-saturn')).toBeTruthy();

    // Switching global contentMode to technical updates the guide to astrologer precision immediately.
    useContentModeStore.setState({ contentMode: 'technical' });
    rerender(<PeriodsPanel dashas={FOUNDER_DASHAS} planets={planets} />);
    expect(screen.getByTestId('periods-current-subperiod-guide').textContent).toContain('House 10 (Pisces)');
  });
});
