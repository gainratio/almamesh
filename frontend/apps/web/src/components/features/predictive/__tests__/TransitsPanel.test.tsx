import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import i18next from 'i18next';
import { useLanguageStore } from '@almamesh/store';
import type { TransitCtx } from '@almamesh/shared-types';

import '../../../../i18n/config';
import { TransitsPanel } from '../TransitsPanel';
import { TRANSIT_CTX } from '../../../../test/predictiveFixtures';

describe('TransitsPanel', () => {
  beforeEach(async () => {
    useLanguageStore.setState({ language: 'en' });
    await i18next.changeLanguage('en');
  });

  // Sade Sati inactive, so its "none" line renders too.
  const QUIET_SATURN: TransitCtx = { ...TRANSIT_CTX, sade_sati: { ...TRANSIT_CTX.sade_sati, is_active: false } };

  it('by default reads as now: "Current Sky", "today\'s sky", "currently"', () => {
    render(<TransitsPanel transitCtx={QUIET_SATURN} />);
    const text = screen.getByTestId('transits-panel').textContent ?? '';
    expect(text).toContain('Current Sky (Gochara)');
    expect(text).toContain("today's sky");
    expect(text).toContain('currently');
  });

  it('framed as another moment, no line reads as now and the table stays', () => {
    render(<TransitsPanel transitCtx={QUIET_SATURN} frame="moment" />);
    const text = screen.getByTestId('transits-panel').textContent ?? '';
    expect(text).not.toContain('Current Sky');
    expect(text).not.toMatch(/today/i);
    expect(text).not.toMatch(/current/i);
    expect(text).toContain('Saturn is not inside the three-sign Sade Sati corridor');
    expect(screen.getByTestId('gochara-table')).toBeTruthy();
    expect(screen.getByTestId('fusion-card')).toBeTruthy();
  });

  it.each([
    ['es', /actualmente|hoy/],
    ['pt', /atualmente|hoje/],
  ] as const)('framed as another moment, %s has no "now" words either', async (language, now) => {
    useLanguageStore.setState({ language });
    await i18next.changeLanguage(language);
    render(<TransitsPanel transitCtx={QUIET_SATURN} frame="moment" />);
    expect(screen.getByTestId('transits-panel').textContent ?? '').not.toMatch(now);
    await i18next.changeLanguage('en');
  });

  it('renders the gochara table with localized graha/sign names and houses', () => {
    render(<TransitsPanel transitCtx={TRANSIT_CTX} />);
    const table = screen.getByTestId('gochara-table');
    expect(within(table).getByText('Saturn')).toBeTruthy();
    expect(within(table).getByText('Pisces')).toBeTruthy();
    expect(within(table).getByText('Jupiter')).toBeTruthy();
    // Houses from Moon / Lagna rendered verbatim.
    expect(within(table).getByText('House 3')).toBeTruthy();
    // Retrograde motion labelled.
    expect(within(table).getByText('Retrograde')).toBeTruthy();
  });

  it.each([
    ['en', 'House 1'],
    ['es', 'Casa 1'],
    ['pt', 'Casa 1'],
  ] as const)(
    'keeps Saturn in house 1 from the accepted Pisces Lagna in %s',
    async (language, houseLabel) => {
      useLanguageStore.setState({ language });
      await i18next.changeLanguage(language);
      const { unmount } = render(<TransitsPanel transitCtx={TRANSIT_CTX} />);

      const table = screen.getByTestId('gochara-table');
      const saturnRow = within(table)
        .getByText(language === 'en' ? 'Saturn' : 'Saturno')
        .closest('tr');
      expect(saturnRow).not.toBeNull();
      expect(within(saturnRow as HTMLElement).getByText(houseLabel)).toBeTruthy();
      unmount();
    },
  );

  it('shows the Sade Sati phase, activity badge and dated cycle', () => {
    render(<TransitsPanel transitCtx={TRANSIT_CTX} />);
    expect(screen.getByTestId('sade-sati-active').textContent).toBe('Active');
    expect(screen.getByTestId('sade-sati-phase').textContent).toContain('Peak');
    const cycle = screen.getByTestId('sade-sati-cycle');
    expect(within(cycle).getAllByText(/Saturn in/)).toHaveLength(3);
    // Locale-aware dates (en → "Jan 17, 2023" style), never raw ISO.
    expect(cycle.textContent).toContain('2023');
    expect(cycle.textContent).not.toContain('2023-01-17T');
  });

  it('lists slow hits with their natal points and exact dates', () => {
    render(<TransitsPanel transitCtx={TRANSIT_CTX} />);
    const card = screen.getByTestId('slow-hits-card');
    expect(within(card).getByText(/Saturn → natal Saturn/)).toBeTruthy();
    expect(within(card).getByText(/Jupiter → natal Moon/)).toBeTruthy();
  });

  it('renders the fusion read with reinforcing/afflicting lists and severity', () => {
    render(<TransitsPanel transitCtx={TRANSIT_CTX} />);
    const card = screen.getByTestId('fusion-card');
    expect(within(card).getByText('Saturn')).toBeTruthy();
    expect(within(card).getByText('Mercury')).toBeTruthy();
    expect(within(card).getByText('Jupiter')).toBeTruthy(); // reinforcing
    expect(within(card).getByText('Mars')).toBeTruthy(); // afflicting
    expect(within(card).getByText('-0.5')).toBeTruthy(); // net weight verbatim
  });

  it('renders the 12-month timeline chronologically with human event copy', () => {
    render(<TransitsPanel transitCtx={TRANSIT_CTX} />);
    const timeline = screen.getByTestId('transit-timeline');
    expect(within(timeline).getByText('Jupiter enters Cancer')).toBeTruthy();
    expect(within(timeline).getByText(/Mercury → Ketu/)).toBeTruthy();
  });

  it('renders Rahu and Ketu changing sign at the same instant as two rows, without a key warning', () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const base = { ...TRANSIT_CTX.timeline.events[0], kind: 'sign_ingress', from_lord: null, to_lord: null } as const;
    const ctx: TransitCtx = {
      ...TRANSIT_CTX,
      timeline: {
        ...TRANSIT_CTX.timeline,
        events: [
          { ...base, date: '2026-12-03', graha: 'rahu', from_sign: 'aquarius', to_sign: 'capricorn', descriptor: 'rahu.ingress.capricorn' },
          { ...base, date: '2026-12-03', graha: 'ketu', from_sign: 'leo', to_sign: 'cancer', descriptor: 'ketu.ingress.cancer' },
        ],
      },
    };
    try {
      render(<TransitsPanel transitCtx={ctx} />);
      expect(screen.getByText('Rahu enters Capricorn')).toBeTruthy();
      expect(screen.getByText('Ketu enters Cancer')).toBeTruthy();
      expect(errors).not.toHaveBeenCalled();
    } finally {
      errors.mockRestore();
    }
  });

  it('hides the severity badge on a neutral row and keeps it on the others', () => {
    const [ingress, dasha] = TRANSIT_CTX.timeline.events;
    const ctx: TransitCtx = {
      ...TRANSIT_CTX,
      timeline: {
        ...TRANSIT_CTX.timeline,
        events: [
          { ...ingress!, severity: 'supportive' },
          { ...dasha!, severity: 'neutral' },
          { ...ingress!, date: '2027-03-01', descriptor: 'jupiter.ingress.leo', to_sign: 'leo', severity: 'challenging' },
        ],
      },
    };
    render(<TransitsPanel transitCtx={ctx} />);
    const rows = within(screen.getByTestId('transit-timeline')).getAllByRole('listitem');
    expect(rows).toHaveLength(3);
    expect(within(rows[0]!).getByText('Supportive')).toBeTruthy();
    expect(within(rows[1]!).queryByText('Neutral')).toBeNull();
    expect(within(rows[2]!).getByText('Challenging')).toBeTruthy();
  });

  describe('in a timezone west of UTC (America/Los_Angeles)', () => {
    const originalTz = process.env.TZ;
    beforeEach(() => {
      process.env.TZ = 'America/Los_Angeles';
    });
    afterEach(() => {
      process.env.TZ = originalTz;
    });

    it('formats the UTC-midnight window bounds as their UTC calendar day', () => {
      // Prove the pin applied: UTC midnight is the previous evening in Los Angeles.
      expect(new Date('2026-10-09T00:00:00Z').getDate()).toBe(8);
      const ctx: TransitCtx = {
        ...TRANSIT_CTX,
        timeline: {
          ...TRANSIT_CTX.timeline,
          window_start: '2026-10-09T00:00:00Z',
          window_end: '2027-10-09T00:00:00Z',
        },
      };
      render(<TransitsPanel transitCtx={ctx} />);
      const card = screen.getByTestId('transit-timeline');
      expect(card.textContent).toContain('Oct 09, 2026 – Oct 09, 2027');
      expect(card.textContent).not.toContain('Oct 08');
    });
  });
});
